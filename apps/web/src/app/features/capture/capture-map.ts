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
import type { SafeHtml } from '@angular/platform-browser';
import { Icon } from '../../shared/icon';
import type { PointStatus, XY } from './capture.models';
import { STATE_LABEL } from './capture-math';

export interface MapMarker {
  id: string;
  order: number;
  x: number;
  y: number;
  state: PointStatus;
  selected: boolean;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 12;
/** Movement (screen px) below which a press counts as a tap. */
const TAP_SLOP = 8;

/**
 * Zoomable, pannable floor plan: the pipeline's floor SVG with an overlay of corridors, the
 * selected walking path and numbered capture points. Pointer events give one-finger pan,
 * two-finger pinch, wheel zoom and taps (in map coordinates).
 */
@Component({
  selector: 'app-capture-map',
  imports: [Icon],
  templateUrl: './capture-map.html',
  styleUrl: './capture-map.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureMap {
  readonly svg = input<SafeHtml | null>(null);
  readonly width = input(1000);
  readonly height = input(1000);
  readonly corridors = input<{ id: string; path: XY[] }[]>([]);
  readonly path = input<XY[]>([]);
  readonly markers = input<MapMarker[]>([]);
  readonly preview = input<XY | null>(null);
  readonly placing = input(false);
  readonly label = input('Floor plan');
  readonly pointTap = output<string>();
  readonly mapTap = output<XY>();

  readonly scale = signal(1);
  readonly tx = signal(0);
  readonly ty = signal(0);
  /** Map units per screen pixel, so markers keep their on-screen size at any zoom. */
  readonly k = computed(() => 1 / this.scale());
  readonly transform = computed(
    () => `translate(${this.tx()}px, ${this.ty()}px) scale(${this.scale()})`,
  );
  readonly viewBox = computed(() => `0 0 ${this.width()} ${this.height()}`);
  readonly pathPoints = computed(() => toPoints(this.path()));
  readonly corridorLines = computed(() =>
    this.corridors().map((c) => ({ id: c.id, points: toPoints(c.path) })),
  );
  readonly stateLabel = STATE_LABEL;

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly pointers = new Map<number, XY>();
  private pinch: { dist: number; scale: number; mid: XY; tx: number; ty: number } | null = null;
  private down: { x: number; y: number; pointId: string | null } | null = null;
  private moved = false;

  constructor() {
    afterNextRender(() => {
      this.fit();
      const el = this.viewport()?.nativeElement;
      if (!el || typeof ResizeObserver === 'undefined') return;
      let last = `${el.clientWidth}x${el.clientHeight}`;
      const observer = new ResizeObserver(() => {
        const size = `${el.clientWidth}x${el.clientHeight}`;
        if (size !== last) {
          last = size;
          this.fit();
        }
      });
      observer.observe(el);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
  private readonly destroyRef = inject(DestroyRef);

  /** Shows the whole floor. */
  fit(): void {
    const el = this.viewport()?.nativeElement;
    const w = el?.clientWidth || 360,
      h = el?.clientHeight || 360;
    const s = clamp(Math.min(w / this.width(), h / this.height()) * 0.96);
    this.scale.set(s);
    this.tx.set((w - this.width() * s) / 2);
    this.ty.set((h - this.height() * s) / 2);
  }

  /** Centres a map position, zooming in to at least `minScale` of the fitted view. */
  centerOn(p: XY, zoom = 2.5): void {
    const el = this.viewport()?.nativeElement;
    const w = el?.clientWidth || 360,
      h = el?.clientHeight || 360;
    const fitted = Math.min(w / this.width(), h / this.height());
    const s = clamp(Math.max(this.scale(), fitted * zoom));
    this.scale.set(s);
    this.tx.set(w / 2 - p.x * s);
    this.ty.set(h / 2 - p.y * s);
  }

  zoomBy(factor: number, at?: XY): void {
    const el = this.viewport()?.nativeElement;
    const c = at ?? { x: (el?.clientWidth || 360) / 2, y: (el?.clientHeight || 360) / 2 };
    const s = this.scale(),
      next = clamp(s * factor);
    const mx = (c.x - this.tx()) / s,
      my = (c.y - this.ty()) / s;
    this.scale.set(next);
    this.tx.set(c.x - mx * next);
    this.ty.set(c.y - my * next);
  }

  /** Viewport-relative screen position → map frame. */
  toMap(clientX: number, clientY: number): XY {
    const rect = this.viewport()?.nativeElement.getBoundingClientRect();
    const x = clientX - (rect?.left ?? 0),
      y = clientY - (rect?.top ?? 0);
    return { x: (x - this.tx()) / this.scale(), y: (y - this.ty()) / this.scale() };
  }

  private local(e: PointerEvent | WheelEvent): XY {
    const rect = this.viewport()?.nativeElement.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as Element).closest?.('.map-controls')) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 1) {
      this.moved = false;
      const marker = (e.target as Element).closest?.('[data-point-id]');
      this.down = {
        x: e.clientX,
        y: e.clientY,
        pointId: marker?.getAttribute('data-point-id') ?? null,
      };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.moved = true;
      this.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: this.scale(),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        tx: this.tx(),
        ty: this.ty(),
      };
    }
  }

  onPointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const now = this.local(e);
    this.pointers.set(e.pointerId, now);
    if (this.pointers.size === 1) {
      if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > TAP_SLOP)
        this.moved = true;
      if (this.moved) {
        this.tx.update((v) => v + now.x - prev.x);
        this.ty.update((v) => v + now.y - prev.y);
      }
    } else if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const p = this.pinch,
        s = clamp((p.scale * dist) / p.dist);
      const mx = (p.mid.x - p.tx) / p.scale,
        my = (p.mid.y - p.ty) / p.scale;
      this.scale.set(s);
      this.tx.set(mid.x - mx * s);
      this.ty.set(mid.y - my * s);
    }
  }

  onPointerUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size) return;
    const down = this.down;
    this.down = null;
    if (e.type !== 'pointerup' || this.moved || !down) return;
    if (down.pointId) this.pointTap.emit(down.pointId);
    else this.mapTap.emit(this.toMap(e.clientX, e.clientY));
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, this.local(e));
  }

  markerLabel(m: MapMarker): string {
    return `Capture point ${m.order}, ${STATE_LABEL[m.state]}${m.selected ? ', selected' : ''}`;
  }

  halfDisc(m: MapMarker): string {
    const r = 14 * this.k();
    return `M ${m.x} ${m.y - r} A ${r} ${r} 0 0 1 ${m.x} ${m.y + r} Z`;
  }
}

function clamp(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}
function toPoints(path: XY[]): string {
  return path.map((p) => `${p.x},${p.y}`).join(' ');
}
