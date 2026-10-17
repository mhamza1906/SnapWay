import { vi } from 'vitest';
import { DevicePreview } from './device-preview';

describe('capture freshness and lifecycle', () => {
  afterEach(() => vi.useRealTimers());
  it('drops a superseded capture without overwriting the new destination result', async () => {
    vi.useFakeTimers();
    const device = new DevicePreview();
    device.permission.set('granted');
    const first = device.capture('revision1:room1', 'accepted');
    const second = device.capture('revision1:room2', 'ambiguous');
    await vi.runAllTimersAsync();
    expect(await first).toBeNull();
    expect((await second)?.context).toBe('revision1:room2');
    expect(device.processing()).toBe(false);
  });
  it('invalidates a pending observation when backgrounded or offline', async () => {
    vi.useFakeTimers();
    const device = new DevicePreview();
    device.permission.set('granted');
    const capture = device.capture('revision1:room1', 'accepted');
    device.setBackground(true);
    await vi.runAllTimersAsync();
    expect(await capture).toBeNull();
    expect(await device.capture('revision1:room1', 'accepted')).toBeNull();
    device.setBackground(false);
    device.setOffline(true);
    expect(await device.capture('revision1:room1', 'accepted')).toBeNull();
  });
});
