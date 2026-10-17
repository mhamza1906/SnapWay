import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { CaptureApi, requestError } from './capture-api.service';
import type { PointBody, PositionSource, SessionBody, Slot } from './capture.models';
import { backoffMs, normalizeAngle } from './capture-math';
import { sha256Hex, uuid } from './capture-utils';
import {
  isQuotaError,
  MemoryPhotoStore,
  PHOTO_STORE,
  type PhotoStore,
  type QueuedPhoto,
} from './photo-store';

export interface NewPhoto {
  sessionId: string;
  pointId: string;
  session: SessionBody;
  point: PointBody;
  slot: Slot;
  viewingAngleDeg: number;
  positionSource: PositionSource;
  capturedAt?: string;
}

/**
 * Upload queue for saved photos: captured-locally → upload-pending → uploaded (only after
 * Django answers 200/201). Photos survive reloads in IndexedDB (memory fallback with a
 * warning), are retried with backoff and when the phone comes back online, and always
 * keep their client ID so every retry is the same idempotent PUT.
 */
@Injectable({ providedIn: 'root' })
export class UploadQueue {
  private readonly api = inject(CaptureApi);
  private readonly openStore = inject(PHOTO_STORE);
  readonly records = signal<QueuedPhoto[]>([]);
  /** ID of the photo being sent right now. */
  readonly uploading = signal<string | null>(null);
  readonly warning = signal('');
  readonly storageKind = signal<'indexeddb' | 'memory' | ''>('');
  /** Increments after each confirmed upload (the page refreshes server state on it). */
  readonly confirmed = signal(0);
  readonly ready: Promise<void>;
  /** Clock, overridable in tests. */
  now = () => Date.now();

  private store: PhotoStore = new MemoryPhotoStore();
  /** Photos whose blob did not fit in IndexedDB (quota) and only live in memory. */
  private readonly overflow = new MemoryPhotoStore();
  private readonly inOverflow = new Set<string>();
  /** Session/point bodies Django already accepted in this page load. */
  private readonly synced = new Set<string>();
  private running = false;
  private rerun = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const online = () => this.retryAll();
    globalThis.addEventListener?.('online', online);
    inject(DestroyRef).onDestroy(() => {
      globalThis.removeEventListener?.('online', online);
      clearTimeout(this.timer);
    });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const { store, warning } = await this.openStore();
      this.store = store;
      this.warning.set(warning);
    } catch {
      this.warning.set('Photo storage is unavailable; photos are kept in memory only.');
    }
    this.storageKind.set(this.store.kind);
    let stored: QueuedPhoto[] = [];
    try {
      stored = await this.store.list();
    } catch {
      this.warning.set('Saved photos could not be read from this phone.');
    }
    // A photo that was mid-upload when the page closed is simply pending again.
    this.records.set(
      stored
        .map((r) =>
          r.state === 'captured-locally' ? { ...r, state: 'upload-pending' as const } : r,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
    void this.process();
  }

  /** Stores a photo on the phone, then queues it for upload. */
  async add(blob: Blob, photo: NewPhoto): Promise<QueuedPhoto> {
    await this.ready;
    const record: QueuedPhoto = {
      id: uuid(),
      sessionId: photo.sessionId,
      pointId: photo.pointId,
      session: photo.session,
      point: photo.point,
      metadata: {
        slot: photo.slot,
        viewingAngleDeg: normalizeAngle(photo.viewingAngleDeg),
        directionSource: 'manual-confirmed',
        positionSource: photo.positionSource,
        capturedAt: photo.capturedAt ?? new Date(this.now()).toISOString(),
        clientSha256: await sha256Hex(blob),
      },
      state: 'captured-locally',
      attempts: 0,
      error: '',
      autoRetry: false,
      nextAttemptAt: 0,
      size: blob.size,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.records.update((list) => [...list, record]);
    await this.save(record, blob);
    await this.patch(record.id, { state: 'upload-pending' });
    void this.process();
    return this.get(record.id)!;
  }

  get(id: string): QueuedPhoto | undefined {
    return this.records().find((r) => r.id === id);
  }

  /** Sends this photo again now (same ID, same metadata). */
  retry(id: string): void {
    const r = this.get(id);
    if (!r || r.state === 'uploaded') return;
    void this.patch(id, { state: 'upload-pending', nextAttemptAt: 0, error: '' }).then(() =>
      this.process(),
    );
  }

  /** Retries everything not yet uploaded (also run when the phone comes back online). */
  retryAll(): void {
    for (const r of this.records())
      if (r.state === 'failed' || r.state === 'upload-pending')
        void this.patch(r.id, { state: 'upload-pending', nextAttemptAt: 0 });
    void this.process();
  }

  /** Forgets a photo that failed and will not be uploaded (e.g. after a retake). */
  async discard(id: string): Promise<void> {
    const r = this.get(id);
    if (!r || r.state === 'uploaded' || this.uploading() === id) return;
    this.records.update((list) => list.filter((x) => x.id !== id));
    await this.storeFor(id)
      .remove(id)
      .catch(() => undefined);
  }

  /**
   * Keeps the point bodies of photos not uploaded yet in step with the screen (for example
   * a new `order` after a point was added), so the queue never resends an outdated point.
   */
  updatePoints(sessionId: string, bodies: Map<string, PointBody>): void {
    for (const r of this.records()) {
      const body = bodies.get(r.pointId);
      if (
        r.sessionId === sessionId &&
        r.state !== 'uploaded' &&
        body &&
        JSON.stringify(body) !== JSON.stringify(r.point)
      )
        void this.patch(r.id, { point: body });
    }
  }

  /** Records that Django already accepted this body (so the queue does not resend it). */
  markSynced(key: string, body: unknown): void {
    this.synced.add(key + JSON.stringify(body));
  }

  /** Uploads every due photo, one at a time, then schedules the next backoff retry. */
  async process(): Promise<void> {
    await this.ready;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      for (;;) {
        const next = this.records().find((r) => this.isDue(r));
        if (!next) break;
        await this.upload(next);
      }
    } finally {
      this.running = false;
    }
    if (this.rerun) {
      this.rerun = false;
      return this.process();
    }
    this.schedule();
  }

  private isDue(r: QueuedPhoto): boolean {
    return (
      (r.state === 'upload-pending' || (r.state === 'failed' && r.autoRetry)) &&
      r.nextAttemptAt <= this.now()
    );
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const waits = this.records()
      .filter((r) => r.state === 'failed' && r.autoRetry)
      .map((r) => r.nextAttemptAt);
    if (!waits.length) return;
    const delay = Math.max(0, Math.min(...waits) - this.now());
    this.timer = setTimeout(() => void this.process(), delay);
  }

  private async ensure(key: string, body: unknown, put: () => Promise<unknown>): Promise<void> {
    const signature = key + JSON.stringify(body);
    if (this.synced.has(signature)) return;
    await put();
    this.synced.add(signature);
  }

  private async upload(r: QueuedPhoto): Promise<void> {
    this.uploading.set(r.id);
    try {
      const blob = await this.storeFor(r.id).blob(r.id);
      if (!blob) {
        await this.patch(r.id, {
          state: 'failed',
          autoRetry: false,
          error: 'This photo is no longer stored on this phone. Take it again.',
        });
        return;
      }
      // Django needs the session and the point before their photos (all idempotent PUTs).
      await this.ensure(`session:${r.sessionId}`, r.session, () =>
        this.api.putSession(r.sessionId, r.session),
      );
      await this.ensure(`point:${r.pointId}`, r.point, () =>
        this.api.putPoint(r.sessionId, r.pointId, r.point),
      );
      const res = await this.api.putPhoto(r.pointId, r.id, blob, r.metadata);
      if (res.status !== 200 && res.status !== 201)
        throw new HttpErrorResponse({ status: res.status, statusText: res.statusText });
      await this.patch(r.id, { state: 'uploaded', error: '', autoRetry: false });
      await this.storeFor(r.id)
        .dropBlob(r.id)
        .catch(() => undefined);
      this.confirmed.update((n) => n + 1);
    } catch (error) {
      const status = error instanceof HttpErrorResponse ? error.status : -1;
      const transient = status <= 0 || status >= 500 || status === 408 || status === 429;
      const attempts = r.attempts + 1;
      const message =
        status === 409
          ? 'The server already has a different image or a moved point under this ID, so this photo was not uploaded.'
          : requestError(error, 'Upload failed');
      await this.patch(r.id, {
        state: 'failed',
        attempts,
        autoRetry: transient,
        nextAttemptAt: transient ? this.now() + backoffMs(attempts) : 0,
        error: transient ? `${message} Retrying automatically.` : message,
      });
    } finally {
      this.uploading.set(null);
    }
  }

  private storeFor(id: string): PhotoStore {
    return this.inOverflow.has(id) ? this.overflow : this.store;
  }

  private async patch(id: string, changes: Partial<QueuedPhoto>): Promise<void> {
    let updated: QueuedPhoto | undefined;
    this.records.update((list) =>
      list.map((r) => (r.id === id ? (updated = { ...r, ...changes }) : r)),
    );
    if (updated) await this.save(updated);
  }

  private async save(record: QueuedPhoto, blob?: Blob): Promise<void> {
    try {
      await this.storeFor(record.id).put(record, blob);
    } catch (error) {
      this.inOverflow.add(record.id);
      await this.overflow.put(
        record,
        blob ?? (await this.store.blob(record.id).catch(() => null)) ?? undefined,
      );
      this.warning.set(
        isQuotaError(error)
          ? 'This phone is out of storage for photos. New photos are kept in memory only: keep this page open until they upload, or free up space.'
          : 'A photo could not be stored on this phone and is kept in memory only. Keep this page open until it uploads.',
      );
    }
  }
}
