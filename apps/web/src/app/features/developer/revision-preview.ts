import { Component, computed, input } from '@angular/core';
import { MapRevision } from '../../core/workspace-api.service';
@Component({
  selector: 'app-revision-preview',
  template: `<svg
    [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
    role="img"
    aria-label="Floor plan and navigation graph"
  >
    @if (revision().underlay_url) {
      <image
        [attr.href]="revision().underlay_url"
        [attr.width]="width()"
        [attr.height]="height()"
      />
    }
    @for (path of paths(); track path.id) {
      <path
        [attr.d]="path.d"
        stroke="#008ac5"
        fill="none"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      />
    }
    @for (node of revision().nodes; track node.id) {
      <circle
        [attr.cx]="node.x"
        [attr.cy]="node.y"
        r="5"
        fill="#008ac5"
        stroke="white"
        stroke-width="1.5"
      />
      <text [attr.x]="node.x + 9" [attr.y]="node.y - 9" font-size="13" fill="#244b59">
        {{ node.label }}
      </text>
    }
  </svg>`,
  styles: [
    ':host{display:block;width:100%;height:100%}svg{width:100%;height:100%;display:block;pointer-events:none}',
  ],
})
export class RevisionPreview {
  readonly revision = input.required<MapRevision>();
  readonly width = computed(() => this.revision().coordinate_frame.width || 1000);
  readonly height = computed(() => this.revision().coordinate_frame.height || 640);
  readonly paths = computed(() => {
    const nodes = new Map(this.revision().nodes.map((n) => [n.id, n]));
    return this.revision().edges.flatMap((e) => {
      const a = nodes.get(e.from_node_id),
        b = nodes.get(e.to_node_id);
      return a && b ? [{ id: e.id, d: `M${a.x},${a.y}L${b.x},${b.y}` }] : [];
    });
  });
}
