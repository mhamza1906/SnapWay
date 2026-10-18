import { CapacitorHttp } from '@capacitor/core';
import type { CameraCandidate } from './camera-lab';
import type { IOSCapturedPoseFrame } from './indoor-pose';

function readJsonReply(data: unknown, status: number): any {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    throw new Error(
      `Photo matching service returned a non-JSON response (HTTP ${status}). Check the HTTPS matching-service address and that the computer's matcher/tunnel is running, then retry your photo.`,
    );
  }
}

/** Optional JPEG-only native transport. No developer cookie, private token or retained video. */
export class IOSVisualMatcher {
  private readonly origin: string;
  private session: string | null = null;
  private generation = 0;
  private busy = false;

  constructor(origin: string) {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Enter only an HTTPS matching server origin, without a path or credentials.');
    this.origin = url.origin;
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.session = null;
    const response = await CapacitorHttp.get({
      url: `${this.origin}/experiment-api/session`,
      headers: {
        'ngrok-skip-browser-warning': 'true',
        'Cache-Control': 'no-store',
        Accept: 'application/json',
      },
      connectTimeout: 5000,
      readTimeout: 15000,
      disableRedirects: true,
      responseType: 'text',
    });
    if (generation !== this.generation) throw new Error('Visual matching was stopped.');
    const body = readJsonReply(response.data, response.status);
    if (
      response.status !== 200 ||
      typeof body?.sessionId !== 'string' ||
      !/^[\w-]{24,256}$/.test(body.sessionId)
    )
      throw new Error(
        'The matching service did not open an iOS test session. Check its HTTPS address.',
      );
    this.session = body.sessionId;
  }

  async match(frame: IOSCapturedPoseFrame): Promise<CameraCandidate> {
    if (!this.session) throw new Error('Start visual matching first.');
    if (this.busy) throw new Error('A visual frame is already being matched.');
    if (
      !frame.jpegBase64 ||
      frame.jpegBase64.length > 4_000_000 ||
      !frame.jpegBase64.startsWith('/9j/') ||
      !Number.isFinite(frame.monotonicSeconds) ||
      frame.monotonicSeconds < 0
    )
      throw new Error('ARKit did not supply a valid bounded JPEG and capture timestamp.');
    const generation = this.generation;
    this.busy = true;
    try {
      const response = await CapacitorHttp.post({
        url: `${this.origin}/experiment-api/ios-match`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Lab-Session': this.session,
          'ngrok-skip-browser-warning': 'true',
        },
        data: { jpegBase64: frame.jpegBase64, monotonicSeconds: frame.monotonicSeconds },
        connectTimeout: 5000,
        readTimeout: 60000,
        disableRedirects: true,
        responseType: 'text',
      });
      if (generation !== this.generation)
        throw new Error('This visual result belongs to a stopped session.');
      if (response.status === 429)
        throw new Error('The CPU matcher is busy. This frame was skipped.');
      if (response.status !== 200)
        throw new Error(`iOS frame matching failed (${response.status}).`);
      const body = readJsonReply(response.data, response.status);
      if (
        !body ||
        !['candidate', 'uncertain'].includes(body.status) ||
        !Number.isFinite(body.timeSeconds) ||
        body.timeSeconds < 0 ||
        !Number.isFinite(body.similarity) ||
        Math.abs(body.similarity) > 1 ||
        !Number.isFinite(body.margin) ||
        body.margin < 0 ||
        body.margin > 2 ||
        (body.nodeId !== null && typeof body.nodeId !== 'string')
      )
        throw new Error('The matcher returned an invalid visual candidate. Position held.');
      return body as CameraCandidate;
    } finally {
      this.busy = false;
    }
  }

  /** Core native HTTP cannot abort its socket; bounded in-flight replies are ignored after Stop. */
  dispose(): void {
    this.generation++;
    this.session = null;
  }
}
