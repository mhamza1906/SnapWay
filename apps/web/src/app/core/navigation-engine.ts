import type { MapDocument, Waypoint } from './prototype.models';

export interface NavigationRoute {
  nodes: Waypoint[];
  /** Plan coordinates have no verified metric scale in the prototype. */
  planDistance: number;
}

/** Prototype edges are bidirectional; a real API must explicitly specify direction and scale. */
export function findRoute(
  map: MapDocument,
  start: string,
  destination: string,
  accessible = false,
): NavigationRoute | null {
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));
  if (!nodes.has(start) || !nodes.has(destination)) return null;
  if (accessible) {
    const destinationRoom = map.rooms.find((room) => room.id === nodes.get(destination)?.roomId);
    if (destinationRoom && !destinationRoom.accessible) return null;
  }
  const remaining = new Set(nodes.keys());
  const distance = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, string>();
  while (remaining.size) {
    let current: string | undefined;
    let best = Infinity;
    for (const id of remaining) {
      if ((distance.get(id) ?? Infinity) < best) {
        current = id;
        best = distance.get(id)!;
      }
    }
    if (!current) return null;
    if (current === destination) {
      const route = [current];
      while (previous.has(route[0])) route.unshift(previous.get(route[0])!);
      return { nodes: route.map((id) => nodes.get(id)!), planDistance: best };
    }
    remaining.delete(current);
    const origin = nodes.get(current)!;
    for (const edge of map.edges) {
      if (edge.blocked || (accessible && !edge.accessible)) continue;
      const next =
        edge.from === current
          ? edge.to
          : edge.to === current && !edge.directed
            ? edge.from
            : undefined;
      if (!next || !remaining.has(next)) continue;
      const point = nodes.get(next);
      if (!point) continue;
      if (accessible && map.rooms.some((room) => room.id === point.roomId && !room.accessible))
        continue;
      const weight = edge.cost ?? Math.hypot(point.x - origin.x, point.y - origin.y);
      if (!Number.isFinite(weight) || weight < 0) continue;
      const candidate = best + weight;
      if (candidate < (distance.get(next) ?? Infinity)) {
        distance.set(next, candidate);
        previous.set(next, current);
      }
    }
  }
  return null;
}

export function stepInstruction(nodes: Waypoint[], step: number): string {
  const current = nodes[step];
  const next = nodes[step + 1];
  if (!next) return 'You have reached your destination.';
  if (!current || step === 0) return `Head toward ${next.label}.`;
  const previous = nodes[step - 1];
  const cross =
    (current.x - previous.x) * (next.y - current.y) -
    (current.y - previous.y) * (next.x - current.x);
  const dot =
    (current.x - previous.x) * (next.x - current.x) +
    (current.y - previous.y) * (next.y - current.y);
  const angle = (Math.atan2(cross, dot) * 180) / Math.PI;
  const turn =
    Math.abs(angle) > 150
      ? 'Turn around'
      : angle > 30
        ? 'Turn right'
        : angle < -30
          ? 'Turn left'
          : 'Continue';
  return `${turn} toward ${next.label}.`;
}
