import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { GraphEdge, GraphNode } from '../../core/graph-api.service';

export type GraphTool = 'select' | 'add' | 'connect' | 'cut' | 'pan';
export type Point = { x: number; y: number };
export type NodeMove = Point & { id: string };
type Camera = Point & { w: number; h: number };
type Gesture = {
  pointer: number;
  start: Point;
  client: Point;
  matrix: DOMMatrix;
  camera: Camera;
  mode: 'move' | 'marquee' | 'pan' | 'click';
  origin: NodeMove[];
  selected: string[];
  additive: boolean;
};

/** Preserve relative positions when a group hits the plan boundary. */
export function boundedMove(
  nodes: NodeMove[],
  dx: number,
  dy: number,
  width: number,
  height: number,
): NodeMove[] {
  if (!nodes.length) return [];
  dx = Math.max(
    -Math.min(...nodes.map((n) => n.x)),
    Math.min(dx, width - Math.max(...nodes.map((n) => n.x))),
  );
  dy = Math.max(
    -Math.min(...nodes.map((n) => n.y)),
    Math.min(dy, height - Math.max(...nodes.map((n) => n.y))),
  );
  return nodes.map((n) => ({
    id: n.id,
    x: Math.round((n.x + dx) * 100) / 100,
    y: Math.round((n.y + dy) * 100) / 100,
  }));
}

@Component({
  selector: 'app-graph-canvas',
  templateUrl: './graph-canvas.html',
  styleUrl: './graph-canvas.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GraphCanvas {
  readonly width = input(1000);
  readonly height = input(640);
  readonly underlayUrl = input<string | null>(null);
  readonly nodes = input<GraphNode[]>([]);
  readonly edges = input<GraphEdge[]>([]);
  readonly selectedIds = input<string[]>([]);
  readonly selectedEdgeId = input<string | null>(null);
  readonly connectFromId = input<string | null>(null);
  readonly tool = input<GraphTool>('select');
  readonly disabled = input(false);
  readonly labels = input(true);
  readonly spacePan = input(false);
  readonly canvasClicked = output<Point>();
  readonly nodeClicked = output<string>();
  readonly edgeClicked = output<string>();
  readonly selectionChanged = output<string[]>();
  readonly moved = output<NodeMove[]>();
  readonly camera = signal<Camera | null>(null);
  readonly view = computed(
    () => this.camera() ?? { x: 0, y: 0, w: this.width(), h: this.height() },
  );
  readonly zoom = computed(() => Math.round((this.width() / this.view().w) * 100));
  readonly viewBox = computed(() => {
    const v = this.view();
    return `${v.x} ${v.y} ${v.w} ${v.h}`;
  });
  readonly preview = signal<NodeMove[]>([]);
  readonly marquee = signal<{ x: number; y: number; w: number; h: number } | null>(null);
  readonly displayed = computed(() => {
    const positions = new Map(this.preview().map((n) => [n.id, n]));
    return this.nodes().map((n) => ({ ...n, ...positions.get(n.id) }));
  });
  readonly paths = computed(() => {
    const nodes = new Map(this.displayed().map((n) => [n.id, n]));
    return this.edges().map((edge) => {
      const start = nodes.get(edge.from_node_id),
        end = nodes.get(edge.to_node_id);
      const dx = (end?.x ?? 0) - (start?.x ?? 0),
        dy = (end?.y ?? 0) - (start?.y ?? 0);
      return {
        edge,
        start,
        end,
        length: Math.max(1, Math.hypot(dx, dy)),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
      };
    });
  });
  private gesture: Gesture | null = null;
  fit() {
    this.camera.set(null);
  }
  zoomBy(factor: number, anchor?: Point) {
    const v = this.view(),
      z = Math.min(10, Math.max(0.35, (this.width() / v.w) * factor));
    const w = this.width() / z,
      h = this.height() / z;
    const a = anchor ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    this.camera.set({ x: a.x - ((a.x - v.x) * w) / v.w, y: a.y - ((a.y - v.y) * h) / v.h, w, h });
  }
  wheel(event: WheelEvent) {
    event.preventDefault();
    const svg = event.currentTarget as SVGSVGElement,
      matrix = svg.getScreenCTM()?.inverse();
    if (matrix)
      this.zoomBy(
        Math.exp(-event.deltaY * 0.0015),
        new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix),
      );
  }
  down(event: PointerEvent) {
    if (this.disabled() || (event.button !== 0 && event.button !== 1)) return;
    const svg = event.currentTarget as SVGSVGElement;
    const matrix = svg.getScreenCTM()?.inverse();
    if (!matrix) return;
    const target = event.target as Element;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    const id = target.closest('[data-node]')?.getAttribute('data-node');
    const edge = target.closest('[data-edge]')?.getAttribute('data-edge');
    const pan = this.tool() === 'pan' || this.spacePan() || event.button === 1;
    let selected = this.selectedIds().slice();
    let mode: Gesture['mode'] = pan ? 'pan' : 'click';
    if (!pan && id) {
      if (this.tool() !== 'select') {
        this.nodeClicked.emit(id);
        return;
      }
      selected = event.shiftKey
        ? selected.includes(id)
          ? selected.filter((n) => n !== id)
          : [...selected, id]
        : selected.includes(id)
          ? selected
          : [id];
      this.selectionChanged.emit(selected);
      mode = selected.includes(id) ? 'move' : 'click';
    } else if (!pan && edge) {
      this.edgeClicked.emit(edge);
      return;
    } else if (!pan && this.tool() === 'select') {
      mode = 'marquee';
      if (!event.shiftKey) {
        selected = [];
        this.selectionChanged.emit([]);
      }
    }
    event.preventDefault();
    svg.focus();
    svg.setPointerCapture(event.pointerId);
    this.gesture = {
      pointer: event.pointerId,
      start: point,
      client: { x: event.clientX, y: event.clientY },
      matrix,
      camera: { ...this.view() },
      mode,
      selected,
      additive: event.shiftKey,
      origin: this.nodes()
        .filter((n) => selected.includes(n.id))
        .map((n) => ({ id: n.id, x: n.x, y: n.y })),
    };
  }
  move(event: PointerEvent) {
    const g = this.gesture;
    if (!g || g.pointer !== event.pointerId) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(g.matrix);
    const dx = point.x - g.start.x,
      dy = point.y - g.start.y;
    if (g.mode === 'pan') this.camera.set({ ...g.camera, x: g.camera.x - dx, y: g.camera.y - dy });
    if (g.mode === 'move' && Math.hypot(event.clientX - g.client.x, event.clientY - g.client.y) > 3)
      this.preview.set(boundedMove(g.origin, dx, dy, this.width(), this.height()));
    if (g.mode === 'marquee')
      this.marquee.set({
        x: Math.min(point.x, g.start.x),
        y: Math.min(point.y, g.start.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      });
  }
  up(event: PointerEvent) {
    const g = this.gesture;
    if (!g || g.pointer !== event.pointerId) return;
    this.move(event);
    const box = this.marquee();
    if (g.mode === 'marquee' && box) {
      const ids = this.nodes()
        .filter((n) => n.x >= box.x && n.x <= box.x + box.w && n.y >= box.y && n.y <= box.y + box.h)
        .map((n) => n.id);
      this.selectionChanged.emit([...new Set([...(g.additive ? g.selected : []), ...ids])]);
    }
    if (g.mode === 'move' && this.preview().length) this.moved.emit(this.preview());
    if (
      g.mode === 'click' &&
      this.tool() === 'add' &&
      Math.hypot(event.clientX - g.client.x, event.clientY - g.client.y) <= 3
    ) {
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(g.matrix);
      if (p.x >= 0 && p.y >= 0 && p.x <= this.width() && p.y <= this.height())
        this.canvasClicked.emit({ x: Math.round(p.x), y: Math.round(p.y) });
    }
    this.cancel();
    const svg = event.currentTarget as SVGSVGElement;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
  }
  cancel() {
    this.gesture = null;
    this.preview.set([]);
    this.marquee.set(null);
  }
}
