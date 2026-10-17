import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CAPTURE_API_BASE } from './capture-api.service';
import type { PointBody, SessionBody } from './capture.models';
import { MemoryPhotoStore, PHOTO_STORE } from './photo-store';
import { UploadQueue } from './upload-queue.service';

const session: SessionBody = {
  targetId: 't1',
  mapBuildingId: 'b1',
  mapFloorId: 'f1',
  mapRevision: 3,
  corridorId: 'c1',
  direction: 'reverse',
  spacingM: null,
};
const point: PointBody = {
  order: 1,
  planId: null,
  mapRevision: 3,
  edgeId: 'e1',
  nodeId: null,
  referenceEdgeId: 'e1',
  fraction: 0.5,
  corridorDistancePx: 40,
  distanceM: null,
  forwardAngleDeg: 180,
  plannedX: 10,
  plannedY: 20,
  confirmedX: 10,
  confirmedY: 20,
  positionSource: 'manual',
  reason: 'adjusted',
};

/** Waits (a few macrotasks) for one request matching `url` and `method`. */
async function nextRequest(
  http: HttpTestingController,
  method: string,
  url: string,
): Promise<TestRequest> {
  for (let i = 0; i < 100; i++) {
    const found = http.match((r) => r.method === method && r.url === url);
    if (found.length) return found[0];
    await new Promise((resolve) => setTimeout(resolve));
  }
  throw new Error(`No ${method} ${url}`);
}

describe('photo upload queue', () => {
  let store: MemoryPhotoStore;
  function setup(open: () => Promise<{ store: MemoryPhotoStore; warning: string }>) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PHOTO_STORE, useValue: open },
      ],
    });
    return { queue: TestBed.inject(UploadQueue), http: TestBed.inject(HttpTestingController) };
  }
  beforeEach(() => {
    store = new MemoryPhotoStore();
    document.cookie = 'XSRF-TOKEN=token-123; path=/';
  });

  it('PUTs session and point first, keeps the same photo id on retry, and is uploaded only after the server confirms', async () => {
    const { queue, http } = setup(async () => ({ store, warning: '' }));
    const added = await queue.add(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }), {
      sessionId: 's1',
      pointId: 'p1',
      session,
      point,
      slot: 'left',
      viewingAngleDeg: 450,
      positionSource: 'manual',
      capturedAt: '2026-10-17T12:00:00.000Z',
    });
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(added.metadata).toEqual({
      slot: 'left',
      viewingAngleDeg: 90,
      directionSource: 'manual-confirmed',
      positionSource: 'manual',
      capturedAt: '2026-10-17T12:00:00.000Z',
      clientSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Stored on the phone with its blob.
    expect((await store.list()).map((r) => r.id)).toEqual([added.id]);
    expect(await store.blob(added.id)).not.toBeNull();

    const s = await nextRequest(http, 'PUT', `${CAPTURE_API_BASE}/sessions/s1`);
    expect(s.request.body).toEqual(session);
    expect(s.request.headers.get('X-XSRF-TOKEN')).toBe('token-123');
    expect(s.request.withCredentials).toBe(true);
    s.flush({ id: 's1', ...session });
    const p = await nextRequest(http, 'PUT', `${CAPTURE_API_BASE}/sessions/s1/points/p1`);
    expect(p.request.body).toEqual(point);
    p.flush({ id: 'p1', ...point });

    const photoUrl = `${CAPTURE_API_BASE}/points/p1/photos/${added.id}`;
    const first = await nextRequest(http, 'PUT', photoUrl);
    const form = first.request.body as FormData;
    expect(JSON.parse(form.get('metadata') as string)).toEqual(added.metadata);
    expect(form.get('image')).toBeInstanceOf(Blob);
    expect(queue.get(added.id)?.state).toBe('upload-pending');
    first.flush({ detail: 'busy' }, { status: 503, statusText: 'Unavailable' });
    await waitFor(() => queue.get(added.id)?.state === 'failed');
    const failed = queue.get(added.id)!;
    expect(failed.autoRetry).toBe(true);
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt).toBeGreaterThan(Date.now());

    queue.retry(added.id);
    // Session and point are not resent; the photo goes again under the same id.
    const second = await nextRequest(http, 'PUT', photoUrl);
    http.expectNone(`${CAPTURE_API_BASE}/sessions/s1`);
    expect(JSON.parse((second.request.body as FormData).get('metadata') as string)).toEqual(
      added.metadata,
    );
    second.flush({ id: added.id }, { status: 200, statusText: 'OK' });
    await waitFor(() => queue.get(added.id)?.state === 'uploaded');
    expect(queue.confirmed()).toBe(1);
    expect(await store.blob(added.id)).toBeNull();
    expect((await store.list())[0].state).toBe('uploaded');
    http.verify();
  });

  it('does not auto-retry a conflict (different image for the same id)', async () => {
    const { queue, http } = setup(async () => ({ store, warning: '' }));
    queue.markSynced('session:s1', session);
    queue.markSynced('point:p1', point);
    const added = await queue.add(new Blob(['x']), {
      sessionId: 's1',
      pointId: 'p1',
      session,
      point,
      slot: 'forward',
      viewingAngleDeg: 180,
      positionSource: 'manual',
    });
    (await nextRequest(http, 'PUT', `${CAPTURE_API_BASE}/points/p1/photos/${added.id}`)).flush(
      {},
      { status: 409, statusText: 'Conflict' },
    );
    await waitFor(() => queue.get(added.id)?.state === 'failed');
    expect(queue.get(added.id)?.autoRetry).toBe(false);
    expect(queue.get(added.id)?.error).toContain('different image');
  });

  it('picks up photos stored before a reload and uploads them under their stored id', async () => {
    await store.put(
      {
        id: 'photo-1',
        sessionId: 's1',
        pointId: 'p1',
        session,
        point,
        metadata: {
          slot: 'right',
          viewingAngleDeg: 270,
          directionSource: 'manual-confirmed',
          positionSource: 'manual',
          capturedAt: '2026-10-17T12:00:00.000Z',
          clientSha256: 'a'.repeat(64),
        },
        state: 'captured-locally',
        attempts: 0,
        error: '',
        autoRetry: false,
        nextAttemptAt: 0,
        size: 1,
        createdAt: '2026-10-17T12:00:00.000Z',
      },
      new Blob(['y']),
    );
    const { queue, http } = setup(async () => ({ store, warning: '' }));
    await queue.ready;
    expect(queue.get('photo-1')?.state).toBe('upload-pending');
    (await nextRequest(http, 'PUT', `${CAPTURE_API_BASE}/sessions/s1`)).flush({});
    (await nextRequest(http, 'PUT', `${CAPTURE_API_BASE}/sessions/s1/points/p1`)).flush({});
    (await nextRequest(http, 'PUT', `${CAPTURE_API_BASE}/points/p1/photos/photo-1`)).flush(
      {},
      { status: 201, statusText: 'Created' },
    );
    await waitFor(() => queue.get('photo-1')?.state === 'uploaded');
  });

  it('falls back to memory with a warning when IndexedDB is unavailable', async () => {
    const { queue, http } = setup(async () => {
      throw new Error('IndexedDB blocked');
    });
    await queue.ready;
    expect(queue.storageKind()).toBe('memory');
    expect(queue.warning()).toContain('kept in memory');
    http.verify();
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve));
  }
  throw new Error('Condition not met');
}
