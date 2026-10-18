import { photoPointGraph } from './photo-graph';
import type { HallPlan } from './pipeline.service';

const point = (x: number, y: number, order: number) => ({
  x,
  y,
  order,
  reason: 'spacing' as const,
});
const plan = (lines: HallPlan['lines'], points: HallPlan['points']): HallPlan => ({
  spaceId: 'hall',
  label: 'Hall',
  scaleVerified: false,
  spacingM: null,
  spacingPx: 10,
  lines,
  points,
});

describe('photo-point graph export', () => {
  it('keeps the bend between nearby photo points instead of cutting the corner', () => {
    const g = photoPointGraph(
      plan(
        [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        ],
        [point(5, 0, 1), point(10, 5, 2)],
      ),
    );
    const photoIds = g.nodes.map((n, i) => (n.photoOrder ? i : -1)).filter((i) => i >= 0);
    expect(photoIds).toHaveLength(2);
    expect(g.edges.some((e) => photoIds.includes(e.from) && photoIds.includes(e.to))).toBe(false);
    expect(g.edges).toHaveLength(4);
    for (const e of g.edges) {
      const a = g.nodes[e.from],
        b = g.nodes[e.to];
      expect((a.y === 0 && b.y === 0) || (a.x === 10 && b.x === 10)).toBe(true);
    }
  });
  it('preserves a shared branch junction and does not connect a nearby separate corridor', () => {
    const g = photoPointGraph(
      plan(
        [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          [
            { x: 10, y: 0 },
            { x: 20, y: 0 },
          ],
          [
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
          [
            { x: 0, y: 2 },
            { x: 5, y: 2 },
          ],
        ],
        [point(5, 0, 1), point(10, 5, 2), point(15, 0, 3), point(3, 2, 4)],
      ),
    );
    const branch = g.nodes.findIndex((n) => n.x === 10 && n.y === 0);
    expect(g.edges.filter((e) => e.from === branch || e.to === branch)).toHaveLength(3);
    const seen = new Set([g.nodes.findIndex((n) => n.photoOrder === 1)]);
    for (let changed = true; changed;) {
      changed = false;
      for (const e of g.edges)
        if (seen.has(e.from) !== seen.has(e.to)) {
          seen.add(e.from);
          seen.add(e.to);
          changed = true;
        }
    }
    expect(seen.has(g.nodes.findIndex((n) => n.photoOrder === 3))).toBe(true);
    expect(seen.has(g.nodes.findIndex((n) => n.photoOrder === 4))).toBe(false);
  });
  it('handles rounded points but rejects off-path or duplicate photo locations before upload', () => {
    const lines = [
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
    ];
    expect(
      photoPointGraph(plan(lines, [point(5, 5.01, 1)])).nodes.some((n) => n.photoOrder === 1),
    ).toBe(true);
    expect(() => photoPointGraph(plan(lines, [point(5, 6, 1)]))).toThrow(
      /off its planned corridor/,
    );
    expect(() => photoPointGraph(plan(lines, [point(5, 5, 1), point(5, 5, 2)]))).toThrow(
      /Duplicate/,
    );
  });
});
