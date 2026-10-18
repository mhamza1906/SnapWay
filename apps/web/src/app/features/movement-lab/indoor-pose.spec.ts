import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndoorPoseSession } from './indoor-pose';

const native = vi.hoisted(() => ({
  platform: 'ios',
  start: vi.fn<() => Promise<void>>(async () => undefined),
  stop: vi.fn<() => Promise<void>>(async () => undefined),
  captureFrame: vi.fn(),
  listeners: new Map<string, (value: unknown) => void>(),
  addListener: vi.fn(async (name: string, callback: (value: unknown) => void) => {
    native.listeners.set(name, callback);
    return { remove: vi.fn(async () => undefined) };
  }),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => native.platform },
  registerPlugin: () => native,
}));
const sessions: IndoorPoseSession[] = [];
function session() {
  const callbacks = { pose: vi.fn(), status: vi.fn() };
  const value = new IndoorPoseSession(callbacks);
  sessions.push(value);
  return { value, callbacks };
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((value) => value.dispose()));
  native.platform = 'ios';
  native.listeners.clear();
  vi.clearAllMocks();
});
describe('Opt-in iOS AR camera lifecycle', () => {
  it('starts nothing on construction and refuses browser/Android sessions', async () => {
    native.platform = 'android';
    const { value } = session();
    expect(native.start).not.toHaveBeenCalled();
    await expect(value.start()).rejects.toThrow('native iPhone');
    expect(native.start).not.toHaveBeenCalled();
  });
  it('stops a pending camera permission request and suppresses late callbacks', async () => {
    let rejectStart!: (reason: Error) => void;
    native.start.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectStart = reject;
        }),
    );
    native.stop.mockImplementationOnce(async () => {
      rejectStart(new Error('cancelled'));
    });
    const { value, callbacks } = session();
    const starting = value.start();
    const rejected = expect(starting).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(rejectStart).toBeTypeOf('function'));
    await value.stop();
    await rejected;
    native.listeners.get('pose')?.({ x: 5 });
    expect(callbacks.pose).not.toHaveBeenCalled();
  });
  it('does not let disposal of an old screen stop the newer owner', async () => {
    const first = session().value,
      second = session().value;
    await first.start();
    await second.start();
    expect(native.stop).toHaveBeenCalledTimes(1);
    await first.dispose();
    expect(native.stop).toHaveBeenCalledTimes(1);
    await second.stop();
    expect(native.stop).toHaveBeenCalledTimes(2);
  });
});
