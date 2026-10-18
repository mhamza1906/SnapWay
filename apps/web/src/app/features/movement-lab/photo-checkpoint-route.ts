import { findRoute } from '../../core/navigation-engine';
import type { MapDocument } from '../../core/prototype.models';
import type { LabNode, LabPlan } from './movement-model';

export type ConnectionPreference = 'any' | 'stairs' | 'elevator';

/** Reuse the earlier navigation engine with original saved graph nodes, not room centres. */
export function checkpointRoute(
  plan: LabPlan,
  from: string,
  to: string,
  preference: ConnectionPreference = 'any',
): LabNode[] | null {
  const map: MapDocument = {
    nodes: plan.nodes,
    edges: plan.edges
      .filter(
        (edge) =>
          !(preference === 'elevator' && edge.traversal === 'stairs') &&
          !(preference === 'stairs' && edge.traversal === 'elevator'),
      )
      .map((edge, index) => ({
        cost: edge.cost,
        directed: edge.directed,
        id: `saved-edge-${index}`,
        from: edge.from,
        to: edge.to,
        blocked: false,
        // The source graph does not establish step-free accessibility.
        accessible: false,
      })),
    rooms: [],
    annotations: [],
    references: [],
  };
  const route = findRoute(map, from, to);
  if (!route) return null;
  const originals = new Map(plan.nodes.map((node) => [node.id, node]));
  return route.nodes.map((node) => originals.get(node.id)!);
}

/** Sum selected source weights; not a measured travel-time estimate. */
export function checkpointRouteCost(
  plan: LabPlan,
  route: LabNode[],
  preference: ConnectionPreference = 'any',
): number {
  return route.slice(1).reduce((total, node, index) => {
    const previous = route[index];
    const options = plan.edges.filter(
      (edge) =>
        ((edge.from === previous.id && edge.to === node.id) ||
          (!edge.directed && edge.to === previous.id && edge.from === node.id)) &&
        !(preference === 'stairs' && edge.traversal === 'elevator') &&
        !(preference === 'elevator' && edge.traversal === 'stairs'),
    );
    return (
      total +
      Math.min(
        ...options.map((edge) => edge.cost ?? Math.hypot(node.x - previous.x, node.y - previous.y)),
      )
    );
  }, 0);
}
