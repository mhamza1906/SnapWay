import { describe, it, expect, vi, afterEach } from 'vitest';
import { CapacitorHttp } from '@capacitor/core';
import { IOSVisualMatcher } from './ios-visual-match';
import type { IOSCapturedPoseFrame } from './indoor-pose';

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: vi.fn(), post: vi.fn() } }));

const frame: IOSCapturedPoseFrame = {
  jpegBase64: '/9j/test',
  timestamp: 10000,
  monotonicSeconds: 123,
  epoch: 'world-a',
  pose: { x: 0, y: 0, z: 2 },
};
const response = {
  status: 200,
  headers: {},
  url: 'https://test.example',
  data: { nodeId: 'old-node', timeSeconds: 0, status: 'candidate', similarity: 0.7, margin: 0.2 },
};
const ready = () =>
  vi
    .mocked(CapacitorHttp.get)
    .mockResolvedValue({ ...response, data: { sessionId: 'k'.repeat(32) } });
afterEach(() => vi.resetAllMocks());

describe('iOS visual correction transport', () => {
  it('sends one JSON JPEG with original AR capture time and an ephemeral session', async () => {
    ready();
    const post = vi.mocked(CapacitorHttp.post).mockResolvedValue(response);
    const matcher = new IOSVisualMatcher('https://test.example');
    await matcher.start();
    expect((await matcher.match(frame)).nodeId).toBe('old-node');
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://test.example/experiment-api/ios-match',
        data: { jpegBase64: frame.jpegBase64, monotonicSeconds: 123 },
        disableRedirects: true,
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Lab-Session': 'k'.repeat(32),
        }),
      }),
    );
  });
  it('rejects a late correction after Stop and prevents overlapping requests', async () => {
    ready();
    let finish!: (value: typeof response) => void;
    vi.mocked(CapacitorHttp.post).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const matcher = new IOSVisualMatcher('https://test.example');
    await matcher.start();
    const pending = matcher.match(frame);
    const rejected = expect(pending).rejects.toThrow(/stopped session/);
    await expect(matcher.match(frame)).rejects.toThrow(/already/);
    matcher.dispose();
    finish(response);
    await rejected;
  });
  it('rejects insecure origins, credentials and invalid captures before upload', async () => {
    expect(() => new IOSVisualMatcher('http://test.example')).toThrow(/HTTPS/);
    expect(() => new IOSVisualMatcher('https://user:password@test.example')).toThrow(/credentials/);
    ready();
    const post = vi.mocked(CapacitorHttp.post);
    const matcher = new IOSVisualMatcher('https://test.example');
    await matcher.start();
    await expect(matcher.match({ ...frame, monotonicSeconds: NaN })).rejects.toThrow(/timestamp/);
    expect(post).not.toHaveBeenCalled();
  });
});
