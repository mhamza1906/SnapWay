// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkpointRoute } from './photo-checkpoint-route';
import type { LabPlan } from './movement-model';
const original = JSON.parse(
  readFileSync(
    new URL('../../../../public/experiments/entrance-node19.json', import.meta.url),
    'utf8',
  ),
) as LabPlan;
const bundle = JSON.parse(
  readFileSync(
    new URL('../../../../public/experiments/entrance-node19-destinations.json', import.meta.url),
    'utf8',
  ),
);
const plan: LabPlan = {
  ...original,
  nodes: [...original.nodes, ...bundle.nodes],
  edges: [...original.edges, ...bundle.edges],
};
describe('Saved photo node to named destination doorway', () => {
  it.each(bundle.destinations.filter((destination: { available: boolean }) => destination.available))(
    'routes Point 19 to $label through existing graph connections',
    (destination) => {
      expect(destination.available).toBe(true);
      const route = checkpointRoute(plan, plan.entryId, destination.terminalNodeId)!;
      expect(route[0].id).toBe(plan.entryId);
      expect(route.at(-1)?.id).toBe(destination.terminalNodeId);
      expect(route.at(-1)?.label).toContain(destination.label);
      for (let i = 1; i < route.length; i++) {
        expect(
          plan.edges.some(
            (edge) =>
              (edge.from === route[i - 1].id && edge.to === route[i].id) ||
              (edge.to === route[i - 1].id && edge.from === route[i].id),
          ),
        ).toBe(true);
      }
    },
  );
  it('does not invent a straight connection from an isolated point or mutate source records', () => {
    const before = JSON.stringify(plan);
    const isolated = {
      ...plan,
      nodes: [...plan.nodes, { id: 'isolated', label: 'Isolated', kind: 'photo', x: 600, y: 100 }],
    };
    expect(checkpointRoute(isolated, 'isolated', bundle.destinations[0].terminalNodeId)).toBeNull();
    expect(checkpointRoute(plan, 'unknown', bundle.destinations[0].terminalNodeId)).toBeNull();
    expect(JSON.stringify(plan)).toBe(before);
  });
});
