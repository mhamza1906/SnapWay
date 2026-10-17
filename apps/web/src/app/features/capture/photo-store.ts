import { InjectionToken } from '@angular/core';
import type { PhotoMetadata, PointBody, SessionBody } from './capture.models';

export type UploadState = 'captured-locally' | 'upload-pending' | 'uploaded' | 'failed';

/** One saved photo and everything needed to upload it later, even after a reload. */
export interface QueuedPhoto {
  /** Client UUID; reused on every retry so the PUT stays idempotent. */
  id: string;
  sessionId: string;
  pointId: string;
  metadata: PhotoMetadata;
  /** Session and point bodies PUT to Django before the photo (idempotent). */
  session: SessionBody;
  point: PointBody;
  state: UploadState;
  attempts: number;
  error: string;
  /** Failed transiently (network, 5xx): retried automatically with backoff. */
  autoRetry: boolean;
  nextAttemptAt: number;
  size: number;
  createdAt: string;
}

/** Blob + metadata storage for the upload queue. */
export interface PhotoStore {
  readonly kind: 'indexeddb' | 'memory';
  list(): Promise<QueuedPhoto[]>;
  /** Saves the record; `blob` is kept until `dropBlob`. */
  put(record: QueuedPhoto, blob?: Blob): Promise<void>;
  blob(id: string): Promise<Blob | null>;
  dropBlob(id: string): Promise<void>;
  /** Removes the record and its blob. */
  remove(id: string): Promise<void>;
}

export class MemoryPhotoStore implements PhotoStore {
  readonly kind = 'memory' as const;
  private readonly records = new Map<string, QueuedPhoto>();
  private readonly blobs = new Map<string, Blob>();
  async list() {
    return [...this.records.values()].map((r) => ({ ...r }));
  }
  async put(record: QueuedPhoto, blob?: Blob) {
    this.records.set(record.id, { ...record });
    if (blob) this.blobs.set(record.id, blob);
  }
  async blob(id: string) {
    return this.blobs.get(id) ?? null;
  }
  async dropBlob(id: string) {
    this.blobs.delete(id);
  }
  async remove(id: string) {
    this.records.delete(id);
    this.blobs.delete(id);
  }
}

const DB_NAME = 'snapway-capture';
const RECORDS = 'photos';
const BLOBS = 'blobs';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbPhotoStore implements PhotoStore {
  readonly kind = 'indexeddb' as const;
  constructor(private readonly db: IDBDatabase) {}

  static open(factory: IDBFactory = indexedDB): Promise<IdbPhotoStore> {
    return new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(RECORDS))
          db.createObjectStore(RECORDS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      };
      req.onsuccess = () => resolve(new IdbPhotoStore(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('The photo database is blocked by another tab.'));
    });
  }
  async list() {
    const tx = this.db.transaction(RECORDS, 'readonly');
    return request(tx.objectStore(RECORDS).getAll() as IDBRequest<QueuedPhoto[]>);
  }
  put(record: QueuedPhoto, blob?: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(blob ? [RECORDS, BLOBS] : [RECORDS], 'readwrite');
      tx.objectStore(RECORDS).put(record);
      if (blob) tx.objectStore(BLOBS).put(blob, record.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('The photo could not be stored.'));
    });
  }
  async blob(id: string) {
    const tx = this.db.transaction(BLOBS, 'readonly');
    return ((await request(tx.objectStore(BLOBS).get(id))) as Blob | undefined) ?? null;
  }
  async dropBlob(id: string) {
    const tx = this.db.transaction(BLOBS, 'readwrite');
    await request(tx.objectStore(BLOBS).delete(id));
  }
  remove(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([RECORDS, BLOBS], 'readwrite');
      tx.objectStore(RECORDS).delete(id);
      tx.objectStore(BLOBS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/** Opens IndexedDB, or explains why photos will only be kept in memory. */
export async function openPhotoStore(): Promise<{ store: PhotoStore; warning: string }> {
  const memoryWarning =
    'Photos cannot be stored on this phone (private browsing or blocked storage), so they are only kept in memory. Keep this page open until every upload finishes.';
  if (typeof indexedDB === 'undefined')
    return { store: new MemoryPhotoStore(), warning: memoryWarning };
  try {
    return { store: await IdbPhotoStore.open(), warning: '' };
  } catch {
    return { store: new MemoryPhotoStore(), warning: memoryWarning };
  }
}

/** Overridable in tests. */
export const PHOTO_STORE = new InjectionToken<
  () => Promise<{ store: PhotoStore; warning: string }>
>('PHOTO_STORE', { providedIn: 'root', factory: () => openPhotoStore });

/** True for storage-full errors from IndexedDB. */
export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
