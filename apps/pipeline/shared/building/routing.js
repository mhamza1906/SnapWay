import { edgeIssue, pathLength } from "./validation.js";
import { bearing, routeReferences } from "./references.js";
import { roomDoorNodes } from "./endpoints.js";
import { spaceAccessState } from "./access-state.js";
// Availability is independent of a selected route and is recalculated whenever
// the building changes. Draft or isolated rooms remain visible with a reason.
export function roomAvailability(b) {
  const contexts = new Map(),
    usable = b.edges.filter((e) => !e.restricted && !edgeIssue(b, e, { contexts }));
  const adjacency = new Map(b.nodes.map((n) => [n.id, []]));
  for (const e of usable) {
    adjacency.get(e.from)?.push(e.to);
    if (e.direction === "both") adjacency.get(e.to)?.push(e.from);
  }
  const destinations = b.floors.flatMap((f) =>
    f.geometry.spaces
      .filter(
        (s) =>
          !["corridor", "lobby"].includes(s.kind) && s.access !== "nonwalkable",
      )
      .map((s) => ({ roomId: s.id, nodes: roomDoorNodes(b, s.id) })),
  );
  return b.floors.flatMap((f) =>
    f.geometry.spaces
      .filter(
        (s) =>
          !["corridor", "lobby"].includes(s.kind) && s.access !== "nonwalkable",
      )
      .map((s) => {
        let reason = "";
        const starts = destinations.find((r) => r.roomId === s.id).nodes;
        if (f.geometryStatus !== "reviewed")
          reason = `${f.label} needs geometry review`;
        else if (f.graphRevision !== f.revision)
          reason = `${f.label} paths need rebuilding or revalidation`;
        else if (s.access === "unknown")
          reason =
            spaceAccessState(f, s).status === "unresolved"
              ? "Doorway unresolved in source plan"
              : "Doorway not verified";
        else if (!starts.length) reason = "No reviewed doorway node";
        else {
          const seen = new Set(starts.map((n) => n.id)),
            queue = [...seen];
          for (let i = 0; i < queue.length; i++)
            for (const next of adjacency.get(queue[i]) || []) {
              if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
              }
            }
          if (
            !destinations.some(
              (r) => r.roomId !== s.id && r.nodes.some((n) => seen.has(n.id)),
            )
          )
            reason = "No connected walking paths to another room";
        }
        return {
          ...s,
          floorId: f.id,
          floorLabel: f.label,
          ready: !reason,
          reason,
        };
      }),
  );
}

export function routeFailureReason(b, rooms, from, to, options = {}) {
  for (const id of [from, to]) {
    const room = rooms.find((r) => r.id === id);
    if (room && !room.ready)
      return `${room.label} · ${room.floorLabel}: ${room.reason}.`;
  }
  if (options.verifiedAccessible)
    return "No route has verified accessibility for every path and floor connection.";
  if (options.excludeStairs)
    return "No connected stairs-free route. The selected floors or rooms may require stairs.";
  return "No connected route between these rooms. Review corridor joins, floor connections, one-way paths, and restrictions.";
}

export function routeBuilding(
  b,
  startRoomId,
  endRoomId,
  { excludeStairs = false, verifiedAccessible = false, ...overrides } = {},
) {
  const starts = roomDoorNodes(b, startRoomId),
    ends = roomDoorNodes(b, endRoomId);
  if (!starts.length || !ends.length) return null;
  const settings = { ...b.routing, ...overrides },
    allScaled = b.floors
      .filter((f) => b.edges.some((e) => e.floorId === f.id))
      .every((f) => f.geometry.scale),
    costs = new Map(b.nodes.map((n) => [n.id, Infinity])),
    previous = new Map(),
    pending = new Set(b.nodes.map((n) => n.id));
  for (const n of starts) costs.set(n.id, 0);
  const contexts = new Map();
  const usable = b.edges.filter(
    (e) =>
      !e.restricted &&
      (!excludeStairs || e.traversal !== "stairs") &&
      (!verifiedAccessible || e.accessible === "yes") &&
      !edgeIssue(b, e, { contexts }),
  );
  let destination = null;
  const edgeCost = (e) => {
    if (e.traversal === "stairs") return settings.stairsPenalty;
    if (e.traversal === "elevator") return settings.elevatorPenalty;
    const f = b.floors.find((f) => f.id === e.floorId);
    return allScaled
      ? pathLength(e.path) / f.geometry.scale.pixelsPerMetre
      : (pathLength(e.path) / Math.hypot(f.width, f.height)) *
          settings.uncalibratedFloorCost;
  };
  while (pending.size) {
    let id = [...pending].reduce((a, z) =>
      costs.get(a) < costs.get(z) ? a : z,
    );
    pending.delete(id);
    if (!Number.isFinite(costs.get(id))) break;
    if (ends.some((n) => n.id === id)) {
      destination = id;
      break;
    }
    for (const e of usable) {
      const next =
        e.from === id
          ? e.to
          : e.to === id && e.direction === "both"
            ? e.from
            : null;
      if (!next || !pending.has(next)) continue;
      const cost = costs.get(id) + edgeCost(e);
      if (cost < costs.get(next)) {
        costs.set(next, cost);
        previous.set(next, { id, edge: e });
      }
    }
  }
  if (!destination) return null;
  let id = destination;
  const steps = [];
  while (previous.has(id)) {
    const { id: from, edge: e } = previous.get(id),
      forward = e.from === from;
    steps.unshift({
      edgeId: e.id,
      from,
      to: id,
      floorId: e.floorId,
      path: forward ? e.path : [...e.path].reverse(),
      traversal: e.traversal,
      connectorId: e.connectorId,
    });
    id = from;
  }
  const floorIds = [b.nodes.find((n) => n.id === id).floorId];
  for (const step of steps) {
    const floorId = b.nodes.find((n) => n.id === step.to).floorId;
    if (floorIds.at(-1) !== floorId) floorIds.push(floorId);
  }
  const route = {
    steps,
    startRoomId,
    endRoomId,
    sharedDoorway: id === destination && startRoomId !== endRoomId,
    startNode: id,
    endNode: destination,
    cost: costs.get(destination),
    units: allScaled
      ? "metres + transition penalties"
      : "relative cost · unscaled",
    floorIds,
    stairsFree: steps.every((s) => s.traversal !== "stairs"),
    accessible:
      steps.length > 0 &&
      steps.every(
        (s) => b.edges.find((e) => e.id === s.edgeId).accessible === "yes",
      ),
    revision: b.updatedAt,
  };
  if (verifiedAccessible && !steps.length) return null;
  route.instructions = routeInstructions(b, route);
  route.references = routeReferences(b, steps);
  return route;
}
export function routeInstructions(b, route) {
  const node = (id) => b.nodes.find((n) => n.id === id),
    floor = (id) => b.floors.find((f) => f.id === id)?.label,
    room = (id) =>
      b.floors.flatMap((f) => f.geometry.spaces).find((s) => s.id === id)
        ?.label;
  const instructions = [
    {
      text: `Start at ${room(route.startRoomId)} doorway · ${floor(node(route.startNode).floorId)}`,
      floorId: node(route.startNode).floorId,
      position: node(route.startNode).position,
      step: 0,
    },
  ];
  if (route.sharedDoorway)
    instructions.push({
      text: `${room(route.startRoomId)} and ${room(route.endRoomId)} share this doorway. Pass through it to enter ${room(route.endRoomId)}.`,
      floorId: node(route.startNode).floorId,
      position: node(route.startNode).position,
      step: 0,
    });
  let lastBearing = null;
  route.steps.forEach((s, i) => {
    if (!s.floorId) {
      const c = b.connectors.find((c) => c.id === s.connectorId),
        target = node(s.to);
      instructions.push({
        text: `Take ${c.label} to ${floor(target.floorId)}.`,
        floorId: node(s.from).floorId,
        targetFloorId: target.floorId,
        position: node(s.from).position,
        step: i,
      });
      lastBearing = null;
      return;
    }
    for (let j = 1; j < s.path.length; j++) {
      const angle = bearing(s.path[j - 1], s.path[j]);
      if (lastBearing !== null) {
        const turn = ((angle - lastBearing + 540) % 360) - 180;
        if (Math.abs(turn) > 35)
          instructions.push({
            text: `Turn ${turn > 0 ? "right" : "left"}${Math.abs(turn) > 150 ? " to reverse direction" : ""} and continue.`,
            floorId: s.floorId,
            position: s.path[j - 1],
            step: i,
          });
      }
      lastBearing = angle;
    }
  });
  instructions.push({
    text: `Arrive at ${room(route.endRoomId)} doorway · ${floor(node(route.endNode).floorId)}.`,
    floorId: node(route.endNode).floorId,
    position: node(route.endNode).position,
    step: Math.max(0, route.steps.length - 1),
  });
  return instructions;
}
