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
    fixture.componentRef.setInput('buildingName', 'IA Sam Ibrahim Building');
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
    expect(fixture.nativeElement.textContent).toContain('IA Sam Ibrahim Building');
    expect(fixture.nativeElement.textContent).toContain('Keep the sign readable');
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
  it.each([false, true])(
    'captures a fresh native photo with demo=%s, uploading only a real match request',
    async (demo) => {
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
      fixture.componentRef.setInput('demo', demo);
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
      const captured = vi.spyOn(fixture.componentInstance.captured, 'emit');
      const taking = fixture.componentInstance.take();
      await vi.waitFor(() => expect(device.start).toHaveBeenCalledTimes(2));
      frame({ client_frame_id: 2 });
      await taking;
      if (demo) {
        expect(device.upload).not.toHaveBeenCalled();
        expect(device.config).not.toHaveBeenCalled();
        expect(submitted).not.toHaveBeenCalled();
        expect(captured).toHaveBeenCalledTimes(1);
      } else {
        expect(device.upload).toHaveBeenCalledTimes(1);
        expect(device.upload).toHaveBeenCalledWith(expect.objectContaining({ clientFrameId: 2 }));
        expect(submitted).toHaveBeenCalledWith(result);
        expect(captured).not.toHaveBeenCalled();
      }
      fixture.destroy();
      expect(device.stop).toHaveBeenCalled();
    },
  );
});
