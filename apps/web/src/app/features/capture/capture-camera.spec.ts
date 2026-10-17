import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { CaptureCamera } from './capture-camera';
import { CAMERA_CONSTRAINTS } from './camera';

function fakeStream() {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    getSettings: () => ({ width: 4032, height: 3024 }),
  };
  return {
    track,
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
  };
}

describe('guided capture camera', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    vi.restoreAllMocks();
  });

  async function mount(forwardDeg = 0) {
    const fixture = TestBed.createComponent(CaptureCamera);
    fixture.componentRef.setInput('point', { x: 100, y: 50 });
    fixture.componentRef.setInput('forwardDeg', forwardDeg);
    fixture.componentRef.setInput('ends', { towards: 'Room 301', from: 'Main entrance' });
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    return fixture;
  }

  it('opens the rear camera live and stops every track when destroyed', async () => {
    const { stream, track } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const fixture = await mount();
    expect(getUserMedia).toHaveBeenCalledWith(CAMERA_CONSTRAINTS);
    expect(CAMERA_CONSTRAINTS.video).toMatchObject({ facingMode: { ideal: 'environment' } });
    expect(fixture.componentInstance.status()).toBe('live');
    expect(fixture.nativeElement.querySelector('[data-testid="take-photo"]')).not.toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
    fixture.destroy();
    expect(track.stop).toHaveBeenCalled();
  });

  it('stops the camera when the page is hidden', async () => {
    const { stream, track } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const fixture = await mount();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(track.stop).toHaveBeenCalled();
    expect(fixture.componentInstance.status()).toBe('paused');
    visibility.mockRestore();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Resume camera');
  });

  it('explains a denied permission and offers the camera-app file fallback', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const fixture = await mount();
    expect(fixture.componentInstance.status()).toBe('denied');
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="camera-message"]')?.textContent).toContain(
      'Camera access was denied',
    );
    const input = el.querySelector<HTMLInputElement>('[data-testid="file-input"]')!;
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('environment');
    expect(el.querySelector('[data-testid="take-photo"]')).toBeNull();
  });

  it('reports an insecure context without asking for the camera', async () => {
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
    const fixture = await mount();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(fixture.componentInstance.status()).toBe('insecure');
    expect(fixture.nativeElement.textContent).toContain('HTTPS');
    delete (globalThis as { isSecureContext?: boolean }).isSecureContext;
  });

  it('asks for the requested direction relative to walking and saves a file photo with its angle', async () => {
    getUserMedia.mockRejectedValue(new DOMException('none', 'NotFoundError'));
    const fixture = await mount(90);
    const cam = fixture.componentInstance;
    expect(cam.status()).toBe('no-camera');
    expect(cam.slot()).toBe('forward');
    expect(cam.instruction()).toBe('Face along the corridor towards Room 301.');
    const saved = vi.fn();
    cam.saved.subscribe(saved);
    cam.choose('left');
    expect(cam.angle()).toBe(0);
    const input = fixture.nativeElement.querySelector(
      '[data-testid="file-input"]',
    ) as HTMLInputElement;
    const file = new File(['img'], 'left.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(cam.still()).not.toBeNull();
    (
      fixture.nativeElement.querySelector('[data-testid="save-photo"]') as HTMLButtonElement
    ).click();
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'left', viewingAngleDeg: 0, blob: file }),
    );
    // The next missing slot is asked for; nothing claims to measure the phone's heading.
    expect(cam.slot()).toBe('forward');
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('orientation is not');
  });
});
