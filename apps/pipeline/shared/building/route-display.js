import { distance } from "../map.js";

// Display-only composition of a computed route. Routing, costs, collision
// checks and edge paths are untouched; contiguous same-floor steps are joined
// into one polyline per visible floor visit, and only exactly collinear
// interior points are dropped, so every bend is retained.
export function collinearSimplify(points, tolerance = 1e-6) {
  const out = [];
  for (const p of points) {
    if (out.length && distance(out.at(-1), p) < 1e-6) continue;
    while (out.length >= 2) {
      const a = out.at(-2),
        m = out.at(-1),
        cross = (m.x - a.x) * (p.y - m.y) - (m.y - a.y) * (p.x - m.x),
        dot = (m.x - a.x) * (p.x - m.x) + (m.y - a.y) * (p.y - m.y);
      if (Math.abs(cross) > tolerance * Math.max(1, distance(a, p)) || dot < 0)
        break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}

export function routeDisplaySegments(route, floorId) {
  if (!route) return [];
  const segments = [];
  let current = null;
  route.steps.forEach((step, index) => {
    if (step.floorId !== floorId) {
      if (current) segments.push(current);
      current = null;
      return;
    }
    if (current && distance(current.points.at(-1), step.path[0]) < 0.5) {
      current.points.push(...step.path.slice(1));
      current.edgeIds.push(step.edgeId);
      current.lastStep = index;
      current.toNode = step.to;
      return;
    }
    if (current) segments.push(current);
    current = {
      points: [...step.path],
      edgeIds: [step.edgeId],
      firstStep: index,
      lastStep: index,
      fromNode: step.from,
      toNode: step.to,
    };
  });
  if (current) segments.push(current);
  return segments.map((s) => {
    const before = route.steps[s.firstStep - 1],
      after = route.steps[s.lastStep + 1];
    return {
      ...s,
      points: s.points.filter((p, i, a) => !i || distance(p, a[i - 1]) >= 1e-6),
      displayPoints: collinearSimplify(s.points),
      startsRoute: s.firstStep === 0 && s.fromNode === route.startNode,
      endsRoute:
        s.lastStep === route.steps.length - 1 && s.toNode === route.endNode,
      arrivesFrom: before && !before.floorId ? before : null,
      leavesBy: after && !after.floorId ? after : null,
    };
  });
}

// Landings where a route arrives and leaves by floor connectors without
// walking on that floor (e.g. continuing up the same stair).
export function routePassThroughNodes(route) {
  if (!route) return [];
  return route.steps
    .slice(0, -1)
    .map((s, i) => [s, route.steps[i + 1]])
    .filter(([s, next]) => !s.floorId && !next.floorId && s.to === next.from)
    .map(([s, next]) => ({ nodeId: s.to, arrive: s, leave: next }));
}

// One arrowhead per contiguous segment, placed `back` units before the end
// (so it stays visible beside a destination marker) along the final heading.
export function terminalArrow(points, back = 0) {
  if (points.length < 2) return null;
  let remaining = back;
  for (let i = points.length - 1; i > 0; i--) {
    const a = points[i - 1],
      b = points[i],
      len = distance(a, b);
    if (len < 1e-9) continue;
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (remaining < len || i === 1) {
      const t = Math.max(0, (len - Math.min(remaining, len)) / len);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle,
      };
    }
    remaining -= len;
  }
  return null;
}
