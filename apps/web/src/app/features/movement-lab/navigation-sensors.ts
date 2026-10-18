import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface LocationReading {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}
export interface HeadingReading {
  degrees: number;
  timestamp: number;
  reference: 'relative' | 'absolute';
}
export interface StepsReading {
  total: number;
  source: 'native' | 'browser-estimate';
  timestamp: number;
}
export interface SensorCallbacks {
  location(value: LocationReading): void;
  heading(value: HeadingReading): void;
  steps(value: StepsReading): void;
  state(value: { message: string }): void;
}
interface NativeSensors {
  startLocation(): Promise<void>;
  startMotion(): Promise<void>;
  stop(): Promise<void>;
  addListener(event: string, callback: (value: never) => void): Promise<PluginListenerHandle>;
}
const native = registerPlugin<NativeSensors>('NavigationSensors');
// The native bridge is process-wide. Serialize starts/stops across screen instances.
let nativeOwner: NavigationSensors | undefined;
let nativeQueue: Promise<unknown> = Promise.resolve();
function nativeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeQueue.then(operation, operation);
  nativeQueue = result.catch(() => undefined);
  return result;
}

/** Conservative peak detector, an estimate rather than a hardware pedometer. Units: m/s². */
export class BrowserStepDetector {
  private gravity = 9.81;
  private above = false;
  private lastStep = -Infinity;
  private lastTime = -Infinity;
  private total = 0;
  sample(x: number, y: number, z: number, timestamp: number): number {
    if (![x, y, z, timestamp].every(Number.isFinite) || timestamp <= this.lastTime)
      return this.total;
    this.lastTime = timestamp;
    const magnitude = Math.hypot(x, y, z);
    this.gravity = 0.9 * this.gravity + 0.1 * magnitude;
    const high = magnitude - this.gravity;
    if (high > 1.25 && !this.above && timestamp - this.lastStep >= 320) {
      this.total++;
      this.lastStep = timestamp;
      this.above = true;
    } else if (high < 0.35) this.above = false;
    return this.total;
  }
}

type PermissionEvent = { requestPermission?: () => Promise<string> };

/** Foreground-only, opt-in sensor bridge. No reading is stored or uploaded. */
export class NavigationSensors {
  readonly source = Capacitor.isNativePlatform() ? 'native' : 'browser-estimate';
  private generation = 0;
  private handles: PluginListenerHandle[] = [];
  private listening?: Promise<void>;
  private watch?: number;
  private detector = new BrowserStepDetector();
  private total = 0;
  private motionActive = false;
  constructor(private callbacks: SensorCallbacks) {
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('pagehide', this.pagehide);
  }
  private visibility = () => {
    if (document.hidden) void this.stop();
  };
  private pagehide = () => {
    void this.stop();
  };
  private active(generation: number): boolean {
    return generation === this.generation && !document.hidden;
  }
  private async listen(): Promise<void> {
    if (this.listening) return this.listening;
    const generation = this.generation;
    this.listening = (async () => {
      for (const event of ['location', 'heading', 'steps', 'state'] as const) {
        const handle = await native.addListener(event, (value: never) => {
          if (this.active(generation) && nativeOwner === this) this.callbacks[event](value);
        });
        if (!this.active(generation)) {
          await handle.remove();
          return;
        }
        this.handles.push(handle);
      }
    })();
    return this.listening;
  }
  async startLocation(): Promise<void> {
    const generation = this.generation;
    if (document.hidden) throw new Error('Open this screen before starting GPS.');
    if (Capacitor.isNativePlatform()) {
      await this.listen();
      await nativeOperation(async () => {
        if (!this.active(generation)) return;
        if (nativeOwner && nativeOwner !== this) await native.stop();
        if (!this.active(generation)) return;
        nativeOwner = this;
        await native.startLocation();
      });
      return;
    }
    if (!navigator.geolocation) throw new Error('GPS is unavailable in this browser.');
    if (this.watch !== undefined) return;
    this.watch = navigator.geolocation.watchPosition(
      (position) => {
        if (this.active(generation))
          this.callbacks.location({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
          });
      },
      (error) => {
        if (this.active(generation)) this.callbacks.state({ message: `GPS: ${error.message}` });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }
  async startMotion(): Promise<void> {
    const generation = this.generation;
    if (document.hidden) throw new Error('Open this screen before starting motion.');
    if (Capacitor.isNativePlatform()) {
      await this.listen();
      await nativeOperation(async () => {
        if (!this.active(generation)) return;
        if (nativeOwner && nativeOwner !== this) await native.stop();
        if (!this.active(generation)) return;
        nativeOwner = this;
        await native.startMotion();
      });
      return;
    }
    if (this.motionActive) return;
    if (!('DeviceMotionEvent' in window))
      throw new Error('Motion sensors are unavailable in this browser.');
    // Invoke both requests synchronously in the initiating tap, before the first await.
    const motionPermission = (
      window.DeviceMotionEvent as unknown as PermissionEvent
    ).requestPermission?.();
    const orientationPermission = (
      window.DeviceOrientationEvent as unknown as PermissionEvent | undefined
    )?.requestPermission?.();
    const results = await Promise.all([motionPermission, orientationPermission]);
    if (!this.active(generation)) return;
    if (results.some((result) => result === 'denied'))
      throw new Error('Allow motion and orientation access in browser settings.');
    this.motionActive = true;
    this.detector = new BrowserStepDetector();
    this.total = 0;
    window.addEventListener('devicemotion', this.motion);
    window.addEventListener('deviceorientation', this.orientation);
    this.callbacks.state({
      message:
        'Browser steps are approximate. Hold the phone steadily; heading may need calibration.',
    });
  }
  private motion = (event: DeviceMotionEvent) => {
    if (document.hidden || !this.motionActive) return;
    const value = event.accelerationIncludingGravity;
    if (!value || value.x == null || value.y == null || value.z == null) return;
    const timestamp = performance.now();
    const total = this.detector.sample(value.x, value.y, value.z, timestamp);
    if (total > this.total) {
      this.total = total;
      this.callbacks.steps({ total, timestamp: Date.now(), source: 'browser-estimate' });
    }
  };
  private orientation = (event: DeviceOrientationEvent) => {
    if (document.hidden || !this.motionActive) return;
    const compass = (event as DeviceOrientationEvent & { webkitCompassHeading?: number })
      .webkitCompassHeading;
    const degrees = compass ?? (event.alpha == null ? NaN : 360 - event.alpha);
    if (Number.isFinite(degrees))
      this.callbacks.heading({
        degrees: ((degrees % 360) + 360) % 360,
        timestamp: Date.now(),
        reference: compass !== undefined || event.absolute ? 'absolute' : 'relative',
      });
  };
  async stop(): Promise<void> {
    this.generation++;
    this.motionActive = false;
    if (this.watch !== undefined) navigator.geolocation.clearWatch(this.watch);
    this.watch = undefined;
    window.removeEventListener('devicemotion', this.motion);
    window.removeEventListener('deviceorientation', this.orientation);
    const handles = this.handles.splice(0);
    this.listening = undefined;
    const stopping = Capacitor.isNativePlatform()
      ? nativeOperation(async () => {
          if (nativeOwner === this) {
            await native.stop();
            nativeOwner = undefined;
          }
        })
      : Promise.resolve();
    await Promise.allSettled([...handles.map((handle) => handle.remove()), stopping]);
  }
  async dispose(): Promise<void> {
    document.removeEventListener('visibilitychange', this.visibility);
    window.removeEventListener('pagehide', this.pagehide);
    await this.stop();
  }
}
