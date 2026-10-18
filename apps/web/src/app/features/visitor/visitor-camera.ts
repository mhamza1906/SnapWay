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
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, Subject, takeUntil, timeout } from 'rxjs';
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
        <img
          [src]="nativePreview()"
          [alt]="
            live() ? 'Live rear camera preview' : 'Camera check — Take photo captures a fresh image'
          "
        />
        @if (!live()) {
          <small>Camera check. Take photo captures a fresh image.</small>
        }
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
        @if (native && error().toLowerCase().includes('camera')) {
          <button class="settings" (click)="openSettings()">Open app permissions</button>
        }
      }
      <button class="take" (click)="take()" [disabled]="busy() || live()">
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
      @if (live()) {
        <button class="take stop" (click)="stopLive()">Stop live matching</button>
        <p role="status">{{ liveMessage() }}</p>
      } @else {
        <button class="take live" (click)="startLive()" [disabled]="busy() || !ready()">
          Start live matching
        </button>
      }
      <small
        >Live matching sends up to one frame per second while this screen is open. No video or audio
        is recorded.</small
      >
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
      .live,
      .stop {
        margin-top: 10px;
      }
      .stop {
        background: #8d3d35;
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
  readonly publicationId = input('');
  readonly closed = output<void>();
  readonly matched = output<MatchResult>();
  readonly liveMatched = output<MatchResult>();
  readonly live = signal(false);
  readonly liveMessage = signal('Hold steady near a sign or landmark.');
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
  private browserStartedAt = 0;
  /** A new camera run must wait until the previous run has stopped and its cache is clear. */
  private nativeCleanup: Promise<void> = Promise.resolve();
  private destroyed = false;
  private listener?: PluginListenerHandle;
  private captureTimeout?: ReturnType<typeof setTimeout>;
  private rejectCapture?: (error: Error) => void;
  private liveTimer?: ReturnType<typeof setTimeout>;
  private liveListener?: PluginListenerHandle;
  private stateListener?: PluginListenerHandle;
  private requestBusy = false;
  private run = 0;
  private capability?: { token: string; publication: string };
  private readonly cancelRequests = new Subject<void>();
  private readonly pauseLive = () => {
    if (document.hidden || !navigator.onLine) {
      this.stopLive();
      this.liveMessage.set(
        'Live matching stopped. Return online and tap Start live matching to continue.',
      );
    }
  };
  private readonly previousFocus = document.activeElement as HTMLElement | null;

  constructor() {
    document.addEventListener('visibilitychange', this.pauseLive);
    window.addEventListener('offline', this.pauseLive);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.stopLive();
      this.stop();
      document.removeEventListener('visibilitychange', this.pauseLive);
      window.removeEventListener('offline', this.pauseLive);
      this.cancelRequests.complete();
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
      const frame = await this.nativeFrame();
      if (!this.destroyed) {
        this.nativePreview.set(frame.preview ?? '');
        this.ready.set(true);
        await this.device.frames.discardFrame({ clientFrameId: frame.client_frame_id });
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
      if (this.destroyed || document.hidden) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.browserStartedAt = performance.now();
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
  private queueNativeCleanup(clearFrames = false): Promise<void> {
    this.nativeCleanup = this.nativeCleanup.then(async () => {
      await this.device.frames.stop().catch(() => undefined);
      if (clearFrames) await this.device.frames.deleteFrames().catch(() => undefined);
    });
    return this.nativeCleanup;
  }
  private stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    clearTimeout(this.captureTimeout);
    this.rejectCapture?.(new Error('Capture cancelled.'));
    this.rejectCapture = undefined;
    void this.listener?.remove();
    if (this.native) void this.queueNativeCleanup();
  }
  private async nativeFrame(): Promise<CapturedFrame> {
    const run = this.run;
    await this.nativeCleanup;
    if (this.destroyed || run !== this.run) throw new Error('Capture cancelled.');
    const permission = await this.device.frames.requestPermission();
    if (this.destroyed || run !== this.run) throw new Error('Capture cancelled.');
    if (permission.camera !== 'authorized')
      throw new Error('Allow camera access in Settings, then try again.');
    return new Promise<CapturedFrame>((resolve, reject) => {
      this.rejectCapture = reject;
      this.captureTimeout = setTimeout(() => {
        this.rejectCapture = undefined;
        this.stop();
        reject(new Error('The camera timed out. Please try again.'));
      }, 15000);
      void this.device.frames
        .addListener('frame', (frame) => {
          if (this.destroyed || run !== this.run) return;
          clearTimeout(this.captureTimeout);
          this.rejectCapture = undefined;
          void this.queueNativeCleanup();
          void this.listener?.remove();
          resolve(frame);
        })
        .then(async (listener) => {
          this.listener = listener;
          await this.nativeCleanup;
          if (this.destroyed || run !== this.run) {
            clearTimeout(this.captureTimeout);
            this.rejectCapture = undefined;
            await listener.remove();
            reject(new Error('Capture cancelled.'));
            return;
          }
          await this.device.frames.start({ fps: 0.5 });
        })
        .catch((error) => {
          clearTimeout(this.captureTimeout);
          this.rejectCapture = undefined;
          reject(error);
        });
    });
  }
  private async captureBlob(frame?: CapturedFrame): Promise<Blob> {
    if (frame) {
      const { dataUrl } = await this.device.frames.readFrame({
        clientFrameId: frame.client_frame_id,
      });
      const encoded = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/)?.[1];
      if (!encoded) throw new Error('The camera returned an invalid image.');
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      return new Blob([bytes], { type: 'image/jpeg' });
    }
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
    if (!blob) throw new Error('Could not capture a camera image.');
    return blob;
  }
  private async matchFrame(provided?: CapturedFrame, run = this.run): Promise<MatchResult> {
    const frame = provided ?? (this.native ? await this.nativeFrame() : undefined);
    try {
      const sampledAt = performance.now();
      const capturedAt = new Date().toISOString();
      const blob = await this.captureBlob(frame);
      if (this.destroyed || run !== this.run) throw new Error('Capture cancelled.');
      const form = new FormData();
      form.append('image', blob, 'location.jpg');
      form.append(
        'meta',
        JSON.stringify({
          client_frame_id: frame?.client_frame_id ?? Date.now(),
          captured_at: frame?.captured_at ?? capturedAt,
          timestamp_s:
            frame?.timestamp_s ?? Math.max(0, (sampledAt - this.browserStartedAt) / 1000),
          source: 'camera',
          orientation: frame?.orientation ?? 'unknown',
        }),
      );
      let headers: Record<string, string> = {};
      const publication = this.publicationId();
      if (publication) {
        if (this.capability?.publication !== publication) {
          const session = await firstValueFrom(
            this.http
              .post<{ token: string }>('/api/navigation/sessions/', {
                publication_id: publication,
              })
              .pipe(timeout(10000), takeUntil(this.cancelRequests)),
          );
          if (this.destroyed || run !== this.run) throw new Error('Capture cancelled.');
          this.capability = { token: session.token, publication };
        }
        headers = { Authorization: `Navigation ${this.capability.token}` };
      }
      const body = await firstValueFrom(
        this.http
          .post<unknown>('/api/navigation/localize/', form, { headers })
          .pipe(timeout(30000), takeUntil(this.cancelRequests)),
      );
      if (this.destroyed || run !== this.run) throw new Error('Capture cancelled.');
      const outcome = parseMatchResponse(
        { status: 200, body: JSON.stringify(body), roundTripMs: 0 },
        frame?.client_frame_id ?? 0,
      );
      if (outcome.kind === 'error') throw new Error(outcome.message);
      return outcome.result;
    } catch (error) {
      if (error instanceof HttpErrorResponse && [401, 403].includes(error.status))
        this.capability = undefined;
      throw error;
    } finally {
      if (frame)
        await this.device.frames
          .discardFrame({ clientFrameId: frame.client_frame_id })
          .catch(() => undefined);
    }
  }
  async startLive() {
    if (this.live() || this.busy() || !this.ready() || this.destroyed) return;
    if (document.hidden || !navigator.onLine) {
      this.error.set('Return to the app with an internet connection to start live matching.');
      return;
    }
    this.error.set('');
    this.live.set(true);
    const run = ++this.run;
    this.liveMessage.set('Looking for a supported location…');
    try {
      if (this.native) {
        await this.nativeCleanup;
        if (this.destroyed || !this.live() || run !== this.run) return;
        const permission = await this.device.frames.requestPermission();
        if (permission.camera !== 'authorized')
          throw new Error('Allow camera access in Settings, then try again.');
        if (!this.live() || run !== this.run) return;
        const liveListener = await this.device.frames.addListener('frame', (frame) => {
          if (run !== this.run || !this.live() || this.destroyed) {
            void this.device.frames.discardFrame({ clientFrameId: frame.client_frame_id });
            return;
          }
          this.nativePreview.set(frame.preview ?? '');
          void this.processLiveFrame(run, frame);
        });
        if (this.destroyed || !this.live() || run !== this.run) {
          await liveListener.remove();
          return;
        }
        this.liveListener = liveListener;
        const stateListener = await this.device.frames.addListener('state', (state) => {
          if (run === this.run && !state.capturing && this.live()) {
            this.stopLive();
            this.liveMessage.set('Camera stopped. Tap Start live matching to continue.');
          }
        });
        if (this.destroyed || !this.live() || run !== this.run) {
          await liveListener.remove();
          await stateListener.remove();
          return;
        }
        this.stateListener = stateListener;
        await this.nativeCleanup;
        if (this.destroyed || !this.live() || run !== this.run) return;
        // Leave headroom below the shared 60/min API budget for session and route requests.
        await this.device.frames.start({ fps: 0.8 });
      } else {
        await this.processLiveFrame(run);
      }
    } catch (error) {
      if (run === this.run) {
        this.error.set(error instanceof Error ? error.message : 'Could not start live matching.');
        this.stopLive();
      }
    }
  }
  private async processLiveFrame(run: number, frame?: CapturedFrame) {
    if (this.requestBusy || !this.live() || run !== this.run) {
      if (frame) void this.device.frames.discardFrame({ clientFrameId: frame.client_frame_id });
      if (!this.native && this.live() && run === this.run)
        this.liveTimer = setTimeout(() => void this.processLiveFrame(run), 1250);
      return;
    }
    this.requestBusy = true;
    try {
      const result = await this.matchFrame(frame, run);
      if (!this.live() || this.destroyed || run !== this.run) return;
      if (result.decision.outcome === 'likely_match') {
        this.liveMessage.set(
          `Likely location: ${result.matched_node?.label ?? result.decision.location_id ?? 'supported point'}`,
        );
        this.liveMatched.emit(result);
      } else {
        this.liveMessage.set('Location uncertain. Hold steady near a different sign or landmark.');
      }
    } catch (error) {
      if (this.live() && run === this.run) {
        if (error instanceof HttpErrorResponse) {
          const outcome = parseMatchResponse(
            { status: error.status, body: JSON.stringify(error.error), roundTripMs: 0 },
            frame?.client_frame_id ?? 0,
          );
          if (outcome.kind === 'error') this.error.set(outcome.message);
          // Setup/auth failures need user action, rather than a retry every second.
          if ([401, 403, 409, 429, 502, 503].includes(error.status)) this.stopLive();
        } else
          this.error.set(error instanceof Error ? error.message : 'Photo matching is unavailable.');
      }
    } finally {
      this.requestBusy = false;
      if (!this.native && this.live() && run === this.run)
        this.liveTimer = setTimeout(() => void this.processLiveFrame(run), 1250);
    }
  }
  openSettings() {
    if (this.native) void this.device.frames.openSettings();
  }
  stopLive() {
    this.run++;
    this.live.set(false);
    clearTimeout(this.captureTimeout);
    this.rejectCapture?.(new Error('Capture cancelled.'));
    this.rejectCapture = undefined;
    void this.listener?.remove();
    clearTimeout(this.liveTimer);
    this.cancelRequests.next();
    void this.liveListener?.remove();
    this.liveListener = undefined;
    void this.stateListener?.remove();
    this.stateListener = undefined;
    if (this.native) {
      void this.queueNativeCleanup(true);
    } else {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = undefined;
      this.ready.set(false);
    }
  }
  async take() {
    if (this.busy() || this.live()) return;
    if (!this.ready()) {
      if (this.native) await this.openNativeCamera();
      else await this.openBrowserCamera();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.matchFrame();
      if (!this.destroyed) {
        if (result.decision.outcome !== 'likely_match')
          this.error.set('We could not locate you clearly. Try another door sign or landmark.');
        else this.matched.emit(result);
      }
    } catch (error) {
      if (!this.destroyed) {
        if (error instanceof HttpErrorResponse) {
          const outcome = parseMatchResponse(
            { status: error.status, body: JSON.stringify(error.error), roundTripMs: 0 },
            1,
          );
          if (outcome.kind === 'error') this.error.set(outcome.message);
        } else {
          this.error.set(
            error instanceof Error
              ? error.message
              : 'Photo matching is unavailable. Please try again later.',
          );
        }
      }
    } finally {
      if (!this.destroyed) {
        this.busy.set(false);
        this.stop();
        this.ready.set(false);
      }
    }
  }
}
