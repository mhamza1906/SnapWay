import { clone, distance } from "../map.js";
import { pathLength } from "./validation.js";
export const bearing = (a, b) =>
  ((Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI + 360) % 360;
export const angleDifference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
export function projectToPath(point, path) {
  let best = { distance: Infinity, along: 0, position: path[0], segment: 0 },
    total = pathLength(path),
    done = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i],
      len = distance(a, b);
    if (!len) continue;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) /
          (len * len),
      ),
    );
    const position = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
      d = distance(point, position);
    if (d < best.distance)
      best = {
        distance: d,
        along: (done + t * len) / total,
        position,
        segment: i - 1,
      };
    done += len;
  }
  return best;
}
export function pointAlong(path, t) {
  let remaining = pathLength(path) * t;
  for (let i = 1; i < path.length; i++) {
    const len = distance(path[i - 1], path[i]);
    if (remaining <= len)
      return {
        x: path[i - 1].x + ((path[i].x - path[i - 1].x) * remaining) / len,
        y: path[i - 1].y + ((path[i].y - path[i - 1].y) * remaining) / len,
      };
    remaining -= len;
  }
  return path.at(-1);
}
export function splitEdge(building, edgeId, t = 0.5) {
  if (t <= 0.01 || t >= 0.99) throw new Error("Split must be inside the edge.");
  const b = clone(building),
    e = b.edges.find((e) => e.id === edgeId);
  if (!e?.floorId) throw new Error("Select a same-floor path to split.");
  const position = pointAlong(e.path, t),
    projection = projectToPath(position, e.path),
    f = b.floors.find((f) => f.id === e.floorId),
    nodeId = e.id + ":split";
  if (b.nodes.some((n) => n.id === nodeId))
    throw new Error("This path has already been split.");
  const from = b.nodes.find((n) => n.id === e.from),
    to = b.nodes.find((n) => n.id === e.to);
  const spaceIds = from.spaceIds.filter((id) => to.spaceIds.includes(id));
  // For paths spanning a doorway, use the actual containing space at the split.
  const { inside } = referenceGeometry;
  const actual = spaceIds.length
    ? spaceIds
    : f.geometry.spaces
        .filter((s) => inside(position, s.polygon))
        .map((s) => s.id);
  b.nodes.push({
    id: nodeId,
    floorId: f.id,
    label: "Path split",
    type: "bend",
    position,
    spaceIds: actual,
    doorId: null,
    connectorId: null,
    status: e.status,
  });
  const first = {
    ...e,
    id: e.id + ":a",
    to: nodeId,
    path: [...e.path.slice(0, projection.segment + 1), position],
    photoIds: [],
  };
  const second = {
    ...e,
    id: e.id + ":b",
    from: nodeId,
    path: [position, ...e.path.slice(projection.segment + 1)],
    photoIds: [],
  };
  for (const part of [first, second]) {
    part.path = part.path.filter(
      (p, i, ps) => !i || distance(p, ps[i - 1]) > 0.001,
    );
    part.length =
      pathLength(part.path) / (f.geometry.scale?.pixelsPerMetre || 1);
  }
  b.edges = b.edges.filter((x) => x.id !== e.id);
  b.edges.push(first, second);
  for (const p of b.photos.filter((p) => p.edgeId === e.id)) {
    const along = p.along ?? projectToPath(p.position, e.path).along;
    const target = along <= t ? first : second;
    p.edgeId = target.id;
    p.along = along <= t ? along / t : (along - t) / (1 - t);
    target.photoIds.push(p.id);
    if (Math.abs(along - t) < 0.001) {
      p.status = "stale";
      p.issue =
        "Image is exactly at the split; confirm its side or associate it with the new decision node.";
    }
  }
  return b;
}
import * as referenceGeometry from "../map.js";
export function deleteEdge(building, id) {
  const b = clone(building);
  b.edges = b.edges.filter((e) => e.id !== id);
  for (const p of b.photos.filter((p) => p.edgeId === id)) {
    p.status = "stale";
    p.issue = "Associated path was deleted; choose a new edge or node.";
  }
  return b;
}
export function routeReferences(b, steps) {
  return steps.flatMap((step, index) => {
    const e = b.edges.find((e) => e.id === step.edgeId);
    if (!e.floorId)
      return [
        {
          step: index,
          missing: true,
          label: "Floor transition: no reference image",
        },
      ];
    const path = step.path,
      photos = b.photos.filter(
        (p) =>
          p.status === "reviewed" &&
          !p.issue &&
          p.floorId === e.floorId &&
          (p.edgeId === e.id || p.nodeId === step.from || p.nodeId === step.to),
      );
    const usable = photos
      .map((p) => {
        const projection = projectToPath(p.position, path);
        const travel = bearing(
          path[projection.segment],
          path[projection.segment + 1],
        );
        return {
          ...p,
          travelAlong: projection.along,
          facing: angleDifference(p.direction, travel),
        };
      })
      .filter((p) => p.facing <= 60)
      .sort((a, b) => a.travelAlong - b.travelAlong || a.facing - b.facing);
    return usable.length
      ? usable.map((photo) => ({ step: index, photo, missing: false }))
      : [
          {
            step: index,
            missing: true,
            label: "No forward-facing reference for this path",
          },
        ];
  });
}
