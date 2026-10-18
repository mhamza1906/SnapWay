import { TestBed } from '@angular/core/testing';
import { CameraLab } from './camera-lab';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('Camera matching lifecycle', () => {
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
    stopTrack.mockClear();
  });

  it('stops tracks from a late permission grant after Stop or destruction and never uploads', async () => {
    const permission = deferred<MediaStream>();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(() => permission.promise) },
    });
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const fixture = TestBed.createComponent(CameraLab);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const starting = component.start();
    expect(component.active()).toBe(true);
    component.stop();
    fixture.destroy();
    permission.resolve(stream);
    await starting;
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(component.active()).toBe(false);
  });

  it('aborts the single in-flight JPEG request on Stop and schedules no later capture', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
    );
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      if (String(url).endsWith('/session'))
        return { ok: true, json: async () => ({ sessionId: 'local-test' }) } as Response;
      requestSignal = options?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) =>
        requestSignal!.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ),
      );
    });
    vi.stubGlobal('fetch', request);
    const fixture = TestBed.createComponent(CameraLab);
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { value: 1280 });
    Object.defineProperty(video, 'videoHeight', { value: 720 });
    const component = fixture.componentInstance;
    const starting = component.start();
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]?.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'X-Lab-Session': 'local-test',
    });
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(2);
    component.stop();
    await starting;
    await vi.advanceTimersByTimeAsync(10000);
    expect(requestSignal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
