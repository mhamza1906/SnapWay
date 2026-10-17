import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MapDocument, Room } from '../core/prototype.models';

/** Pure SVG presentation, shared by contributor and visitor bundles. */
@Component({
  selector: 'app-map-canvas',
  templateUrl: './map-canvas.html',
  styleUrl: './map-canvas.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapCanvas {
  readonly document = input.required<MapDocument>();
  readonly selected = input('');
  readonly route = input<string[]>([]);
  readonly position = input('');
  readonly interactive = input(false);
  readonly selectable = input(false);
  readonly destinationsOnly = input(false);
  readonly canSelect = computed(() => this.interactive() || this.selectable());
  readonly canInspect = computed(() => this.canSelect() && !this.destinationsOnly());
  readonly compact = input(false);
  readonly objectSelected = output<string>();
  readonly pointSelected = output<{ x: number; y: number }>();
  readonly paths = computed(() =>
    this.document().edges.map((edge) => ({
      ...edge,
      start: this.document().nodes.find((node) => node.id === edge.from),
      end: this.document().nodes.find((node) => node.id === edge.to),
    })),
  );
  readonly routePoints = computed(() =>
    this.route()
      .map((id) => this.document().nodes.find((node) => node.id === id))
      .filter((node) => !!node)
      .map((node) => `${node.x},${node.y}`)
      .join(' '),
  );
  readonly current = computed(() =>
    this.document().nodes.find((node) => node.id === this.position()),
  );

  roomLabel(room: Room): string {
    const limit = Math.max(1, Math.floor((room.width - 36) / 9));
    const characters = Array.from(room.name);
    return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : room.name;
  }

  pick(event: MouseEvent, id: string): void {
    if (!this.canPick(id)) return;
    event.stopPropagation();
    this.objectSelected.emit(id);
    this.point(event);
  }

  keySelect(id: string): void {
    if (this.canPick(id)) this.objectSelected.emit(id);
  }

  private canPick(id: string): boolean {
    return (
      this.canSelect() &&
      (!this.destinationsOnly() ||
        this.document().rooms.some((room) => room.id === id) ||
        this.document().nodes.some((node) => node.id === id))
    );
  }

  point(event: MouseEvent): void {
    if (!this.interactive()) return;
    const svg = (event.target as Element).closest('svg');
    const transform = svg?.getScreenCTM();
    if (!svg || !transform) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    this.pointSelected.emit({
      x: Math.round(Math.max(0, Math.min(1000, point.x))),
      y: Math.round(Math.max(0, Math.min(640, point.y))),
    });
  }
}
