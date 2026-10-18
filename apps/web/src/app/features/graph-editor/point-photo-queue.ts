import { Injectable, signal } from '@angular/core';
import type { PhotoDirection } from '../../core/graph-api.service';

export interface PendingPointPhoto {
  id: string;
  owner: string;
  revisionId: string;
  nodeId: string;
  direction: PhotoDirection;
  blob: Blob;
  filename: string;
}

/** Pending files stay on this phone until the server confirms the R2 upload. */
@Injectable({ providedIn: 'root' })
export class PointPhotoQueue {
  prepare(file: File): Promise<File> {
    return preparePointPhoto(file);
  }
  readonly items = signal<PendingPointPhoto[]>([]);
  readonly persistent = signal(false);
  private db: IDBDatabase | null = null;
  private owner = '';

  async open(owner: string): Promise<void> {
    this.owner = owner;
    this.items.set([]);
    try {
      if (!this.db)
        this.db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('snapway-point-photos', 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore('pending', { keyPath: 'id' });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Phone storage is busy in another tab.'));
        });
      const db = this.db;
      const all = await new Promise<PendingPointPhoto[]>((resolve, reject) => {
        const request = db.transaction('pending').objectStore('pending').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      this.items.set(all.filter((item) => item.owner === owner));
      this.persistent.set(true);
    } catch {
      this.db = null;
      this.persistent.set(false);
    }
  }

  async save(photo: Omit<PendingPointPhoto, 'id' | 'owner'>): Promise<PendingPointPhoto> {
    const item = {
      ...photo,
      owner: this.owner,
      id: `${this.owner}:${photo.revisionId}:${photo.nodeId}:${photo.direction}`,
    };
    await this.write((store) => store.put(item));
    this.items.update((items) => [...items.filter((old) => old.id !== item.id), item]);
    return item;
  }

  async remove(id: string): Promise<void> {
    await this.write((store) => store.delete(id));
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  private async write(operation: (store: IDBObjectStore) => void): Promise<void> {
    const db = this.db;
    if (!db) return; // Visible UI warning: memory fallback requires the tab to stay open.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      operation(tx.objectStore('pending'));
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          new Error('Could not save the photo on this phone. Free some storage and try again.'),
        );
      tx.onabort = tx.onerror;
    });
  }
}

/** Limit large phone-camera files before sending to the existing 5 MiB API. */
export async function preparePointPhoto(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      'This image could not be opened. Take a new photo or choose a JPEG, PNG or WebP image.',
    );
  }
  try {
    const factor = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * factor));
    canvas.height = Math.max(1, Math.round(bitmap.height * factor));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare the photo.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be prepared.'))),
        'image/jpeg',
        0.86,
      ),
    );
    if (blob.size > 5 * 1024 * 1024)
      throw new Error('This photo is too large. Choose a smaller image.');
    return new File([blob], 'point-photo.jpg', { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}
