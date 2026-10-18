import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  FrameCapture,
  nativeCaptureAvailable,
  type CapturedFrame,
  type FrameCapturePlugin,
} from '../../core/frame-capture';
import { parseMatchResponse, type MatchResult } from '../../core/place-match';
import { Icon } from '../../shared/icon';

export const VISITOR_CAPTURE_DEVICE = new InjectionToken<{
  native: boolean;
  frames: FrameCapturePlugin;
}>('Visitor capture device', {
  providedIn: 'root',
  factory: () => ({ native: nativeCaptureAvailable(), frames: FrameCapture }),
});

@Component({
  selector: 'app-visitor-camera',
  imports: [Icon],
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `<div class="shade">
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="camera-title"
      tabindex="-1"
      #dialog
      (keydown)="trapFocus($event)"
    >
      <button class="close" (click)="closed.emit()" aria-label="Close camera">
        <app-icon name="close" />
      </button>
      <span class="symbol"><app-icon name="camera" /></span>
      <h2 id="camera-title">Show us where you are</h2>
      @if (!native) {
        <video #video autoplay playsinline muted aria-label="Camera preview"></video>
      } @else if (nativePreview()) {
        <img [src]="nativePreview()" alt="Camera check — Take photo captures a fresh image" />
        <small>Camera check. Take photo captures a fresh image.</small>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      <button class="take" (click)="take()" [disabled]="busy()">
        {{
          busy()
            ? opening()
              ? 'Opening camera…'
              : 'Finding your location…'
            : !ready()
              ? 'Open camera'
              : 'Take photo'
        }}
      </button>
      <small>Keep a nearby sign or landmark clearly in view and hold your phone steady.</small>
    </section>
  </div>`,
  styles: [
    `
      :host {
        position: fixed;
        inset: 0;
        z-index: 200;
      }
      .shade {
        height: 100%;
        background: #172a255f;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
          max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
      }
      section {
        position: relative;
        width: min(100%, 640px);
        max-height: 100%;
        overflow: auto;
        background: #fff;
        border-radius: 24px;
        padding: 20px 20px 18px;
        text-align: center;
      }
      section:focus {
        outline: none;
      }
      .close {
        position: absolute;
        right: 16px;
        top: 16px;
        border: 0;
        background: #f1f3ef;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        display: grid;
        place-items: center;
      }
      .symbol {
        display: grid;
        place-items: center;
        margin: 0 auto 8px;
        width: 32px;
        height: 32px;
        background: #e8efe7;
        border-radius: 18px;
        color: #305a45;
      }
      h2 {
        font-size: 23px;
        margin-bottom: 10px;
      }
      p {
        color: #68766b;
        font-size: 14px;
      }
      video,
      img {
        display: block;
        width: 100%;
        height: clamp(160px, calc(100dvh - 270px), 560px);
        object-fit: cover;
        border-radius: 18px;
        background: #172a25;
        margin-bottom: 16px;
      }
      .take {
        min-height: 52px;
        width: 100%;
        border: 0;
        border-radius: 16px;
        background: #315b46;
        color: white;
        font-weight: 600;
      }
      small {
        display: block;
        font-size: 11px;
        color: #758177;
        margin: 14px 0 0;
        line-height: 1.5;
      }
      .error {
        color: #a13b35;
      }
    `,
  ],
})
export class VisitorCamera implements AfterViewInit {
  private readonly device = inject(VISITOR_CAPTURE_DEVICE);
  readonly demo = input(false);
  readonly captured = output<void>();
  readonly closed = output<void>();
  readonly matched = output<MatchResult>();
  readonly native = this.device.native;
  readonly ready = signal(false);
  readonly busy = signal(false);
  readonly opening = signal(false);
  readonly nativePreview = signal('');
  readonly error = signal('');
  readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');
  private readonly http = inject(HttpClient);
  private stream?: MediaStream;
  private destroyed = false;
  private listener?: PluginListenerHandle;
  private captureTimeout?: ReturnType<typeof setTimeout>;
  private rejectCapture?: (error: Error) => void;
  private readonly previousFocus = document.activeElement as HTMLElement | null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.stop();
      this.previousFocus?.focus();
    });
  }
  ngAfterViewInit() {
    this.dialog().nativeElement.focus();
    if (this.native) void this.openNativeCamera();
    else void this.openBrowserCamera();
  }
  private async openNativeCamera() {
    if (this.busy()) return;
    this.opening.set(true);
    this.busy.set(true);
    this.error.set('');
    try {
      const frame = await this.nativeFrame(false);
      if (!this.destroyed) {
        this.nativePreview.set(frame.preview ?? '');
        this.ready.set(true);
      }
    } catch (error) {
      if (!this.destroyed)
        this.error.set(
          error instanceof Error ? error.message : 'The camera could not open. Please try again.',
        );
    } finally {
      this.stop();
      if (!this.destroyed) {
        this.opening.set(false);
        this.busy.set(false);
      }
    }
  }
  private async openBrowserCamera() {
    if (this.busy()) return;
    this.busy.set(true);
    this.opening.set(true);
    this.error.set('');
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Camera access is unavailable on this device.');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      if (this.destroyed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video()!.nativeElement.srcObject = stream;
      await this.video()!.nativeElement.play();
      if (!this.destroyed) this.ready.set(true);
    } catch {
      if (!this.destroyed)
        this.error.set(
          'Camera access is unavailable. Allow camera permission in device settings, then reopen this screen.',
        );
    } finally {
      if (!this.destroyed) {
        this.opening.set(false);
        this.busy.set(false);
      }
    }
  }
  trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(
      this.dialog().nativeElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    );
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === this.dialog().nativeElement)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  private stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    clearTimeout(this.captureTimeout);
    this.rejectCapture?.(new Error('Capture cancelled.'));
    this.rejectCapture = undefined;
    void this.listener?.remove();
    if (this.native) void this.device.frames.stop().catch(() => undefined);
  }
  private async nativeFrame(requireMatching = true): Promise<CapturedFrame> {
    const permission = await this.device.frames.requestPermission();
    if (this.destroyed) throw new Error('Capture cancelled.');
    if (permission.camera !== 'authorized')
      throw new Error('Allow camera access in Settings, then try again.');
    const config = requireMatching ? await this.device.frames.getDevConfig() : null;
    if (this.destroyed) throw new Error('Capture cancelled.');
    if (requireMatching && (!config?.available || !config.hasToken))
      throw new Error('Photo matching is not available in this app build yet.');
    return new Promise<CapturedFrame>((resolve, reject) => {
      this.rejectCapture = reject;
      this.captureTimeout = setTimeout(() => {
        this.rejectCapture = undefined;
        this.stop();
        reject(new Error('The camera timed out. Please try again.'));
      }, 15000);
      void this.device.frames
        .addListener('frame', (frame) => {
          if (this.destroyed) return;
          clearTimeout(this.captureTimeout);
          this.rejectCapture = undefined;
          void this.device.frames.stop().catch(() => undefined);
          void this.listener?.remove();
          resolve(frame);
        })
        .then(async (listener) => {
          this.listener = listener;
          if (this.destroyed) {
            await listener.remove();
            reject(new Error('Capture cancelled.'));
            return;
          }
          await this.device.frames.start({ fps: 0.5 });
        })
        .catch(reject);
    });
  }
  async take() {
    if (this.busy()) return;
    if (!this.ready()) {
      if (this.native) await this.openNativeCamera();
      else await this.openBrowserCamera();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      let result: MatchResult;
      if (this.native) {
        const frame = await this.nativeFrame(!this.demo());
        if (this.destroyed) return;
        if (this.demo()) {
          this.captured.emit();
          return;
        }
        const http = await this.device.frames.uploadFrame({
          clientFrameId: frame.client_frame_id,
          backend: 'auto',
          verify: false,
          secondOpinion: false,
        });
        const outcome = parseMatchResponse(http, frame.client_frame_id);
        if (outcome.kind === 'error') throw new Error(outcome.message);
        result = outcome.result;
      } else {
        const video = this.video()!.nativeElement;
        if (!video.videoWidth) throw new Error('Wait for the camera preview, then try again.');
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.85),
        );
        if (!blob || this.destroyed) return;
        if (this.demo()) {
          this.captured.emit();
          return;
        }
        const form = new FormData();
        form.append('image', blob, 'location.jpg');
        form.append(
          'meta',
          JSON.stringify({
            client_frame_id: 1,
            captured_at: new Date().toISOString(),
            source: 'camera',
            orientation: 'unknown',
          }),
        );
        // Existing session/capability permissions remain authoritative.
        const body = await firstValueFrom(
          this.http.post<unknown>('/api/navigation/localize/', form).pipe(timeout(30000)),
        );
        const outcome = parseMatchResponse(
          { status: 200, body: JSON.stringify(body), roundTripMs: 0 },
          1,
        );
        if (outcome.kind === 'error') throw new Error(outcome.message);
        result = outcome.result;
      }
      if (!this.destroyed) {
        if (result.decision.outcome !== 'likely_match')
          this.error.set('We could not locate you clearly. Try another door sign or landmark.');
        else this.matched.emit(result);
      }
    } catch (error) {
      if (!this.destroyed)
        this.error.set(
          error instanceof Error
            ? error.message
            : 'Photo matching is unavailable. Please try again later.',
        );
    } finally {
      if (!this.destroyed) {
        this.busy.set(false);
        this.stop();
        this.ready.set(false);
      }
    }
  }
}
