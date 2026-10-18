import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserStepDetector, NavigationSensors, type SensorCallbacks } from './navigation-sensors';

const bridge = vi.hoisted(() => ({
  native: false,
  plugin: {
    startLocation: vi.fn<() => Promise<void>>(async () => undefined),
    startMotion: vi.fn<() => Promise<void>>(async () => undefined),
    stop: vi.fn<() => Promise<void>>(async () => undefined),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  },
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => bridge.native },
  registerPlugin: () => bridge.plugin,
}));

const callbacks = (): SensorCallbacks => ({
  location: vi.fn(),
  heading: vi.fn(),
  steps: vi.fn(),
  state: vi.fn(),
});
const sessions: NavigationSensors[] = [];
function session(): NavigationSensors {
  const value = new NavigationSensors(callbacks());
  sessions.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((value) => value.dispose()));
  bridge.native = false;
  vi.clearAllMocks();
});

describe('BrowserStepDetector', () => {
  it('does not count stationary samples, invalid data, or duplicate timestamps', () => {
    const detector = new BrowserStepDetector();
    for (let time = 0; time < 10000; time += 20) expect(detector.sample(0, 0, 9.81, time)).toBe(0);
    expect(detector.sample(NaN, 0, 20, 10000)).toBe(0);
    expect(detector.sample(0, 0, 20, 0)).toBe(0);
  });
  it('counts separated peaks but suppresses a ringing peak and excessive cadence', () => {
    const detector = new BrowserStepDetector();
    expect(detector.sample(0, 0, 9.81, 0)).toBe(0);
    expect(detector.sample(0, 0, 13, 500)).toBe(1);
    expect(detector.sample(0, 0, 14, 520)).toBe(1);
    expect(detector.sample(0, 0, 9, 540)).toBe(1);
    expect(detector.sample(0, 0, 13, 600)).toBe(1);
    detector.sample(0, 0, 9, 700);
    expect(detector.sample(0, 0, 13, 1000)).toBe(2);
  });
});

describe('NavigationSensors lifecycle', () => {
  it('starts no sensors during construction', () => {
    session();
    expect(bridge.plugin.startLocation).not.toHaveBeenCalled();
    expect(bridge.plugin.startMotion).not.toHaveBeenCalled();
  });
  it('clears the GPS watch on stop', async () => {
    const clearWatch = vi.fn();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { watchPosition: vi.fn(() => 17), clearWatch },
    });
    const value = session();
    await value.startLocation();
    await value.stop();
    expect(clearWatch).toHaveBeenCalledWith(17);
  });
  it('does not let delayed disposal stop the newer native owner', async () => {
    bridge.native = true;
    const first = session();
    const second = session();
    await first.startMotion();
    await second.startMotion();
    expect(bridge.plugin.stop).toHaveBeenCalledTimes(1);
    await first.dispose();
    expect(bridge.plugin.stop).toHaveBeenCalledTimes(1);
    await second.stop();
    expect(bridge.plugin.stop).toHaveBeenCalledTimes(2);
  });
  it('serializes pending native permission work before stop and a fresh start', async () => {
    bridge.native = true;
    let resolve!: () => void;
    bridge.plugin.startMotion.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const first = session();
    const second = session();
    const starting = first.startMotion();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const stopping = first.stop();
    const next = second.startMotion();
    resolve();
    await Promise.all([starting, stopping, next]);
    expect(bridge.plugin.startMotion).toHaveBeenCalledTimes(2);
    expect(bridge.plugin.stop).toHaveBeenCalledTimes(1);
  });
});
