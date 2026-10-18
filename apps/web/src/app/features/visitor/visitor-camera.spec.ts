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
};

describe('Visitor camera opening and consent', () => {
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  beforeEach(() => {
    device.native = false;
    vi.clearAllMocks();
    device.stop.mockResolvedValue({ capturing: false });
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
  it('captures a fresh native photo and submits it to the configured matcher', async () => {
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
    device.upload.mockResolvedValue({
      status: 200,
      body: JSON.stringify(result),
      roundTripMs: 10,
    });
    const submitted = vi.spyOn(fixture.componentInstance.matched, 'emit');
    const taking = fixture.componentInstance.take();
    await vi.waitFor(() => expect(device.start).toHaveBeenCalledTimes(2));
    frame({ client_frame_id: 2 });
    await taking;
    expect(device.upload).toHaveBeenCalledTimes(1);
    expect(device.upload).toHaveBeenCalledWith(expect.objectContaining({ clientFrameId: 2 }));
    expect(submitted).toHaveBeenCalledWith(result);
    fixture.destroy();
    expect(device.stop).toHaveBeenCalled();
  });
});
