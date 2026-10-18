import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { IOSPose } from './ios-pose-model';

export interface IOSCapturedPoseFrame {
  jpegBase64: string;
  timestamp: number;
  monotonicSeconds: number;
  epoch: string;
  pose: { x: number; y: number; z: number; yawRadians?: number };
}
export interface IOSPoseStatus {
  message: string;
  tracking?: string;
  epoch?: string;
}
interface PoseBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  captureFrame(): Promise<IOSCapturedPoseFrame>;
  addListener(event: string, callback: (value: never) => void): Promise<PluginListenerHandle>;
}
const bridge = registerPlugin<PoseBridge>('IndoorPose');
let owner: IndoorPoseSession | undefined;
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.catch(() => undefined);
  return result;
}

/** Owns the single ARKit camera session. Never starts sensors during construction. */
export class IndoorPoseSession {
  readonly available = Capacitor.getPlatform() === 'ios';
  private generation = 0;
  private handles: PluginListenerHandle[] = [];
  private active = false;
  constructor(
    private readonly callbacks: { pose(value: IOSPose): void; status(value: IOSPoseStatus): void },
  ) {}

  async start(): Promise<void> {
    if (!this.available)
      throw new Error(
        'ARKit requires the native iPhone test app. Safari and Android are not connected to this experiment.',
      );
    if (document.hidden) throw new Error('Keep the app open before starting ARKit.');
    const generation = ++this.generation;
    this.active = true;
    await serial(async () => {
      if (!this.current(generation)) return;
      const previous = owner;
      if (previous) {
        previous.active = false;
        owner = undefined;
        await bridge.stop();
      }
      if (!this.current(generation)) return;
      owner = this;
      for (const event of ['pose', 'status'] as const) {
        const handle = await bridge.addListener(event, (value: never) => {
          if (owner === this && this.current(generation)) this.callbacks[event](value);
        });
        if (!this.current(generation)) {
          await handle.remove();
          return;
        }
        this.handles.push(handle);
      }
      if (!this.current(generation)) return;
      await bridge.start();
    });
  }
  private current(generation: number): boolean {
    return this.active && generation === this.generation && !document.hidden;
  }
  async captureFrame(): Promise<IOSCapturedPoseFrame> {
    const generation = this.generation;
    if (owner !== this || !this.current(generation))
      throw new Error('Start ARKit before matching a frame.');
    const frame = await bridge.captureFrame();
    if (owner !== this || !this.current(generation))
      throw new Error('This camera session has stopped.');
    return frame;
  }
  async stop(): Promise<void> {
    this.generation++;
    this.active = false;
    const handles = this.handles.splice(0);
    // Do not put stop behind a pending camera-permission promise: native stop cancels it.
    const stopping = owner === this ? bridge.stop() : Promise.resolve();
    if (owner === this) owner = undefined;
    await Promise.allSettled([stopping, ...handles.map((handle) => handle.remove())]);
  }
  async dispose(): Promise<void> {
    await this.stop();
  }
}
