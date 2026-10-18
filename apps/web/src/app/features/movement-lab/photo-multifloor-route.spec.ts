// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkpointRoute, checkpointRouteCost } from './photo-checkpoint-route';
import type { LabPlan } from './movement-model';
const bundle = JSON.parse(
  readFileSync(
    new URL('../../../../public/experiments/photo-building-navigation.json', import.meta.url),
    'utf8',
  ),
);
const plan = bundle as LabPlan;
const edgeBetween = (from: string, to: string) =>
  plan.edges.filter(
    (edge) =>
      (edge.from === from && edge.to === to) ||
      (!edge.directed && edge.to === from && edge.from === to),
  );
describe('Existing building routes across floors', () => {
  it('includes all saved rooms and landings on six floors, preserving original photo IDs', () => {
    expect(bundle.floors).toHaveLength(6);
    expect(bundle.destinations).toHaveLength(86);
    expect(bundle.photoReferenceFloorIds).toEqual(['L1']);
    const original = JSON.parse(
      readFileSync(
        new URL('../../../../public/experiments/entrance-node19.json', import.meta.url),
        'utf8',
      ),
    );
    for (const node of original.nodes)
      expect(plan.nodes.find((value) => value.id === node.id)).toMatchObject(node);
  });
  it('reaches every available named destination through actual source edges', () => {
    for (const place of bundle.destinations.filter(
      (value: { available: boolean }) => value.available,
    )) {
      const route = place.terminalNodeIds
        .map((id: string) => checkpointRoute(plan, plan.entryId, id))
        .find(Boolean);
      expect(route, `${place.floorLabel} ${place.label}`).toBeTruthy();
      expect(route[0].id).toBe(plan.entryId);
      expect(place.terminalNodeIds).toContain(route.at(-1).id);
      for (let i = 1; i < route.length; i++)
        expect(edgeBetween(route[i - 1].id, route[i].id).length).toBeGreaterThan(0);
    }
  });
  it.each(['stairs', 'elevator'] as const)('uses only %s for floor changes', (preference) => {
    const destination = bundle.destinations.find(
      (value: { floorId: string; kind: string; available: boolean }) =>
        value.floorId === 'L5' && value.kind === 'room' && value.available,
    );
    const route = checkpointRoute(plan, plan.entryId, destination.terminalNodeId, preference)!;
    expect(route).toBeTruthy();
    expect(route.some((node) => node.floorId === 'L5')).toBe(true);
    let changes = 0;
    for (let i = 1; i < route.length; i++)
      if (route[i - 1].floorId !== route[i].floorId) {
        changes++;
        expect(
          edgeBetween(route[i - 1].id, route[i].id).some((edge) => edge.traversal === preference),
        ).toBe(true);
      }
    expect(changes).toBeGreaterThan(0);
    expect(checkpointRouteCost(plan, route, preference)).toBeGreaterThan(0);
  });
  it('respects directed source edges and normalized costs', () => {
    const minimal: LabPlan = {
      ...plan,
      nodes: [
        { id: 'a', label: 'a', kind: 'junction', x: 0, y: 0 },
        { id: 'b', label: 'b', kind: 'junction', x: 0, y: 0 },
      ],
      edges: [{ from: 'a', to: 'b', directed: true, cost: 3, traversal: 'elevator' }],
    };
    expect(checkpointRoute(minimal, 'b', 'a')).toBeNull();
    expect(checkpointRoute(minimal, 'a', 'b', 'stairs')).toBeNull();
    const route = checkpointRoute(minimal, 'a', 'b', 'elevator')!;
    expect(checkpointRouteCost(minimal, route)).toBe(3);
  });
});
