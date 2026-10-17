import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { CAPTURE_API_BASE, CAPTURE_MAP_BASE } from './capture-api.service';
import { CapturePage } from './capture';
import type { CaptureFloor, CapturePlan, Me, ServerPoint, SessionDetail } from './capture.models';
import { saveDraft } from './capture-drafts';
import { SLOTS } from './capture-math';
import { MemoryPhotoStore, PHOTO_STORE } from './photo-store';

const B = 'copy-sam-ibrahim-building-27687113',
  F = 'floor-4';
const me: Me = {
  authenticated: true,
  username: 'arjun',
  loginUrl: '/accounts/login/',
  targets: [
    { id: 't1', title: 'Sam Ibrahim L3', role: 'volunteer', mapBuildingId: B, mapFloorId: F },
    { id: 't2', title: 'Old target', role: 'viewer', mapBuildingId: 'other', mapFloorId: 'x' },
  ],
};
const buildings = [
  {
    id: B,
    name: 'Sam Ibrahim Building',
    floors: [
      { id: F, label: 'Level 3', revision: 7, scaleVerified: false },
      { id: 'floor-5', label: 'Level 4', revision: 2, scaleVerified: false },
    ],
  },
  { id: 'synthetic-capture-fixture', name: 'Fixture', floors: [] },
];
const floor: CaptureFloor = {
  buildingId: B,
  floorId: F,
  floorLabel: 'Level 3',
  revision: 7,
  width: 400,
  height: 300,
  scale: { verified: false, pixelsPerMetre: null },
  svg: '<svg viewBox="0 0 400 300"><rect width="400" height="300" /></svg>',
  corridors: [
    {
      id: 'corridor-abc',
      label: 'Hallway 3',
      lengthPx: 300,
      lengthM: null,
      path: [
        { x: 50, y: 100 },
        { x: 350, y: 100 },
      ],
      segments: [{ edgeId: 'e1', reversed: false, startPx: 0, endPx: 300 }],
      nodeIds: ['n1', 'n2'],
    },
  ],
  nodes: [
    { id: 'n1', kind: 'end', label: 'West stairs', x: 50, y: 100 },
    { id: 'n2', kind: 'junction', label: 'East lobby', x: 350, y: 100 },
  ],
  landmarks: [{ kind: 'room', id: 'r1', label: 'Room 301', x: 120, y: 80 }],
};
const planPoint = (order: number, x: number, reason: string) => ({
  planId: `corridor-abc:r:${(350 - x) * 10}`,
  order,
  x,
  y: 100,
  edgeId: 'e1',
  nodeId: null,
  referenceEdgeId: 'e1',
  fraction: (x - 50) / 300,
  corridorDistancePx: 350 - x,
  distanceM: null,
  forwardAngleDeg: 180,
  reason,
  nearby: [],
});
const flush = () => new Promise((resolve) => setTimeout(resolve));
async function nextRequest(
  http: HttpTestingController,
  method: string,
  url: string,
): Promise<TestRequest> {
  for (let i = 0; i < 100; i++) {
    const found = http.match((r) => r.method === method && r.url === url);
    if (found.length) return found[0];
    await flush();
  }
  throw new Error(`No ${method} ${url}`);
}

describe('capture page', () => {
  let store: MemoryPhotoStore;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    store = new MemoryPhotoStore();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'capture', component: CapturePage },
          { path: 'overview', children: [] },
        ]),
        { provide: PHOTO_STORE, useValue: async () => ({ store, warning: '' }) },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  async function open(url: string) {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl(url, CapturePage);
    (await nextRequest(http, 'GET', `${CAPTURE_API_BASE}/me`)).flush(me);
    (await nextRequest(http, 'GET', `${CAPTURE_MAP_BASE}/buildings`)).flush(buildings);
    return { harness, navigation };
  }
  async function loadFloor() {
    (await nextRequest(http, 'GET', `${CAPTURE_MAP_BASE}/buildings/${B}/floors/${F}`)).flush(floor);
  }
  const text = (h: RouterTestingHarness) => (h.routeNativeElement as HTMLElement).textContent ?? '';

  it('shows a sign-in link when the contributor is not authenticated', async () => {
    const harness = await RouterTestingHarness.create();
    void harness.navigateByUrl('/capture');
    (await nextRequest(http, 'GET', `${CAPTURE_API_BASE}/me`)).flush({
      authenticated: false,
      username: '',
      loginUrl: '/accounts/login/',
      targets: [],
    });
    (await nextRequest(http, 'GET', `${CAPTURE_MAP_BASE}/buildings`)).flush(buildings);
    await flush();
    harness.detectChanges();
    const link =
      harness.routeNativeElement!.querySelector<HTMLAnchorElement>('[data-testid="sign-in"]');
    expect(link?.getAttribute('href')).toBe('/accounts/login/?next=%2Fcapture');
  });

  it('offers only floors the contributor may capture, plans a manual session and syncs it before photos', async () => {
    const { harness } = await open('/capture');
    await loadFloor();
    (await nextRequest(http, 'GET', `${CAPTURE_API_BASE}/sessions`)).flush([]);
    await flush();
    harness.detectChanges();
    const page = harness.routeDebugElement!.componentInstance as CapturePage;
    // Only the target's floor (not Level 4 or the empty fixture) is offered; viewer targets are hidden.
    expect(page.available().map((b) => [b.id, b.floors.map((f) => f.id)])).toEqual([[B, [F]]]);
    expect(page.targets().map((t) => t.id)).toEqual(['t1']);
    expect(text(harness)).toContain('Sam Ibrahim L3');
    expect(text(harness)).toContain('Manual placement');
    expect(harness.routeNativeElement!.querySelector('[data-testid="spacing"]')).toBeNull();
    expect(text(harness)).toContain('Towards East lobby');
    expect(text(harness)).toContain('Towards West stairs');

    page.direction.set('reverse');
    void page.startSession();
    const plan = await nextRequest(http, 'POST', `${CAPTURE_MAP_BASE}/plan`);
    expect(plan.request.body).toEqual({
      buildingId: B,
      floorId: F,
      revision: 7,
      corridorId: 'corridor-abc',
      direction: 'reverse',
    });
    const response: CapturePlan = {
      revision: 7,
      scaleVerified: false,
      mode: 'manual',
      spacingM: null,
      path: [
        { x: 350, y: 100 },
        { x: 50, y: 100 },
      ],
      points: [planPoint(1, 350, 'junction'), planPoint(2, 50, 'end')],
    };
    plan.flush(response);
    for (let i = 0; i < 50 && !page.session(); i++) await flush();
    const session = await nextRequest(
      http,
      'PUT',
      `${CAPTURE_API_BASE}/sessions/${page.session()!.id}`,
    );
    expect(session.request.body).toEqual({
      targetId: 't1',
      mapBuildingId: B,
      mapFloorId: F,
      mapRevision: 7,
      corridorId: 'corridor-abc',
      direction: 'reverse',
      spacingM: null,
    });
    session.flush({});
    for (const p of page.points()) {
      const put = await nextRequest(
        http,
        'PUT',
        `${CAPTURE_API_BASE}/sessions/${page.session()!.id}/points/${p.id}`,
      );
      expect(put.request.body).toMatchObject({
        order: p.order,
        positionSource: 'planned',
        confirmedX: null,
        mapRevision: 7,
      });
      put.flush({});
    }
    await flush();
    harness.detectChanges();
    expect(page.phase()).toBe('map');
    expect(page.points().map((p) => p.order)).toEqual([1, 2]);
    expect(page.progressText()).toBe('0 of 2 points complete');
    expect(text(harness)).toContain('Point 1 of 2');
    expect(text(harness)).toContain('Walking towards West stairs');
    expect(text(harness)).not.toMatch(/your location/i);
    const startCapture = harness.routeNativeElement!.querySelector<HTMLButtonElement>(
      '[data-testid="start-capture"]',
    )!;
    expect(startCapture.disabled).toBe(true);

    // "I'm at this point" confirms the planned position.
    page.confirmHere();
    const first = page.points()[0];
    const confirm = await nextRequest(
      http,
      'PUT',
      `${CAPTURE_API_BASE}/sessions/${page.session()!.id}/points/${first.id}`,
    );
    expect(confirm.request.body).toMatchObject({
      confirmedX: 350,
      confirmedY: 100,
      positionSource: 'contributor-confirmed',
    });
    confirm.flush({});
    await flush();
    harness.detectChanges();
    expect(startCapture.disabled).toBe(false);
  });

  it('resumes a stored session after a refresh without showing pending photos as complete', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const serverPoint: ServerPoint = {
      id: 'p1',
      order: 1,
      planId: 'corridor-abc:f:0',
      mapRevision: 7,
      edgeId: 'e1',
      nodeId: 'n1',
      referenceEdgeId: 'e1',
      fraction: 0,
      corridorDistancePx: 0,
      distanceM: null,
      forwardAngleDeg: 0,
      plannedX: 50,
      plannedY: 100,
      confirmedX: 50,
      confirmedY: 100,
      positionSource: 'contributor-confirmed',
      reason: 'start',
      status: 'complete',
    };
    const body = {
      targetId: 't1',
      mapBuildingId: B,
      mapFloorId: F,
      mapRevision: 7,
      corridorId: 'corridor-abc',
      direction: 'forward' as const,
      spacingM: null,
    };
    // Saved on the phone before the refresh: a manual point the server never received.
    saveDraft({
      session: { id: sessionId, body, mode: 'manual', path: floor.corridors[0].path, synced: true },
      points: [
        { ...serverPoint, nearby: [], synced: true },
        {
          ...serverPoint,
          id: 'p2',
          order: 2,
          planId: null,
          nodeId: null,
          fraction: 0.5,
          corridorDistancePx: 150,
          plannedX: 200,
          confirmedX: null,
          confirmedY: null,
          positionSource: 'manual',
          reason: 'adjusted',
          status: undefined,
          nearby: [],
          synced: false,
        },
      ],
      corridorLabel: 'Hallway 3',
      savedAt: '2026-10-17T12:00:00.000Z',
    });
    // A retake of p1 is still waiting in the upload queue.
    await store.put(
      {
        id: 'photo-retake',
        sessionId,
        pointId: 'p1',
        session: body,
        point: serverPoint,
        metadata: {
          slot: 'left',
          viewingAngleDeg: 270,
          directionSource: 'manual-confirmed',
          positionSource: 'contributor-confirmed',
          capturedAt: '2026-10-17T12:00:00.000Z',
          clientSha256: 'b'.repeat(64),
        },
        state: 'upload-pending',
        attempts: 1,
        error: '',
        autoRetry: false,
        nextAttemptAt: 0,
        size: 1,
        createdAt: '2026-10-17T12:00:00.000Z',
      },
      new Blob(['z']),
    );

    const { harness } = await open(`/capture?session=${sessionId}`);
    const detail: SessionDetail = {
      id: sessionId,
      ...body,
      points: [serverPoint],
      photos: SLOTS.map((slot, i) => ({
        id: `ph${i}`,
        pointId: 'p1',
        slot,
        viewingAngleDeg: i * 90,
        uploadStatus: 'uploaded',
        reviewStatus: 'pending',
      })),
    };
    (await nextRequest(http, 'GET', `${CAPTURE_API_BASE}/sessions/${sessionId}`)).flush(detail);
    await loadFloor();
    (await nextRequest(http, 'GET', `${CAPTURE_API_BASE}/sessions`)).flush([
      { id: sessionId, ...body },
    ]);
    // The unsynced manual point is PUT again (idempotent) once the session is back.
    const put = await nextRequest(
      http,
      'PUT',
      `${CAPTURE_API_BASE}/sessions/${sessionId}/points/p2`,
    );
    expect(put.request.body).toMatchObject({ positionSource: 'manual', order: 2 });
    put.flush({});
    await flush();
    harness.detectChanges();

    const page = harness.routeDebugElement!.componentInstance as CapturePage;
    expect(page.phase()).toBe('map');
    expect(page.session()?.id).toBe(sessionId);
    expect(page.points().map((p) => p.id)).toEqual(['p1', 'p2']);
    // Four server photos, but a retake of p1 is still pending: not complete.
    expect(page.progress().get('p1')?.state).toBe('partial');
    expect(page.progressText()).toBe('0 of 2 points complete · 1 photo pending');
    expect(text(harness)).toContain('1 photo pending');
    // With photos the position is fixed: no Adjust, but "Add a new point here".
    page.select('p1');
    harness.detectChanges();
    const el = harness.routeNativeElement!;
    expect(el.querySelector('[data-testid="adjust"]')).toBeNull();
    expect(el.querySelector('[data-testid="add-here"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="remove"]')).toBeNull();
    expect(el.querySelector('[data-testid="uploads"]')?.textContent).toContain('Point 1 · Left');
  });
});
