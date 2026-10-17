// Rear-camera live preview and still capture with getUserMedia. The camera only runs while
// the guided capture is open; stop() releases every track.

export type CameraStatus =
  | 'off'
  | 'starting'
  | 'live'
  | 'denied'
  | 'no-camera'
  | 'busy'
  | 'insecure'
  | 'unsupported'
  | 'interrupted'
  | 'paused'
  | 'error';

export const CAMERA_MESSAGE: Record<CameraStatus, string> = {
  off: '',
  starting: 'Starting the rear camera…',
  live: '',
  denied:
    'Camera access was denied. Allow the camera for this site in the browser settings and tap "Try camera again", or take the photo with your camera app below.',
  'no-camera': 'No camera was found on this device. Choose or take a photo below instead.',
  busy: 'The camera is being used by another app. Close it and tap "Try camera again", or use the photo picker below.',
  insecure:
    'The live camera needs a secure (HTTPS) connection. Open SnapWay over HTTPS, or take the photo with your camera app below.',
  unsupported:
    'This browser cannot show a live camera preview. Take the photo with your camera app below.',
  interrupted:
    'The camera stopped (another app may have taken it). Tap "Try camera again" to restart it.',
  paused: 'The camera was paused while SnapWay was in the background. Tap "Resume camera".',
  error: 'The camera could not be started. Tap "Try camera again", or use the photo picker below.',
};

/** Why the live camera cannot be used before asking, or null when it can be tried. */
export function cameraBlocker(): CameraStatus | null {
  if (globalThis.isSecureContext === false) return 'insecure';
  if (typeof globalThis.navigator?.mediaDevices?.getUserMedia !== 'function') return 'unsupported';
  return null;
}

/** Maps a getUserMedia rejection to a status with a clear message. */
export function classifyCameraError(error: unknown): CameraStatus {
  switch ((error as { name?: string } | null)?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    default:
      return 'error';
  }
}

/** Rear camera, as large as the device offers (the still uses the track's full resolution). */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 4032 },
    height: { ideal: 3024 },
  },
};

export class CameraController {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private generation = 0;

  constructor(private readonly onStatus: (status: CameraStatus) => void) {}

  get active(): boolean {
    return !!this.stream;
  }

  async start(video: HTMLVideoElement): Promise<CameraStatus> {
    this.stop();
    const blocked = cameraBlocker();
    if (blocked) return this.report(blocked);
    const generation = ++this.generation;
    this.report('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (error) {
      if (generation !== this.generation) return 'off';
      return this.report(classifyCameraError(error));
    }
    // stop() (or a newer start) ran while the permission prompt was open.
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      return 'off';
    }
    this.stream = stream;
    this.video = video;
    for (const track of stream.getVideoTracks())
      track.addEventListener('ended', () => {
        if (this.stream === stream) {
          this.stop();
          this.report('interrupted');
        }
      });
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // Autoplay of a muted inline video is allowed; ignore a play() race on teardown.
    }
    return this.report('live');
  }

  /** Releases every track; safe to call repeatedly. */
  stop(): void {
    this.generation++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }

  /** A JPEG still at the video track's full resolution. */
  async still(quality = 0.92): Promise<Blob> {
    const video = this.video,
      track = this.stream?.getVideoTracks()[0];
    if (!video || !track) throw new Error('The camera is not running.');
    const settings = track.getSettings?.() ?? {};
    const width = video.videoWidth || settings.width || 0,
      height = video.videoHeight || settings.height || 0;
    if (!width || !height) throw new Error('The camera has no picture yet. Try again.');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot take a still from the camera.');
    ctx.drawImage(video, 0, 0, width, height);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be encoded.'))),
        'image/jpeg',
        quality,
      ),
    );
  }

  private report(status: CameraStatus): CameraStatus {
    this.onStatus(status);
    return status;
  }
}
