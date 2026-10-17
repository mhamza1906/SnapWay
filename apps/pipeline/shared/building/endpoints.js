import { inside, pointSegment } from "../map.js";
import { doorNodeProblem } from "./access-state.js";

// A room name resolves to all of its reviewed door openings. Room centroids
// are labels/geometry conveniences, never room-to-room route endpoints.
// Unknown or non-walkable access never yields an endpoint, even if a stale
// door node or a valid polygon remains.
export function roomDoorNodes(b, roomId) {
  const f = b.floors.find((f) =>
    f.geometry.spaces.some((s) => s.id === roomId),
  );
  if (!f || f.geometryStatus !== "reviewed" || f.graphRevision !== f.revision)
    return [];
  if (
    ["nonwalkable", "unknown"].includes(
      f.geometry.spaces.find((s) => s.id === roomId)?.access,
    )
  )
    return [];
  return b.nodes.filter((n) => {
    if (
      n.floorId !== f.id ||
      n.status !== "reviewed" ||
      !n.doorId ||
      !n.spaceIds.includes(roomId)
    )
      return false;
    const d = f.geometry.doors.find((d) => d.id === n.doorId);
    return (
      d?.spaceIds.includes(roomId) &&
      !doorNodeProblem(f, d.id) &&
      pointSegment(n.position, d.a, d.b) < 0.5 &&
      n.spaceIds.every((id) =>
        f.geometry.spaces.some(
          (s) => s.id === id && inside(n.position, s.polygon),
        ),
      )
    );
  });
}

export function roomTransitEdge(b, edge) {
  const a = b.nodes.find((n) => n.id === edge.from),
    z = b.nodes.find((n) => n.id === edge.to);
  if (!a?.doorId || !z?.doorId || a.floorId !== z.floorId) return false;
  const f = b.floors.find((f) => f.id === a.floorId);
  return f?.geometry.spaces.some(
    (s) =>
      !["corridor", "lobby"].includes(s.kind) &&
      a.spaceIds.includes(s.id) &&
      z.spaceIds.includes(s.id),
  );
}
