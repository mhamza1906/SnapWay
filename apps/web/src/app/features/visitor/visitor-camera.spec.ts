import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { VisitorCamera, VISITOR_CAPTURE_DEVICE } from './visitor-camera';

const device = {
  native: false,
  permission: vi.fn(),
  listen: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  upload: vi.fn(),
  config: vi.fn(),
  read: vi.fn(),
  discard: vi.fn(),
  clear: vi.fn(),
};

describe('Visitor camera opening and consent', () => {
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  beforeEach(() => {
    device.native = false;
    vi.clearAllMocks();
    device.stop.mockResolvedValue({ capturing: false });
    device.discard.mockResolvedValue({ deleted: true });
    device.clear.mockResolvedValue({ deleted: 1 });
    device.read.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,c3ludGhldGlj' });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: VISITOR_CAPTURE_DEVICE,
          useFactory: () => ({
            native: device.native,
            frames: {
              requestPermission: device.permission,
              addListener: device.listen,
              start: device.start,
              stop: device.stop,
              uploadFrame: device.upload,
              getDevConfig: device.config,
              readFrame: device.read,
              discardFrame: device.discard,
              deleteFrames: device.clear,
            },
          }),
        },
      ],
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMedia) Object.defineProperty(navigator, 'mediaDevices', originalMedia);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  });
  function setup() {
    const fixture = TestBed.createComponent(VisitorCamera);
    fixture.detectChanges();
    return fixture;
  }
  it('opens the rear camera on entry, explains the photo, and does not upload automatically', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const fixture = setup();
    await vi.waitFor(() => expect(fixture.componentInstance.ready()).toBe(true));
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ facingMode: { ideal: 'environment' } }),
        audio: false,
      }),
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Keep a nearby sign or landmark clearly in view',
    );
    TestBed.inject(HttpTestingController).expectNone('/api/navigation/localize/');
    fixture.destroy();
    expect(stop).toHaveBeenCalled();
  });
  it('stops a stream granted after the camera screen has closed', async () => {
    let grant!: (stream: unknown) => void;
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    const fixture = setup();
    fixture.destroy();
    grant({ getTracks: () => [{ stop }] });
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
  });
  it('uploads one camera JPEG with a visitor capability and emits the exact detected node', async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['synthetic-jpeg'], { type: 'image/jpeg' })),
    );
    const fixture = setup();
    fixture.componentRef.setInput('publicationId', 'destination-publication');
    await vi.waitFor(() => expect(fixture.componentInstance.ready()).toBe(true));
    Object.defineProperties(fixture.componentInstance.video()!.nativeElement, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    const emitted = vi.spyOn(fixture.componentInstance.matched, 'emit');
    const taking = fixture.componentInstance.take();
    const http = TestBed.inject(HttpTestingController);
    const session = await vi.waitFor(() => http.expectOne('/api/navigation/sessions/'));
    expect(session.request.body).toEqual({ publication_id: 'destination-publication' });
    session.flush({ token: 'synthetic-capability' });
    const request = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    expect(request.request.headers.get('Authorization')).toBe('Navigation synthetic-capability');
    expect(request.request.body.get('image').type).toBe('image/jpeg');
    expect(JSON.parse(request.request.body.get('meta')).source).toBe('camera');
    const node = {
      node_id: 'revision-node',
      stable_id: 'stable-node',
      revision_id: 'revision',
      target_id: 'target',
      label: 'West stair landing',
      kind: 'stairs',
      floor_id: 'floor',
      floor_name: 'Floor 1',
      building_id: 'building',
      building_name: 'Route building',
    };
    const result = {
      node_id: node.node_id,
      revision_id: node.revision_id,
      matched_node: node,
      localization_token: 'signed-location',
      decision: {
        outcome: 'likely_match',
        node_id: node.node_id,
        location_id: node.node_id,
        reasons: [],
      },
      candidates: [],
      backend_used: 'megaloc',
      thresholds_id: 'synthetic-thresholds',
    };
    request.flush(result);
    await taking;
    expect(emitted).toHaveBeenCalledExactlyOnceWith(result);
    expect(stop).toHaveBeenCalled();
    http.verify();
    fixture.destroy();
  });
  it('shows permission recovery when the device refuses camera access', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('Denied')) },
    });
    const fixture = setup();
    await vi.waitFor(() =>
      expect(fixture.componentInstance.error()).toContain('Allow camera permission'),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeTruthy();
    TestBed.inject(HttpTestingController).expectNone('/api/navigation/localize/');
  });
  it('shows the missing-reference setup problem when a browser upload returns 503', async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['synthetic-jpeg'], { type: 'image/jpeg' })),
    );
    const fixture = setup();
    await vi.waitFor(() => expect(fixture.componentInstance.ready()).toBe(true));
    Object.defineProperties(fixture.componentInstance.video()!.nativeElement, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    const emitted = vi.spyOn(fixture.componentInstance.matched, 'emit');
    const taking = fixture.componentInstance.take();
    const http = TestBed.inject(HttpTestingController);
    const request = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    request.flush(
      { error: 'index_not_ready', detail: 'No ready MegaLoc indexes in the localization catalog.' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await taking;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'The map team needs to prepare its reference photos.',
    );
    expect(emitted).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(fixture.componentInstance.ready()).toBe(false);
    http.verify();
    fixture.destroy();
  });
  it('captures a fresh native JPEG and submits using visitor auth without a developer token', async () => {
    device.native = true;
    device.permission.mockResolvedValue({ camera: 'authorized' });
    device.config.mockResolvedValue({ available: true, hasToken: true });
    device.start.mockResolvedValue({ capturing: true });
    let frame!: (value: unknown) => void;
    device.listen.mockImplementation(async (_event, listener) => {
      frame = listener;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });
    const fixture = setup();
    await vi.waitFor(() => expect(device.start).toHaveBeenCalledTimes(1));
    frame({ client_frame_id: 1, preview: 'data:image/jpeg;base64,cHJldmlldw==' });
    await vi.waitFor(() => expect(fixture.componentInstance.ready()).toBe(true));
    expect(device.upload).not.toHaveBeenCalled();
    const result = {
      decision: { outcome: 'likely_match', location_id: 'room', reasons: [] },
      candidates: [],
      backend_used: 'test',
      thresholds_id: 'test',
    };
    const submitted = vi.spyOn(fixture.componentInstance.matched, 'emit');
    const taking = fixture.componentInstance.take();
    await vi.waitFor(() => expect(device.start).toHaveBeenCalledTimes(2));
    frame({ client_frame_id: 2 });
    const http = TestBed.inject(HttpTestingController);
    const request = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    expect(request.request.body.get('image').type).toBe('image/jpeg');
    request.flush(result);
    await taking;
    expect(device.config).not.toHaveBeenCalled();
    expect(device.upload).not.toHaveBeenCalled();
    expect(device.read).toHaveBeenCalledWith({ clientFrameId: 2 });
    expect(device.discard).toHaveBeenCalledWith({ clientFrameId: 2 });
    expect(submitted).toHaveBeenCalledWith(result);
    fixture.destroy();
    expect(device.stop).toHaveBeenCalled();
  });
  async function nativeReady() {
    device.native = true;
    device.permission.mockResolvedValue({ camera: 'authorized' });
    device.start.mockResolvedValue({ capturing: true });
    const callbacks: Record<string, (frame: any) => void> = {};
    device.listen.mockImplementation(async (event, callback) => {
      callbacks[event] = callback;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });
    const fixture = setup();
    fixture.componentRef.setInput('publicationId', 'publication');
    await vi.waitFor(() => expect(device.start).toHaveBeenCalled());
    callbacks['frame']({ client_frame_id: 0, preview: 'data:image/jpeg;base64,cHJldmlldw==' });
    await vi.waitFor(() => expect(fixture.componentInstance.ready()).toBe(true));
    return { fixture, callbacks };
  }
  const liveResult = (outcome = 'likely_match') => ({
    decision: { outcome, location_id: 'point-1', reasons: [] },
    candidates: [],
    backend_used: 'megaloc',
    thresholds_id: 'synthetic',
  });
  it('live matching keeps a single request in flight and drops extra frames instead of queuing', async () => {
    const { fixture, callbacks } = await nativeReady();
    const component = fixture.componentInstance;
    const emitted = vi.spyOn(component.liveMatched, 'emit');
    const photoEmitted = vi.spyOn(component.matched, 'emit');
    await component.startLive();
    expect(device.start).toHaveBeenLastCalledWith({ fps: 0.8 });
    callbacks['frame']({ client_frame_id: 1 });
    const http = TestBed.inject(HttpTestingController);
    const session = await vi.waitFor(() => http.expectOne('/api/navigation/sessions/'));
    session.flush({ token: 'synthetic-live-capability' });
    const request = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    callbacks['frame']({ client_frame_id: 2 });
    callbacks['frame']({ client_frame_id: 3 });
    await vi.waitFor(() => expect(device.discard).toHaveBeenCalledWith({ clientFrameId: 3 }));
    http.expectNone('/api/navigation/localize/');
    request.flush(liveResult());
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(1));
    expect(component.live()).toBe(true);
    expect(photoEmitted).not.toHaveBeenCalled();
    callbacks['frame']({ client_frame_id: 4 });
    const second = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    expect(second.request.headers.get('Authorization')).toBe(
      'Navigation synthetic-live-capability',
    );
    http.expectNone('/api/navigation/sessions/');
    second.flush(liveResult('uncertain'));
    await vi.waitFor(() => expect(component.liveMessage()).toContain('uncertain'));
    expect(emitted).toHaveBeenCalledTimes(1);
    fixture.destroy();
    await vi.waitFor(() => expect(device.clear).toHaveBeenCalled());
    http.verify();
  });
  it('Stop cancels an outstanding request, clears native frames and prevents late location events', async () => {
    const { fixture, callbacks } = await nativeReady();
    const component = fixture.componentInstance;
    const emitted = vi.spyOn(component.liveMatched, 'emit');
    await component.startLive();
    callbacks['frame']({ client_frame_id: 1 });
    const http = TestBed.inject(HttpTestingController);
    const session = await vi.waitFor(() => http.expectOne('/api/navigation/sessions/'));
    session.flush({ token: 'synthetic-live-capability' });
    const request = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    component.stopLive();
    expect(request.cancelled).toBe(true);
    await vi.waitFor(() => expect(device.clear).toHaveBeenCalled());
    callbacks['frame']({ client_frame_id: 2 });
    http.expectNone('/api/navigation/localize/');
    expect(emitted).not.toHaveBeenCalled();
    expect(component.live()).toBe(false);
    fixture.destroy();
  });
  it('stops live capture when offline, hidden or interrupted and requires an explicit restart', async () => {
    const { fixture, callbacks } = await nativeReady();
    const component = fixture.componentInstance;
    await component.startLive();
    callbacks['state']({ capturing: false, reason: 'background' });
    expect(component.live()).toBe(false);
    expect(device.stop).toHaveBeenCalled();
    await component.startLive();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    expect(component.live()).toBe(false);
    await component.startLive();
    expect(component.error()).toContain('internet connection');
    fixture.destroy();
  });
  it('stops on an unavailable index without repeatedly uploading frames', async () => {
    const { fixture, callbacks } = await nativeReady();
    const component = fixture.componentInstance;
    await component.startLive();
    callbacks['frame']({ client_frame_id: 1 });
    const http = TestBed.inject(HttpTestingController);
    const session = await vi.waitFor(() => http.expectOne('/api/navigation/sessions/'));
    session.flush({ token: 'synthetic-live-capability' });
    const request = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    request.flush({ error: 'index_not_ready' }, { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(component.live()).toBe(false));
    expect(component.error()).toContain('prepare its reference photos');
    callbacks['frame']({ client_frame_id: 2 });
    http.expectNone('/api/navigation/localize/');
    fixture.destroy();
  });
  it('stops a browser stream granted after the app has gone into the background', async () => {
    let grant!: (stream: unknown) => void;
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    const fixture = setup();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    grant({ getTracks: () => [{ stop }] });
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    expect(fixture.componentInstance.ready()).toBe(false);
    fixture.destroy();
  });
  it('runs browser live matching only after Start and releases the camera on Stop', async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['synthetic'], { type: 'image/jpeg' })),
    );
    const fixture = setup();
    await vi.waitFor(() => expect(fixture.componentInstance.ready()).toBe(true));
    Object.defineProperties(fixture.componentInstance.video()!.nativeElement, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectNone('/api/navigation/localize/');
    const starting = fixture.componentInstance.startLive();
    const request = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    expect(request.request.body.get('image').type).toBe('image/jpeg');
    request.flush(liveResult('uncertain'));
    await starting;
    expect(fixture.componentInstance.live()).toBe(true);
    fixture.componentInstance.stopLive();
    expect(stop).toHaveBeenCalled();
    expect(fixture.componentInstance.live()).toBe(false);
    expect(fixture.componentInstance.ready()).toBe(false);
    fixture.destroy();
    http.verify();
  });
  it('waits for native Stop and cache deletion before an immediate live restart', async () => {
    const { fixture } = await nativeReady();
    const component = fixture.componentInstance;
    await component.startLive();
    const priorStarts = device.start.mock.calls.length;
    let finishStop!: () => void;
    let finishDelete!: () => void;
    device.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    device.clear.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    component.stopLive();
    const restarting = component.startLive();
    await vi.waitFor(() => expect(finishStop).toBeTypeOf('function'));
    expect(device.start).toHaveBeenCalledTimes(priorStarts);
    expect(finishDelete).toBeUndefined();
    finishStop();
    await vi.waitFor(() => expect(finishDelete).toBeTypeOf('function'));
    expect(device.start).toHaveBeenCalledTimes(priorStarts);
    finishDelete();
    await restarting;
    expect(device.start).toHaveBeenCalledTimes(priorStarts + 1);
    const lastDelete = device.clear.mock.invocationCallOrder.at(-1)!;
    const lastStart = device.start.mock.invocationCallOrder.at(-1)!;
    expect(lastDelete).toBeLessThan(lastStart);
    await Promise.resolve();
    expect(device.clear.mock.invocationCallOrder.at(-1)).toBe(lastDelete);
    expect(component.live()).toBe(true);
    fixture.destroy();
  });
  it('does not restart native capture if the screen closes while prior cleanup is pending', async () => {
    const { fixture } = await nativeReady();
    const component = fixture.componentInstance;
    await component.startLive();
    const priorStarts = device.start.mock.calls.length;
    let finishStop!: () => void;
    device.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    component.stopLive();
    const restarting = component.startLive();
    await vi.waitFor(() => expect(finishStop).toBeTypeOf('function'));
    fixture.destroy();
    finishStop();
    await restarting;
    await vi.waitFor(() => expect(device.clear).toHaveBeenCalled());
    expect(device.start).toHaveBeenCalledTimes(priorStarts);
  });
  it('timestamps browser samples with monotonic elapsed time since the stream opened', async () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['synthetic'], { type: 'image/jpeg' })),
    );
    const fixture = setup();
    await vi.waitFor(() => expect(fixture.componentInstance.ready()).toBe(true));
    Object.defineProperties(fixture.componentInstance.video()!.nativeElement, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    const http = TestBed.inject(HttpTestingController);
    clock = 2500;
    const starting = fixture.componentInstance.startLive();
    const first = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'));
    expect(JSON.parse(first.request.body.get('meta')).timestamp_s).toBe(1.5);
    clock = 4750;
    first.flush(liveResult('uncertain'));
    await starting;
    const second = await vi.waitFor(() => http.expectOne('/api/navigation/localize/'), {
      timeout: 2000,
    });
    expect(JSON.parse(second.request.body.get('meta')).timestamp_s).toBe(3.75);
    second.flush(liveResult('uncertain'));
    fixture.destroy();
    http.verify();
  });
  it('ignores an old native state callback after a new live run has started', async () => {
    const { fixture, callbacks } = await nativeReady();
    const component = fixture.componentInstance;
    await component.startLive();
    const oldState = callbacks['state'];
    component.stopLive();
    await component.startLive();
    oldState({ capturing: false, reason: 'background' });
    expect(component.live()).toBe(true);
    fixture.destroy();
  });
});
