import type { HallPlan, Point } from './pipeline.service';

export interface PhotoGraphNode extends Point {
  label: string;
  kind: 'checkpoint' | 'junction';
  photoOrder?: number;
}

/** Preserve the planned corridor polylines, including bends and branches.
 * Numbering is a capture itinerary; consecutive numbers are not graph edges.
 * Only exact shared vertices join lines. Nearby or crossing lines stay separate.
 */
export function photoPointGraph(
  plan: HallPlan,
  retainedLocations: Point[] = [],
): {
  nodes: PhotoGraphNode[];
  edges: { from: number; to: number }[];
} {
  const nodes: PhotoGraphNode[] = [];
  const byPosition = new Map<string, number>();
  const vertex = (p: Point) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
      throw new Error('Invalid photo path coordinate.');
    const key = `${p.x.toFixed(8)},${p.y.toFixed(8)}`;
    let id = byPosition.get(key);
    if (id === undefined) {
      id = nodes.length;
      byPosition.set(key, id);
      nodes.push({ ...p, label: 'Path junction / bend', kind: 'junction' });
    }
    return id;
  };
  const segments = plan.lines.flatMap((line) =>
    line.slice(1).flatMap((b, i) => {
      const a = line[i],
        length2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (length2 < 1e-12) return [];
      return [
        {
          a,
          b,
          length2,
          cuts: [
            { t: 0, id: vertex(a) },
            { t: 1, id: vertex(b) },
          ],
        },
      ];
    }),
  );
  const locations = [
    ...plan.points.map((point) => ({ point, capture: true })),
    ...retainedLocations.map((point) => ({
      point: { ...point, order: 0, reason: 'spacing' },
      capture: false,
    })),
  ];
  for (const { point, capture } of locations) {
    let best:
      { segment: (typeof segments)[number]; t: number; at: Point; distance: number } | undefined;
    for (const segment of segments) {
      const { a, b, length2 } = segment;
      const t = Math.max(
        0,
        Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length2),
      );
      const at = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      const distance = Math.hypot(point.x - at.x, point.y - at.y);
      if (!best || distance < best.distance) best = { segment, t, at, distance };
    }
    // The planner rounds coordinates to two decimals. This tolerance covers
    // that rounding only; it cannot rescue points placed off their paths.
    if (!best || best.distance > 0.02)
      throw new Error(
        `Photo point ${point.order} is off its planned corridor. Regenerate the photo points.`,
      );
    const id = vertex(best.at);
    if (capture && nodes[id].photoOrder !== undefined)
      throw new Error('Duplicate photo locations. Regenerate the photo points.');
    if (capture)
      Object.assign(nodes[id], {
        label: `Point ${point.order}`,
        kind: point.reason === 'junction' ? 'junction' : 'checkpoint',
        photoOrder: point.order,
      });
    best.segment.cuts.push({ t: best.t, id });
  }
  const edges: { from: number; to: number }[] = [],
    seen = new Set<string>();
  for (const segment of segments) {
    const cuts = segment.cuts.sort((a, b) => a.t - b.t);
    for (let i = 1; i < cuts.length; i++) {
      const from = cuts[i - 1].id,
        to = cuts[i].id;
      const key = [from, to].sort((a, b) => a - b).join(':');
      if (from === to || seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
  }
  return { nodes, edges };
}
