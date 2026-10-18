import { Component, ElementRef, OnDestroy, ViewChild, output, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

export interface CameraCandidate {
  timeSeconds: number;
  nodeId: string | null;
  candidateNodeId?: string;
  label?: string;
  status: 'candidate' | 'uncertain';
  similarity?: number;
  margin?: number;
  note?: string;
}

/** Foreground-only JPEG matching; never records a video or queues frames. */
@Component({
  selector: 'app-camera-lab',
  template: `
    <section class="camera-card">
      <h2>Live camera · original references</h2>
      <p>
        Match one camera frame at a time against your stored Level 1 photos. Keep the rear camera
        facing the corridor. No full video is recorded. Frames are sent to the local matching
        service for inference.
      </p>
      <div class="actions">
        <button (click)="start()" [disabled]="active()">Allow rear camera & start matching</button
        ><button (click)="stop()" [disabled]="!active()">Stop camera</button>
      </div>
      <video #preview autoplay muted playsinline [hidden]="!active()"></video>
      <p role="status" aria-live="polite">{{ message() }}</p>
      <p class="small">
        Visual candidates require your confirmation before moving the live map reference. Ambiguous
        frames leave your position unchanged. Camera access needs HTTPS and permission in this
        browser.
      </p>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .camera-card {
      margin: 20px 0;
      padding: 24px;
      background: white;
      border: 1px solid #dce5db;
      border-radius: 20px;
    }
    h2 {
      font-size: 22px;
      margin: 0 0 18px;
    }
    p {
      line-height: 1.6;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin: 18px 0;
    }
    button {
      min-height: 48px;
      padding: 11px 14px;
      border: 1px solid #cbd7cd;
      border-radius: 10px;
      color: #244c39;
      background: #f3f7f2;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    button:focus-visible {
      outline: 3px solid #d48a39;
      outline-offset: 3px;
    }
    video {
      width: 100%;
      max-height: 420px;
      background: #17241f;
      border-radius: 12px;
    }
    .small {
      font-size: 13px;
      color: #617365;
    }
    @media (max-width: 520px) {
      .camera-card {
        padding: 18px;
      }
      .actions button {
        flex: 1 1 150px;
      }
    }
  `,
})
export class CameraLab implements OnDestroy {
  @ViewChild('preview', { static: true }) preview!: ElementRef<HTMLVideoElement>;
  readonly candidate = output<CameraCandidate>();
  readonly active = signal(false);
  readonly message = signal('Camera is off.');
  private stream: MediaStream | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly hidden = () => {
    if (document.hidden) this.stop('Camera paused while this page is hidden.');
  };

  constructor() {
    document.addEventListener('visibilitychange', this.hidden);
  }

  async start(): Promise<void> {
    if (this.active()) return;
    if (Capacitor.isNativePlatform()) {
      this.message.set(
        'This isolated camera test is wired to the HTTPS browser preview. Open the test link in Safari or Chrome; it is not connected to the native camera build.',
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.message.set(
        'Camera is unavailable. Open this test in an HTTPS browser with camera support.',
      );
      return;
    }
    const generation = ++this.generation;
    this.controller = new AbortController();
    const controller = this.controller;
    this.active.set(true);
    this.message.set('Requesting rear camera permission…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (!this.current(generation)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.preview.nativeElement.srcObject = stream;
      await this.preview.nativeElement.play();
      const response = await fetch('/experiment-api/session', {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Local matching session is unavailable.');
      const session = (await response.json()) as { sessionId: string };
      if (
        !session.sessionId ||
        typeof session.sessionId !== 'string' ||
        session.sessionId.length > 256
      )
        throw new Error('Invalid matching session.');
      if (this.current(generation)) await this.match(generation, session.sessionId, controller);
    } catch (error) {
      if (this.current(generation))
        this.stop(
          error instanceof Error ? error.message : 'Camera permission or matching service failed.',
        );
    }
  }

  private current(generation: number): boolean {
    return this.active() && generation === this.generation && !document.hidden;
  }

  private async match(
    generation: number,
    sessionId: string,
    controller: AbortController,
  ): Promise<void> {
    if (!this.current(generation)) return;
    try {
      const video = this.preview.nativeElement;
      if (!video.videoWidth || !video.videoHeight) throw new Error('Waiting for camera frames.');
      const canvas = document.createElement('canvas');
      const ratio = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * ratio);
      canvas.height = Math.round(video.videoHeight * ratio);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Camera frame conversion is unavailable.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.8),
      );
      if (!this.current(generation)) return;
      if (!jpeg) throw new Error('Could not prepare this camera frame.');
      this.message.set('Matching one current frame…');
      const response = await fetch('/experiment-api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Lab-Session': sessionId },
        body: jpeg,
        signal: controller.signal,
      });
      if (response.status === 429) {
        this.message.set('Matching service is busy; skipping this frame.');
      } else {
        if (!response.ok)
          throw new Error(
            response.status === 503
              ? 'Matching model is unavailable. Camera stopped; try again when the local service is ready.'
              : `Frame matching failed (${response.status}).`,
          );
        const candidate = (await response.json()) as CameraCandidate;
        if (
          !['candidate', 'uncertain'].includes(candidate.status) ||
          !Number.isFinite(candidate.timeSeconds) ||
          candidate.timeSeconds < 0 ||
          (candidate.similarity !== undefined &&
            (!Number.isFinite(candidate.similarity) || Math.abs(candidate.similarity) > 1)) ||
          (candidate.margin !== undefined &&
            (!Number.isFinite(candidate.margin) || candidate.margin < 0 || candidate.margin > 2)) ||
          (candidate.nodeId !== null && typeof candidate.nodeId !== 'string')
        )
          throw new Error('Invalid visual matching response.');
        if (!this.current(generation)) return;
        this.candidate.emit(candidate);
        this.message.set(
          candidate.status === 'uncertain'
            ? 'Ambiguous frame: position held. Keep moving and face a distinctive corridor landmark.'
            : `Candidate: ${candidate.label || 'stored reference'}. Confirm the point on the map if it matches your surroundings.`,
        );
      }
      if (this.current(generation))
        this.timer = setTimeout(() => void this.match(generation, sessionId, controller), 1250);
    } catch (error) {
      if (this.current(generation))
        this.stop(error instanceof Error ? error.message : 'Frame matching failed.');
    }
  }

  stop(message = 'Camera stopped. No video was recorded.'): void {
    this.generation++;
    this.active.set(false);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.preview?.nativeElement.srcObject) {
      this.preview.nativeElement.pause();
      this.preview.nativeElement.srcObject = null;
    }
    this.message.set(message);
  }

  ngOnDestroy(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.hidden);
  }
}
