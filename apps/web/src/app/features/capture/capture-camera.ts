import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from '../../shared/icon';
import type { DirectionalSlot, Slot, XY } from './capture.models';
import { angleVector, SLOT_LABEL, SLOTS, slotAngle, slotInstruction } from './capture-math';
import { CAMERA_MESSAGE, CameraController, type CameraStatus } from './camera';

export type SlotState = 'none' | 'pending' | 'uploaded' | 'failed';
export interface SavedPhoto {
  slot: Slot;
  blob: Blob;
  viewingAngleDeg: number;
  capturedAt: string;
}

/** Image types Django accepts as-is. */
const UPLOADABLE = ['image/jpeg', 'image/png', 'image/webp'];

/** Decodes an image the browser understands and re-encodes it as JPEG at full size. */
async function toJpeg(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.92),
  );
}

/** Half-size (map px) of the area the mini map shows around the point. */
const MINI = 150;

/**
 * Guided capture at one confirmed point: live rear-camera preview, a mini map with the
 * requested direction, the four slots (+ extra), and capture → preview → retake/save.
 * The arrow is the requested direction only; the phone's orientation is never measured.
 */
@Component({
  selector: 'app-capture-camera',
  imports: [Icon],
  templateUrl: './capture-camera.html',
  styleUrl: './capture-camera.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureCamera {
  readonly point = input.required<XY>();
  readonly order = input(1);
  readonly forwardDeg = input(0);
  readonly ends = input<{ towards: string; from: string }>({
    towards: 'the end of the corridor',
    from: 'the start of the corridor',
  });
  readonly path = input<XY[]>([]);
  readonly slotStates = input<Partial<Record<Slot, SlotState>>>({});
  readonly saved = output<SavedPhoto>();
  readonly closed = output<void>();

  readonly status = signal<CameraStatus>('off');
  readonly slot = signal<Slot>('forward');
  /** For an extra photo: which way the contributor faces. */
  readonly extraFacing = signal<DirectionalSlot>('forward');
  readonly still = signal<{ blob: Blob; url: string; capturedAt: string } | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  /** Slots saved during this visit (before the queue reports them). */
  readonly savedHere = signal<Slot[]>([]);
  readonly slots: readonly Slot[] = [...SLOTS, 'extra'];
  readonly slotLabel = SLOT_LABEL;
  readonly message = computed(() => CAMERA_MESSAGE[this.status()]);
  readonly live = computed(() => this.status() === 'live');
  readonly canRestart = computed(() =>
    ['denied', 'busy', 'interrupted', 'paused', 'error', 'no-camera'].includes(this.status()),
  );
  readonly facing = computed<DirectionalSlot>(() => {
    const s = this.slot();
    return s === 'extra' ? this.extraFacing() : s;
  });
  readonly angle = computed(() => slotAngle(this.forwardDeg(), this.facing()));
  readonly angleRounded = computed(() => Math.round(this.angle()) % 360);
  readonly instruction = computed(() => slotInstruction(this.slot(), this.ends()));
  readonly requiredDone = computed(
    () => SLOTS.filter((s) => this.stateOf(s) !== 'none' && this.stateOf(s) !== 'failed').length,
  );
  /** Mini map, rotated so the walking direction points up. */
  readonly mini = computed(() => {
    const p = this.point(),
      v = angleVector(this.angle()),
      len = MINI * 0.62;
    return {
      viewBox: `${p.x - MINI} ${p.y - MINI} ${MINI * 2} ${MINI * 2}`,
      rotate: `rotate(${270 - this.forwardDeg()} ${p.x} ${p.y})`,
      path: this.path()
        .map((q) => `${q.x},${q.y}`)
        .join(' '),
      arrow: { x1: p.x, y1: p.y, x2: p.x + v.x * len, y2: p.y + v.y * len },
      unit: MINI / 60,
    };
  });

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly camera = new CameraController((s) => this.status.set(s));
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      this.slot.set(this.firstMissing());
      void this.startCamera();
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && this.camera.active) {
        this.camera.stop();
        this.status.set('paused');
      }
    };
    const onPageHide = () => {
      if (this.camera.active) {
        this.camera.stop();
        this.status.set('paused');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener?.('pagehide', onPageHide);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener?.('pagehide', onPageHide);
      this.camera.stop();
      this.clearStill();
    });
  }

  stateOf(slot: Slot): SlotState {
    const known = this.slotStates()[slot] ?? 'none';
    if (known !== 'none') return known;
    return this.savedHere().includes(slot) ? 'pending' : 'none';
  }

  slotStateLabel(slot: Slot): string {
    return {
      none: 'not taken',
      pending: 'saved, waiting to upload',
      uploaded: 'uploaded',
      failed: 'upload failed',
    }[this.stateOf(slot)];
  }

  async startCamera(): Promise<void> {
    const video = this.video()?.nativeElement;
    if (!video) return;
    this.error.set('');
    await this.camera.start(video);
  }

  choose(slot: Slot): void {
    this.slot.set(slot);
    this.clearStill();
  }

  async take(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const blob = await this.camera.still();
      this.setStill(blob);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'The photo could not be taken.');
    } finally {
      this.busy.set(false);
    }
  }

  async fromFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      this.error.set('Choose a photo.');
      return;
    }
    this.error.set('');
    if (UPLOADABLE.includes(file.type)) return this.setStill(file);
    // The server accepts JPEG, PNG and WebP; re-encode anything else (e.g. HEIC) the browser can decode.
    this.busy.set(true);
    try {
      this.setStill(await toJpeg(file));
    } catch {
      this.error.set(
        'This photo format cannot be uploaded. Take the photo again or choose a JPEG.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  retake(): void {
    this.clearStill();
  }

  save(): void {
    const still = this.still();
    if (!still) return;
    const slot = this.slot();
    this.saved.emit({
      slot,
      blob: still.blob,
      viewingAngleDeg: this.angle(),
      capturedAt: still.capturedAt,
    });
    this.savedHere.update((list) => (list.includes(slot) ? list : [...list, slot]));
    this.clearStill();
    this.slot.set(this.firstMissing());
  }

  close(): void {
    this.camera.stop();
    this.closed.emit();
  }

  private firstMissing(): Slot {
    return SLOTS.find((s) => this.stateOf(s) === 'none' || this.stateOf(s) === 'failed') ?? 'extra';
  }

  private setStill(blob: Blob): void {
    this.clearStill();
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
    this.still.set({ blob, url, capturedAt: new Date().toISOString() });
  }

  private clearStill(): void {
    const url = this.still()?.url;
    if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    this.still.set(null);
  }
}
