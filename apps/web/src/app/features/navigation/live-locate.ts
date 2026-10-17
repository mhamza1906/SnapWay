import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  FrameCapture,
  type CameraStatus,
  type CapturedFrame,
  type DevConfig,
} from '../../core/frame-capture';
import {
  OUTCOME_LABEL,
  backendLabel,
  matchingCheckpoint,
  parseMatchResponse,
  similarity,
  type MatchBackend,
  type MatchOutcome,
} from '../../core/place-match';
import { Icon } from '../../shared/icon';

type View = 'loading' | 'explain' | 'blocked' | 'capture' | 'settings';
const KEEP_FRAMES = 6;

/** Real camera frames → place-match (iOS app only). Manual start selection stays available. */
@Component({
  selector: 'app-live-locate',
  imports: [Icon],
  templateUrl: './live-locate.html',
  styleUrl: './live-locate.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveLocate {
  readonly checkpoints = input<{ id: string; label: string }[]>([]);
  readonly closed = output<void>();
  readonly checkpoint = output<string>();

  readonly view = signal<View>('loading');
  readonly camera = signal<CameraStatus>('notDetermined');
  readonly cameraAvailable = signal(true);
  readonly debugBuild = signal(false);
  readonly capturing = signal(false);
  readonly fps = signal(1);
  readonly frames = signal<CapturedFrame[]>([]);
  readonly results = signal<Record<number, MatchOutcome>>({});
  readonly sending = signal<Record<number, boolean>>({});
  readonly autoSend = signal(false);
  readonly backend = signal<MatchBackend>('auto');
  readonly verify = signal(false);
  readonly secondOpinion = signal(false);
  readonly config = signal<DevConfig>({ available: false });
  readonly message = signal('');
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  readonly label = OUTCOME_LABEL;
  readonly similarity = similarity;
  readonly backendLabel = backendLabel;
  private handles: PluginListenerHandle[] = [];

  constructor() {
    const onOnline = () => this.online.set(navigator.onLine);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
      void FrameCapture.stop().catch(() => undefined);
      this.handles.forEach((handle) => void handle.remove());
    });
    void this.init();
  }

  private async init(): Promise<void> {
    this.handles.push(
      await FrameCapture.addListener('frame', (frame) => this.onFrame(frame)),
      await FrameCapture.addListener('state', (state) => {
        this.capturing.set(state.capturing);
        const reasons: Record<string, string> = {
          background: 'Capture stopped because the app went to the background.',
          interrupted: 'Capture stopped: the camera was interrupted.',
          thermal: 'Capture stopped to let the iPhone cool down.',
          camera_error: 'Capture stopped after a camera error.',
        };
        if (reasons[state.reason]) this.message.set(reasons[state.reason]);
      }),
    );
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const status = await FrameCapture.getStatus();
      this.camera.set(status.camera);
      this.cameraAvailable.set(status.cameraAvailable);
      this.debugBuild.set(status.debugBuild);
      this.capturing.set(status.capturing);
      this.config.set(await FrameCapture.getDevConfig());
      this.frames.set((await FrameCapture.listFrames()).frames.slice(-KEEP_FRAMES).reverse());
      this.view.set(
        status.camera === 'authorized'
          ? 'capture'
          : status.camera === 'notDetermined'
            ? 'explain'
            : 'blocked',
      );
    } catch {
      this.message.set('The camera module is unavailable in this build.');
      this.view.set('blocked');
    }
  }

  async allowCamera(): Promise<void> {
    const { camera } = await FrameCapture.requestPermission();
    this.camera.set(camera);
    this.view.set(camera === 'authorized' ? 'capture' : 'blocked');
  }

  openSettings(): void {
    void FrameCapture.openSettings();
  }

  async toggleCapture(): Promise<void> {
    this.message.set('');
    try {
      if (this.capturing()) {
        await FrameCapture.stop();
        this.capturing.set(false);
      } else {
        await FrameCapture.start({ fps: this.fps() });
        this.capturing.set(true);
      }
    } catch (error) {
      this.message.set(`Could not start the camera: ${(error as Error).message}`);
    }
  }

  setFps(value: string): void {
    const fps = Math.min(5, Math.max(0.5, Number(value) || 1));
    this.fps.set(fps);
    if (this.capturing()) void FrameCapture.start({ fps });
  }

  async importVideo(): Promise<void> {
    this.message.set('');
    try {
      const result = await FrameCapture.importVideo({ fps: this.fps() });
      if (!result.cancelled)
        this.message.set(
          `Extracted ${result.frames} frame${result.frames === 1 ? '' : 's'}` +
            (result.truncated ? ' (stopped at the frame limit).' : '.'),
        );
    } catch (error) {
      this.message.set(`Could not read the video: ${(error as Error).message}`);
    }
  }

  async deleteFrames(): Promise<void> {
    const { deleted } = await FrameCapture.deleteFrames();
    this.frames.set([]);
    this.results.set({});
    this.message.set(
      `Deleted ${deleted} captured frame${deleted === 1 ? '' : 's'} from this iPhone.`,
    );
  }

  private onFrame(frame: CapturedFrame): void {
    this.frames.update((list) => [frame, ...list].slice(0, KEEP_FRAMES));
    if (this.autoSend()) void this.send(frame);
  }

  canSend(): boolean {
    return this.online() && !!this.config().available && !!this.config().hasToken;
  }

  async send(frame: CapturedFrame): Promise<void> {
    const id = frame.client_frame_id;
    if (!this.canSend() || this.sending()[id]) return;
    this.sending.update((map) => ({ ...map, [id]: true }));
    try {
      const http = await FrameCapture.uploadFrame({
        clientFrameId: id,
        backend: this.backend(),
        verify: this.verify(),
        secondOpinion: this.secondOpinion(),
      });
      this.results.update((map) => ({ ...map, [id]: parseMatchResponse(http, id) }));
    } catch (error) {
      this.results.update((map) => ({
        ...map,
        [id]: { kind: 'error', clientFrameId: id, status: 0, message: (error as Error).message },
      }));
    } finally {
      this.sending.update((map) => ({ ...map, [id]: false }));
    }
  }

  suggestion(outcome: MatchOutcome | undefined) {
    if (outcome?.kind !== 'result' || outcome.result.decision.outcome !== 'likely_match') return;
    return matchingCheckpoint(outcome.result.decision.location_id, this.checkpoints());
  }

  async saveSettings(baseUrl: string, mode: string, token: string): Promise<void> {
    try {
      await FrameCapture.setDevConfig({
        baseUrl,
        mode: mode === 'snapway' ? 'snapway' : 'engine',
        token: token || undefined,
      });
      this.config.set(await FrameCapture.getDevConfig());
      this.message.set('Saved. The token is stored in the iOS Keychain.');
    } catch (error) {
      this.message.set((error as Error).message);
    }
  }

  async testConnection(): Promise<void> {
    try {
      const http = await FrameCapture.testConnection();
      if (http.status !== 200) {
        this.message.set(`Connection failed (HTTP ${http.status}).`);
        return;
      }
      const health = JSON.parse(http.body ?? '{}');
      const ready = Object.entries(health.backends ?? {})
        .filter(([, value]) => (value as { ready?: boolean }).ready)
        .map(([name]) => name);
      this.message.set(
        `Connected · set ${health.reference_set ?? '?'} · ready: ${ready.join(', ') || 'none'} · ` +
          `thresholds ${health.thresholds_id ?? '?'} · ${http.roundTripMs} ms`,
      );
    } catch (error) {
      this.message.set(`Connection failed: ${(error as Error).message}`);
    }
  }

  async clearSettings(): Promise<void> {
    await FrameCapture.clearDevConfig();
    this.config.set(await FrameCapture.getDevConfig());
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
