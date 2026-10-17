import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { GraphEdge, GraphNode } from '../../core/graph-api.service';

export type GraphTool = 'select' | 'add' | 'connect' | 'cut';

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
  readonly selectedNodeId = input<string | null>(null);
  readonly selectedEdgeId = input<string | null>(null);
  readonly connectFromId = input<string | null>(null);
  readonly tool = input<GraphTool>('select');

  readonly canvasClicked = output<{ x: number; y: number }>();
  readonly nodeClicked = output<string>();
  readonly edgeClicked = output<string>();

  readonly paths = computed(() =>
    this.edges().map((edge) => {
      const start = this.nodes().find((n) => n.id === edge.from_node_id);
      const end = this.nodes().find((n) => n.id === edge.to_node_id);
      return { edge, start, end };
    }),
  );

  onBackground(event: MouseEvent): void {
    if (this.tool() !== 'add') return;
    const point = this.planPoint(event);
    if (point) this.canvasClicked.emit(point);
  }

  onNode(event: MouseEvent, id: string): void {
    event.stopPropagation();
    this.nodeClicked.emit(id);
  }

  onEdge(event: MouseEvent, id: string): void {
    event.stopPropagation();
    this.edgeClicked.emit(id);
  }

  private planPoint(event: MouseEvent): { x: number; y: number } | null {
    const svg = (event.target as Element).closest('svg');
    const transform = svg?.getScreenCTM();
    if (!svg || !transform) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    const w = this.width();
    const h = this.height();
    return {
      x: Math.round(Math.max(0, Math.min(w, point.x))),
      y: Math.round(Math.max(0, Math.min(h, point.y))),
    };
  }
}
