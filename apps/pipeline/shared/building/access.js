import polygonClipping from "polygon-clipping";
import {
  clone,
  centre,
  distance,
  inside,
  intersection,
  midpoint,
  pointSegment,
  MapSchema,
} from "../map.js";
import { geometryChanged } from "./schema.js";
import { buildGraph } from "./graph.js";
import { roomDoorNodes } from "./endpoints.js";
import { edgeIssue, geometryIssues } from "./validation.js";
import { traceBoundaryWalls } from "./coverage.js";
import { coverageSummary } from "./coverage-status.js";
import { mergeProposal, sourceFeatureId } from "./preparation.js";
import {
  ACCESS_VERSION,
  AccessRecordSchema,
  OPENING_TYPES,
  doorAccessState,
  doorRecord,
  reconcileAccessFlags,
  spaceAccessState,
  regionNeedsSemanticReview,
} from "./access-state.js";

export const MAX_OPENING_WIDTH = {
  door: 14,
  "double-door": 26,
  "exterior-door": 26,
  "open-passage": Infinity,
  "decomposition-join": Infinity,
};
// These are image-pixel sanity limits, not measured physical widths. Preserve
// the original 1280px-source limits while handling higher-resolution uploads
// and source-to-floor scale changes in the same coordinate frame.
export function openingWidthLimit(floor, spaceId, type) {
  const source = floor.sources?.find(s => spaceId.startsWith(s.id + ":") || s.geometryIds?.includes(spaceId));
  const imageScale = source ? Math.max(1, source.width / 1280) : 1,
    floorScale = source ? Math.hypot(source.transform[0], source.transform[1]) : 1;
  return MAX_OPENING_WIDTH[type] * imageScale * floorScale;
}
const destination = (s) =>
  !["corridor", "lobby"].includes(s.kind) && s.access !== "nonwalkable";
const area = (p) =>
  Math.abs(
    p.reduce((n, a, i) => {
      const z = p[(i + 1) % p.length];
      return n + a.x * z.y - z.x * a.y;
    }, 0) / 2,
  );
const ring = (p) => [[...p.map((v) => [v.x, v.y]), [p[0].x, p[0].y]]];
const unring = (r) => r.slice(0, -1).map(([x, y]) => ({ x, y }));
const edges = (s) =>
  s.polygon.map((a, i) => [a, s.polygon[(i + 1) % s.polygon.length], i]);
const cross = (u, v) => u.x * v.y - u.y * v.x;

// Collinear overlap of two segments in any orientation.
export function segmentOverlap(p, q, r, s, tolerance = 0.6) {
  const len = distance(p, q);
  if (len < 0.01) return null;
  const u = { x: (q.x - p.x) / len, y: (q.y - p.y) / len },
    off = (v) => Math.abs(cross(u, { x: v.x - p.x, y: v.y - p.y })),
    t = (v) => (v.x - p.x) * u.x + (v.y - p.y) * u.y;
  if (off(r) > tolerance || off(s) > tolerance) return null;
  const lo = Math.max(0, Math.min(t(r), t(s))),
    hi = Math.min(len, Math.max(t(r), t(s)));
  if (hi - lo < 0.5) return null;
  return {
    a: { x: p.x + u.x * lo, y: p.y + u.y * lo },
    b: { x: p.x + u.x * hi, y: p.y + u.y * hi },
    length: hi - lo,
  };
}

export function regionBoundary(floor, spaceId) {
  const g = floor.geometry,
    space = g.spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error(`Unknown region ${spaceId}`);
  const xs = space.polygon.map((p) => p.x),
    ys = space.polygon.map((p) => p.y);
  return {
    spaceId,
    label: space.label,
    kind: space.kind,
    access: space.access || "known",
    centre: centre(space.polygon),
    bbox: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    area: Math.round(area(space.polygon) * 10) / 10,
    edges: edges(space).map(([a, b, index]) => ({
      index,
      a,
      b,
      length: Math.round(distance(a, b) * 100) / 100,
      neighbours: g.spaces
        .filter((o) => o.id !== spaceId)
        .flatMap((o) =>
          edges(o)
            .map(([r, s]) => segmentOverlap(a, b, r, s))
            .filter(Boolean)
            .map((overlap) => ({
              spaceId: o.id,
              label: o.label,
              kind: o.kind,
              access: o.access || "known",
              overlap,
            })),
        ),
      doors: g.doors
        .filter(
          (d) =>
            d.spaceIds.includes(spaceId) && segmentOverlap(a, b, d.a, d.b, 0.6),
        )
        .map((d) => d.id),
    })),
    doors: g.doors
      .filter((d) => d.spaceIds.includes(spaceId))
      .map((d) => ({
        id: d.id,
        label: d.label,
        a: d.a,
        b: d.b,
        spaceIds: d.spaceIds,
        evidence: doorAccessState(floor, d).state,
      })),
    status: spaceAccessState(floor, space),
  };
}

// Deterministic geometry checks. Model coordinates are snapped onto the
// nearest shared boundary only within a small tolerance.
export function validateOpening(floor, candidate, { snap = 2.5 } = {}) {
  const g = floor.geometry,
    failures = [],
    fail = (code, message) => failures.push({ code, message });
  const { spaceId, adjacentId = null, openingType, a, b } = candidate;
  if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite))
    return {
      passed: false,
      failures: [{ code: "coordinates", message: "Endpoints must be finite" }],
    };
  const space = g.spaces.find((s) => s.id === spaceId),
    other = adjacentId ? g.spaces.find((s) => s.id === adjacentId) : null;
  if (!OPENING_TYPES.includes(openingType))
    fail("type", `Unsupported opening type ${openingType}`);
  if (!space) fail("reference", `Unknown region ${spaceId}`);
  if (adjacentId && !other)
    fail("reference", `Unknown adjacent region ${adjacentId}`);
  if (openingType === "exterior-door" && adjacentId)
    fail("type", "An exterior door links exactly one mapped region");
  if (openingType !== "exterior-door" && !adjacentId)
    fail("type", "Interior openings need an adjacent region");
  if (adjacentId && adjacentId === spaceId)
    fail("reference", "An opening needs two different regions");
  for (const s of [space, other].filter(Boolean))
    if (s.access === "nonwalkable")
      fail("nonwalkable", `${s.label} is non-walkable`);
  if (failures.length) return { passed: false, failures };
  const lines = other
    ? edges(space).flatMap(([p, q]) =>
        edges(other)
          .map(([r, s]) => segmentOverlap(p, q, r, s))
          .filter(Boolean),
      )
    : edges(space).map(([p, q]) => ({ a: p, b: q, length: distance(p, q) }));
  if (!lines.length)
    return {
      passed: false,
      failures: [
        {
          code: "adjacency",
          message: `${space.label} and ${other.label} share no boundary`,
        },
      ],
    };
  const project = (p, l) => {
    const len = distance(l.a, l.b),
      u = { x: (l.b.x - l.a.x) / len, y: (l.b.y - l.a.y) / len },
      t = (p.x - l.a.x) * u.x + (p.y - l.a.y) * u.y;
    return {
      t,
      len,
      point: { x: l.a.x + u.x * t, y: l.a.y + u.y * t },
      offset: Math.abs(cross(u, { x: p.x - l.a.x, y: p.y - l.a.y })),
    };
  };
  // The nearest shared line, preferring (within the snap distance) one that
  // contains the opening: raster outlines can put separate shared stretches on
  // one line, and the opening belongs to the stretch it lies on. A line that
  // passes both checks was already the nearest, so passing openings are unchanged.
  const offset = (x) => Math.max(x.pa.offset, x.pb.offset),
    beyond = (x) => Math.min(x.pa.t, x.pb.t) < -0.25 || Math.max(x.pa.t, x.pb.t) > x.pa.len + 0.25;
  const best = lines
    .map((l) => ({ l, pa: project(a, l), pb: project(b, l) }))
    .sort(
      (x, z) =>
        (offset(x) > snap) - (offset(z) > snap) ||
        beyond(x) - beyond(z) ||
        offset(x) - offset(z),
    )[0];
  if (Math.max(best.pa.offset, best.pb.offset) > snap)
    fail(
      "off-boundary",
      `Endpoints are ${Math.max(best.pa.offset, best.pb.offset).toFixed(1)} px from the nearest ${other ? "shared" : "region"} boundary`,
    );
  if (
    Math.min(best.pa.t, best.pb.t) < -0.25 ||
    Math.max(best.pa.t, best.pb.t) > best.pa.len + 0.25
  )
    fail(
      "outside-boundary",
      `Opening extends beyond the ${other ? "shared wall" : "region edge"} (${best.pa.len.toFixed(1)} px long)`,
    );
  const segment = { a: best.pa.point, b: best.pb.point },
    width = distance(segment.a, segment.b);
  if (width < 2) fail("degenerate", "Opening is narrower than 2 px");
  const widthLimit = openingWidthLimit(floor, spaceId, openingType);
  if (width > widthLimit)
    fail(
      "width",
      `${openingType} is ${width.toFixed(1)} px wide; limit ${widthLimit.toFixed(1)} px in this source frame`,
    );
  if (
    [segment.a, segment.b].some(
      (p) => p.x < 0 || p.y < 0 || p.x > floor.width || p.y > floor.height,
    )
  )
    fail("bounds", "Opening lies outside the floor frame");
  const m = midpoint(segment.a, segment.b),
    len = width || 1,
    n = {
      x: -(segment.b.y - segment.a.y) / len,
      y: (segment.b.x - segment.a.x) / len,
    },
    sides = [1, -1].map((k) => ({ x: m.x + n.x * k * 1.5, y: m.y + n.y * k * 1.5 })),
    containing = (p) =>
      g.spaces
        .filter((s) => s.access !== "nonwalkable" && inside(p, s.polygon))
        .map((s) => s.id);
  if (width >= 2) {
    const [one, two] = sides.map(containing);
    if (other) {
      if (
        !(
          (one.includes(space.id) && two.includes(other.id)) ||
          (two.includes(space.id) && one.includes(other.id))
        )
      )
        fail("sides", "The two sides of the opening are not the named regions");
    } else if (
      !(
        (one.includes(space.id) && !two.length) ||
        (two.includes(space.id) && !one.length)
      )
    )
      fail(
        "not-exterior",
        "An exterior door must open from the region to unmapped exterior space",
      );
  }
  for (const d of g.doors) {
    const o = segmentOverlap(segment.a, segment.b, d.a, d.b, 0.6);
    if (o && o.length > 0.5)
      fail("overlaps-door", `Overlaps existing opening ${d.id}`);
  }
  for (const w of g.walls)
    for (let i = 1; i < w.points.length; i++) {
      const p = w.points[i - 1],
        q = w.points[i];
      if (segmentOverlap(segment.a, segment.b, p, q, 0.6)) continue;
      const hit = intersection(segment.a, segment.b, p, q);
      if (
        hit &&
        hit.t > 0.05 &&
        hit.t < 0.95 &&
        Math.min(distance(hit, p), distance(hit, q)) > 0.5
      )
        fail("crossed-by-wall", `Wall ${w.id} crosses the opening`);
    }
  return {
    passed: !failures.length,
    failures,
    segment,
    width: Math.round(width * 100) / 100,
  };
}

// Cut collinear wall pieces under a new opening (or a merged-away boundary).
export function cutWallGap(walls, a, b, tolerance = 0.6) {
  const out = [];
  for (const w of walls) {
    let pieces = [],
      current = [w.points[0]],
      changed = false;
    for (let i = 1; i < w.points.length; i++) {
      const p = w.points[i - 1],
        q = w.points[i],
        o = segmentOverlap(p, q, a, b, tolerance);
      if (!o || o.length < 0.05) {
        current.push(q);
        continue;
      }
      changed = true;
      const len = distance(p, q),
        t = (v) => ((v.x - p.x) * (q.x - p.x) + (v.y - p.y) * (q.y - p.y)) / len,
        [lo, hi] = [t(o.a), t(o.b)].sort((x, z) => x - z),
        at = (k) => ({
          x: p.x + ((q.x - p.x) * k) / len,
          y: p.y + ((q.y - p.y) * k) / len,
        });
      if (lo > 0.05) current.push(at(lo));
      if (current.length > 1) pieces.push(current);
      current = hi < len - 0.05 ? [at(hi), q] : [q];
    }
    if (current.length > 1) pieces.push(current);
    if (!changed) out.push(w);
    else
      pieces.forEach((points, k) =>
        out.push({ id: k ? `${w.id}:gap-${k}` : w.id, points }),
      );
  }
  return out;
}

// Boundary-traced walls (`[floorId:]spaceId:w:…`) are regenerated for
// affected regions; other walls are cut or closed so manual walls survive.
export function reconcileWalls(geometry, floorId, spaceIds, added, removed) {
  const prefixes = new Map(),
    owned = (w) => {
      for (const id of spaceIds) {
        if (w.id.startsWith(`${floorId}:${id}:w:`)) return [id, floorId + ":"];
        if (w.id.startsWith(`${id}:w:`)) return [id, ""];
      }
      return null;
    };
  for (const w of geometry.walls) {
    const o = owned(w);
    if (o && !prefixes.has(o[0])) prefixes.set(o[0], o[1]);
  }
  let walls = geometry.walls.filter((w) => !owned(w));
  for (const d of added) walls = cutWallGap(walls, d.a, d.b);
  for (const s of geometry.spaces.filter((s) => spaceIds.includes(s.id)))
    walls.push(
      ...traceBoundaryWalls({ ...geometry, spaces: [s] }).map((w) => ({
        ...w,
        id: (prefixes.get(s.id) ?? "") + w.id,
      })),
    );
  for (const d of removed)
    if (!d.spaceIds.some((id) => prefixes.has(id)))
      walls.push({ id: `${d.id}:closed`, points: [d.a, d.b] });
  const seen = new Set();
  geometry.walls = walls.map((w) => {
    let id = w.id;
    for (let k = 1; seen.has(id); k++) id = `${w.id}:${k}`;
    seen.add(id);
    return id === w.id ? w : { ...w, id };
  });
}

// Subtract a new region from overlapping regions, keeping their IDs.
export function carveSpace(geometry, space) {
  const changed = [];
  for (const s of geometry.spaces) {
    let pieces;
    try {
      pieces = polygonClipping
        .difference(ring(s.polygon), ring(space.polygon))
        .map((p) => unring(p[0]))
        .filter((p) => area(p) > 0.5)
        .sort((x, z) => area(z) - area(x));
    } catch {
      continue;
    }
    const before = area(s.polygon);
    if (!pieces.length) throw new Error(`Carving would remove ${s.label}`);
    if (Math.abs(area(pieces[0]) - before) < 0.01) continue;
    if (pieces.length > 1 && area(pieces[1]) > 2)
      throw new Error(`Carving would split ${s.label} into separate pieces`);
    s.polygon = pieces[0];
    changed.push(s.id);
  }
  geometry.spaces.push(space);
  return [...changed, space.id];
}

// ---- User region edits: rename, stair use, kind, merge -------------------
// Names the pipeline gives regions it could not identify; a merge keeps a real one.
const GENERIC_LABEL = /^\s*(unlabell?ed|hallway|open lobby)/i;
export const REGION_LABEL_MAX = 120;
export const MERGE_SNAP = 2; // px; hairline gaps between model-traced outlines
const MERGE_WALL_TOLERANCE = 1.5; // px; walls this close to a merged-away boundary go
export function regionLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label || label.length > REGION_LABEL_MAX)
    throw new Error(`Enter a region name of 1–${REGION_LABEL_MAX} characters.`);
  return label;
}
const regionState = (s) => ({ kind: s.kind, access: s.access || null, label: s.label, use: s.use || null });
// Roles a developer can give a region (op set-space-kind). Each one sets kind,
// use and access together:
//   room       kind room: a destination.
//   hall-room  kind room, use "hall": a destination that also works as a hall
//              (a hallway for doorway placement, a centreline circulation area).
//   corridor, lobby  circulation; never destinations.
//   stair      kind lobby, use "stair" (as set-space-use stair).
//   closed     use "closed", access "nonwalkable", kind unchanged: drawn on the
//              map, never a destination or routed through, never given
//              doorways; its doors stay, unused, until it is re-opened by any
//              other role.
export const SPACE_KINDS = ["room", "hall-room", "corridor", "lobby", "stair", "closed"];
const ROLES = {
  room: { kind: "room" },
  "hall-room": { kind: "room", use: "hall" },
  corridor: { kind: "corridor" },
  lobby: { kind: "lobby" },
  stair: { kind: "lobby", use: "stair" },
};
// A region's current role; "nonwalkable" for a region made non-walkable other
// than by closing it, and its kind (for example restroom) when no role fits.
export function spaceRole(s) {
  if (s.use === "closed") return "closed";
  if (s.access === "nonwalkable") return "nonwalkable";
  if (s.use === "stair") return "stair";
  if (s.use === "hall") return "hall-room";
  return s.kind;
}
// Re-opening restores the access a region had before it was closed or made
// non-walkable (null: known), or "unknown" when that is not recorded.
function reopenedAccess(floor, spaceId) {
  const r = (floor.access?.records || []).findLast((r) =>
    r.spaceId === spaceId && r.kind === "classification" && r.status === "accepted" &&
    r.change?.to.access === "nonwalkable" && r.change.from.access !== "nonwalkable");
  return r ? r.change.from.access : "unknown";
}
const boundaryDistance = (p, poly) => {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, pointSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return best;
};
const projectOnto = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y,
    t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return { x: a.x + t * dx, y: a.y + t * dy };
};
const perimeter = (p) => p.reduce((n, a, i) => n + distance(a, p[(i + 1) % p.length]), 0);
const bbox = (p) => {
  const xs = p.map((v) => v.x), ys = p.map((v) => v.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const boxesTouch = (a, b, pad = 1) => a.x0 <= b.x1 + pad && b.x0 <= a.x1 + pad && a.y0 <= b.y1 + pad && b.y0 <= a.y1 + pad;
const polyEdges = (p) => p.map((a, i) => [a, p[(i + 1) % p.length]]);

// Model-traced outlines can leave hairline gaps between neighbours. A vertex
// within `tolerance` of another outline is pinned onto it (onto a vertex when
// one is about as close, otherwise onto the nearest edge point).
function snapOutlines(polygons, tolerance) {
  const out = polygons.map((p) => p.map((v) => ({ ...v })));
  const onto = (i, j) => {
    const target = out[j];
    for (const v of out[i]) {
      let edge = null;
      for (const [a, b] of polyEdges(target)) {
        const q = projectOnto(v, a, b), d = distance(v, q);
        if (!edge || d < edge.d) edge = { d, p: q };
      }
      if (!edge || edge.d <= 1e-9 || edge.d > tolerance) continue;
      const vertex = target.map((t) => ({ d: distance(v, t), p: t })).sort((x, z) => x.d - z.d)[0];
      const p = vertex.d <= Math.min(tolerance, edge.d + 0.25) ? vertex.p : edge.p;
      v.x = p.x;
      v.y = p.y;
    }
  };
  for (let j = 1; j < out.length; j++) for (let i = 0; i < j; i++) onto(j, i);
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) onto(i, j);
  return out;
}
function simplifyRing(points) {
  const round = (v) => ({ x: Math.round(v.x * 1e6) / 1e6, y: Math.round(v.y * 1e6) / 1e6 });
  let p = points.map(round).filter((v, i, all) => distance(v, all[(i + 1) % all.length]) >= 0.01);
  for (let i = 0; i < p.length && p.length > 3; ) {
    if (pointSegment(p[i], p[(i + p.length - 1) % p.length], p[(i + 1) % p.length]) < 0.01) {
      p.splice(i, 1);
      i = Math.max(0, i - 1);
    } else i++;
  }
  return p;
}

// One outline for several regions. They must form one connected piece across
// shared edges; hairline gaps up to `snap` px are closed first. The result
// never spills into `others` (the floor's remaining regions).
export function mergeOutlines(polygons, { snap = MERGE_SNAP, others = [], maxGap = 0, bridges = [], keepHoles = false, seams = [], avoid = [] } = {}) {
  const solid = (mp) => mp.filter((p) => area(unring(p[0])) > 0.5);
  const union = (list) => solid(polygonClipping.union(...list.map(ring)));
  let pieces, snapped = false;
  try {
    pieces = union(polygons);
    if (pieces.length > 1) {
      pieces = union(snapOutlines(polygons, snap));
      snapped = true;
    }
    // Rooms that are close but do not touch: join the two nearest pieces with
    // a short bridge across the gap, until one piece remains (gaps up to maxGap).
    while (pieces.length > 1 && maxGap > snap) {
      const rings = pieces.map((p) => unring(p[0]));
      let best = null;
      for (let i = 0; i < rings.length; i++)
        for (let j = i + 1; j < rings.length; j++) {
          const c = closestApproach(rings[i], rings[j]);
          if (!best || c.d < best.d) best = { ...c, ringA: rings[i], ringB: rings[j] };
        }
      if (!best || best.d > maxGap) break;
      const width = Math.min(maxGap, Math.max(12, best.d)),
        // Touching at a corner: aim the bridge from one outline's middle to the other's.
        mid = (r) => ({ x: r.reduce((n, v) => n + v.x, 0) / r.length, y: r.reduce((n, v) => n + v.y, 0) / r.length }),
        dir = best.d < 1e-6 ? (() => { const a = mid(best.ringA), b = mid(best.ringB), l = distance(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; })() : null;
      bridges.push({ ...best, width, dir });
      pieces = solid(polygonClipping.union(...pieces, ring(bridgeQuad(best.p, best.q, width, dir))));
      snapped = true;
    }
  } catch (e) {
    throw new Error(`These outlines could not be combined (${e.message}).`);
  }
  if (pieces.length !== 1)
    throw new Error(maxGap > snap ? "Rooms must be close to each other to be merged." : "Regions must share a boundary to be merged.");
  const [outer, ...holes] = pieces[0].map(unring);
  // Sliver holes are gaps between outlines, and a hole no region occupies is
  // unmapped space (filled); a hole holding another region is a real hole.
  const occupied = (h) => {
    let n = 0;
    for (const o of others) { try { n += polygonClipping.intersection(ring(h), ring(o)).reduce((m, x) => m + area(unring(x[0])), 0); } catch { /* skip */ } }
    return n > 0.05 * area(h);
  };
  const real = holes.filter((h) => area(h) > 4 && (2 * area(h)) / perimeter(h) > snap && occupied(h));
  if (real.length && !keepHoles)
    throw new Error("The merged region would surround an area that is not part of it; include that area too or merge fewer regions.");
  let polygon = outer;
  // Regions are single rings: a hole another region keeps (a corridor looping
  // round a room) is opened by a narrow seam from the hole to the outer edge
  // at the shortest crossing. The seam becomes its own small region, joined to
  // the merged one on both sides (see mergeRegions).
  let seamed = false;
  if (real.length) {
    // Simplify first: simplifying after the seam is cut would close the slit again.
    const outerS = simplifyRing(outer), realS = real.map(simplifyRing);
    const rects = [], sides = [];
    for (const h of realS) {
      const c = seamCrossing(h, outerS, avoid), len = distance(c.p, c.q);
      if (len < 1e-6) continue;
      const u = { x: (c.q.x - c.p.x) / len, y: (c.q.y - c.p.y) / len }, n = { x: -u.y * SEAM_WIDTH / 2, y: u.x * SEAM_WIDTH / 2 };
      rects.push(bridgeQuad(c.p, c.q, SEAM_WIDTH));
      sides.push([[{ x: c.p.x + n.x, y: c.p.y + n.y }, { x: c.q.x + n.x, y: c.q.y + n.y }], [{ x: c.p.x - n.x, y: c.p.y - n.y }, { x: c.q.x - n.x, y: c.q.y - n.y }]]);
    }
    const shape = [outerS, ...realS].map((r) => [...r.map((v) => [v.x, v.y]), [r[0].x, r[0].y]]);
    let opened;
    try { opened = solid(polygonClipping.difference(shape, ...rects.map(ring))); } catch (e) { throw new Error(`These outlines could not be combined (${e.message}).`); }
    if (opened.length !== 1 || opened[0].length !== 1)
      throw new Error("The merged region would surround an area that is not part of it; include that area too or merge fewer regions.");
    polygon = unring(opened[0][0]);
    // A seam long enough for a doorway becomes its own small region joined on
    // both sides; a shorter one (the hole almost touches the edge) stays a gap.
    rects.forEach((r, k) => {
      const strip = solid(polygonClipping.intersection(shape, ring(r)));
      if (strip.length === 1 && distance(sides[k][0][0], sides[k][0][1]) >= SEAM_MIN_LENGTH) seams.push({ polygon: unring(strip[0][0]), sides: sides[k] });
    });
    snapped = true;
    seamed = true;
  }
  if (snapped || holes.length) {
    const box = bbox(polygon), near = others.filter((o) => boxesTouch(bbox(o), box));
    if (near.length) {
      const cut = solid(polygonClipping.difference(ring(polygon), ...near.map(ring)));
      if (cut.length !== 1)
        throw new Error(bridges.length ? "Another region lies between these rooms; include it or choose rooms that are closer." : "Regions must share a boundary to be merged.");
      polygon = unring(cut[0][0]);
    }
  }
  if (!seamed) {
    polygon = simplifyRing(polygon);
    // Simplifying can nudge a corner into a neighbour: cut neighbours back out,
    // keeping the main piece (crumbs under 2 px² are dropped).
    const box = bbox(polygon), near = others.filter((o) => boxesTouch(bbox(o), box));
    if (near.length) {
      let cut = [];
      try { cut = solid(polygonClipping.difference(ring(polygon), ...near.map(ring))).sort((x, z) => area(unring(z[0])) - area(unring(x[0]))); } catch { cut = []; }
      if (cut.length && cut.slice(1).every((c) => area(unring(c[0])) < 2) && cut[0].length === 1) polygon = unring(cut[0][0]);
    }
  }
  polygon = dedupeRing(polygon);
  for (const sm of seams) sm.polygon = dedupeRing(sm.polygon);
  if (polygon.length < 3 || area(polygon) < 2) throw new Error("The merged outline is degenerate.");
  return polygon;
}

// What a merge of close rooms takes from the regions between them. Only the
// part directly between the rooms is taken (across their facing sides): a
// region mostly inside that zone (80%+), or one the merged outline would
// surround, is taken whole; otherwise only its part in the zone is cut off
// and the rest stays the same region. Returns { absorb: ids taken whole,
// carve: [{ id, zone }] }.
const ringArea = (mp) => mp.reduce((n, p) => n + area(unring(p[0])), 0);
const SEAM_WIDTH = 3, SEAM_MIN_LENGTH = 4, BETWEEN_MARGIN = 4, CLOSET_SHARE = 0.25;
// Clipping can leave near-identical neighbouring points; drop them (and the
// closing duplicate) so outlines pass the duplicate-vertex check.
const dedupeRing = (r) => {
  const out = [];
  for (const v of r) if (!out.length || distance(out.at(-1), v) >= 0.02) out.push(v);
  while (out.length > 1 && distance(out[0], out.at(-1)) < 0.02) out.pop();
  return out;
};
const clipArea = (op, a, ...b) => { try { return ringArea(op(ring(a), ...b.map(ring))); } catch { return 0; } };
// Between two bridged outlines: the band across both facing sides, from one to the other.
function betweenZone(br, maxGap) {
  const len = distance(br.p, br.q), u = len > 1e-6 ? { x: (br.q.x - br.p.x) / len, y: (br.q.y - br.p.y) / len }
      : (() => { const [s0, t0] = br.edgeP, l = distance(s0, t0) || 1; return { x: -(t0.y - s0.y) / l, y: (t0.x - s0.x) / l }; })(),
    n = { x: -u.y, y: u.x }, dot = (v, w) => v.x * w.x + v.y * w.y,
    span = (r) => r.reduce(([lo, hi], v) => [Math.min(lo, dot(v, n)), Math.max(hi, dot(v, n))], [Infinity, -Infinity]),
    [a0, a1] = span(br.ringA), [b0, b1] = span(br.ringB);
  let lo = Math.max(a0, b0), hi = Math.min(a1, b1);
  if (hi - lo < br.width) { const c = dot(br.p, n); lo = c - br.width / 2; hi = c + br.width / 2; }
  // Only the gap itself (plus a few px), not the full reach into the rooms beside it.
  const s0 = dot(br.p, u) - BETWEEN_MARGIN, s1 = dot(br.q, u) + BETWEEN_MARGIN,
    at = (s, t) => ({ x: u.x * s + n.x * t, y: u.y * s + n.y * t });
  return [at(s0, lo), at(s1, lo), at(s1, hi), at(s0, hi)];
}
// Merge types: hallways (corridors, lobbies), stairs and rooms (everything
// else) only merge with their own type.
export const mergeType = (s) => (s.use === "stair" ? "stair" : ["corridor", "lobby", "hallway"].includes(s.kind) ? "hallway" : "room");
const MERGE_TYPE_NAMES = { hallway: "hallways", stair: "stairs", room: "rooms" };
export function planMerge(g, spaceIds, maxGap) {
  let keepHoles = false;
  const absorb = [], zones = new Map(),
    type = mergeType(g.spaces.find((s) => s.id === spaceIds[0]) || {}),
    blocked = (o, why) => {
      const kind = mergeType(o), what = kind === "hallway" ? "a hallway" : kind === "stair" ? "a stair" : "a room";
      throw new Error(kind === type
        ? `${o.label} ${why}.`
        : `${o.label} (${what}) ${why}, and only ${MERGE_TYPE_NAMES[type]} can be merged with ${MERGE_TYPE_NAMES[type]}. Merge fewer or closer pieces.`);
    };
  const shapeOf = (s) => {
    const z = zones.get(s.id);
    if (!z) return [s.polygon];
    try { return polygonClipping.difference(ring(s.polygon), ...z.map(ring)).map((p) => unring(p[0])).filter((r) => area(r) > 0.5); } catch { return [s.polygon]; }
  };
  const takenPart = (s) => {
    try { return polygonClipping.intersection(ring(s.polygon), polygonClipping.union(...zones.get(s.id).map(ring))).map((p) => unring(p[0])).filter((r) => area(r) > 0.5); } catch { return []; }
  };
  for (let round = 0; round < 12; round++) {
    const ids = [...spaceIds, ...absorb], set = new Set(ids),
      inputs = ids.map((id) => g.spaces.find((s) => s.id === id));
    if (inputs.some((s) => !s)) break;
    // Only regions near the chosen ones can lie between them or be surrounded.
    const box = inputs.reduce((b, s) => { for (const v of s.polygon) { b.x0 = Math.min(b.x0, v.x); b.y0 = Math.min(b.y0, v.y); b.x1 = Math.max(b.x1, v.x); b.y1 = Math.max(b.y1, v.y); } return b; },
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }),
      nearBox = (s) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const v of s.polygon) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
        return x0 <= box.x1 + maxGap && x1 >= box.x0 - maxGap && y0 <= box.y1 + maxGap && y1 >= box.y0 - maxGap;
      };
    const others = g.spaces.filter((s) => !set.has(s.id) && nearBox(s)),
      shapes = [...inputs.map((s) => s.polygon), ...others.filter((o) => zones.has(o.id)).flatMap(takenPart)],
      bridges = [];
    try {
      mergeOutlines(shapes, { others: others.flatMap(shapeOf), maxGap, bridges, keepHoles });
      break;
    } catch (e) {
      if (!/lies between|surround/.test(e.message)) throw e;
      let added = false;
      const quads = bridges.map((br) => betweenZone(br, maxGap));
      for (const o of others) {
        if (absorb.includes(o.id)) continue;
        for (const zone of quads) {
          const free = clipArea(polygonClipping.difference, zone, ...inputs.map((s) => s.polygon));
          if (!free) continue;
          const inZone = clipArea(polygonClipping.intersection, o.polygon, zone);
          if (inZone <= 1) continue;
          // Between rooms: part of a corridor may be taken, a small room (closet)
          // whole; between hallways: only hallway pieces. Stairs are never taken.
          const kind = mergeType(o), sameType = kind === type,
            corridorPart = type === "room" && kind === "hallway";
          if (kind === "stair" || (!sameType && !corridorPart)) blocked(o, "lies between them");
          // A room is never cut: a small closet wholly between is taken whole, any other room blocks.
          if (sameType) {
            const smallest = Math.min(...inputs.slice(0, spaceIds.length).map((s) => area(s.polygon)));
            if (inZone >= 0.8 * area(o.polygon) && (type !== "room" || area(o.polygon) <= CLOSET_SHARE * smallest)) { absorb.push(o.id); zones.delete(o.id); added = true; break; }
            if (type === "room") blocked(o, "lies between them; include it in the merge to join across it");
          }
          const prev = zones.get(o.id) || [];
          if (!prev.some((z) => JSON.stringify(z) === JSON.stringify(zone))) { zones.set(o.id, [...prev, zone]); added = true; }
        }
      }
      let outer = [];
      try { outer = polygonClipping.union(...[...shapes, ...bridges.map((b) => bridgeQuad(b.p, b.q, b.width))].map(ring)).map((p) => unring(p[0])); } catch { /* keep the bridge zones */ }
      // A region the merged outline would surround is taken only if it is the same type.
      for (const o of others)
        if (!absorb.includes(o.id) && outer.some((r) => inside(centre(o.polygon), r))) {
          // Another type (a room inside a corridor loop) stays itself: the merged
          // region keeps it as a hole, opened by a seam.
          if (mergeType(o) !== type) { if (!keepHoles) { keepHoles = true; added = true; } continue; }
          absorb.push(o.id); zones.delete(o.id); added = true;
        }
      if (!added) throw e;
    }
  }
  return { absorb, carve: [...zones].map(([id, z]) => ({ id, zone: z })), keepHoles };
}
// Cuts the carve zones out of their regions: each region keeps its largest
// remaining piece (and its id); other remaining pieces become new regions
// (`<id>:part-<k>`); the taken parts become temporary regions
// (`<id>:between-<k>`) for the merge. Doors follow the piece they lie on; a
// door on none of them (inside the taken part) is dropped. Mutates `g`.
function applyCarves(g, carve) {
  const between = [], parts = [], whole = [], trimmed = [];
  for (const { id, zone } of carve) {
    const s = g.spaces.find((x) => x.id === id);
    if (!s) continue;
    const zoneShape = polygonClipping.union(...zone.map(ring)),
      keep = polygonClipping.difference(ring(s.polygon), zoneShape).map((p) => dedupeRing(unring(p[0]))).filter((r) => r.length >= 3 && area(r) > 2).sort((x, z) => area(z) - area(x)),
      taken = polygonClipping.intersection(ring(s.polygon), zoneShape).map((p) => dedupeRing(unring(p[0]))).filter((r) => r.length >= 3 && area(r) > 2);
    if (!taken.length) continue;
    if (!keep.length) { whole.push(id); continue; }
    const pieces = [{ id, polygon: keep[0] }];
    s.polygon = keep[0];
    keep.slice(1).forEach((polygon, k) => {
      const part = { ...clone(s), id: `${id}:part-${k + 1}`, polygon };
      g.spaces.push(part); parts.push(part.id); pieces.push(part);
    });
    taken.forEach((polygon, k) => {
      const t = { ...clone(s), id: `${id}:between-${k + 1}`, polygon };
      g.spaces.push(t); between.push(t.id); pieces.push(t);
    });
    const edgesOf = (poly) => poly.map((v, i) => [v, poly[(i + 1) % poly.length]]),
      alongOneEdge = (d, poly) => edgesOf(poly).some(([v, w]) => pointSegment(d.a, v, w) <= 2.5 && pointSegment(d.b, v, w) <= 2.5);
    g.doors = g.doors.flatMap((d) => {
      if (!d.spaceIds.includes(id)) return [d];
      const whole = pieces.find((p) => alongOneEdge(d, p.polygon));
      if (whole) return [{ ...d, spaceIds: d.spaceIds.map((v) => (v === id ? whole.id : v)) }];
      // A doorway the cut runs through is trimmed to the edge it keeps.
      const mid = { x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 };
      for (const p of pieces) {
        const edge = edgesOf(p.polygon).find(([v, w]) => pointSegment(mid, v, w) < 1.5) ||
          edgesOf(p.polygon).find(([v, w]) => pointSegment(d.a, v, w) < 1.5 || pointSegment(d.b, v, w) < 1.5);
        if (!edge) continue;
        const [v, w] = edge, len = distance(v, w) || 1, t = (pt) => Math.max(0, Math.min(1, ((pt.x - v.x) * (w.x - v.x) + (pt.y - v.y) * (w.y - v.y)) / (len * len))),
          at = (k) => ({ x: v.x + (w.x - v.x) * k, y: v.y + (w.y - v.y) * k }), a = at(t(d.a)), b = at(t(d.b));
        if (distance(a, b) < 2) continue;
        const next = { ...d, a, b, spaceIds: d.spaceIds.map((x) => (x === id ? p.id : x)) };
        trimmed.push(next);
        return [next];
      }
      return [];
    });
  }
  return { between, parts, whole, trimmed };
}
// Removes the stretches of walls lying inside `polygon` (more than `margin`
// from its edge): walls between merged rooms no longer separate anything.
function cutInteriorWalls(walls, polygon, margin = 1.5) {
  const deep = (pt) => inside(pt, polygon) && polygon.every((v, i) => pointSegment(pt, v, polygon[(i + 1) % polygon.length]) > margin);
  const out = [];
  for (const w of walls) {
    let current = [w.points[0]], changed = false, k = 0;
    const flush = () => { if (current.length >= 2) out.push({ ...w, id: k ? `${w.id}:${k}` : w.id, points: current }); k++; };
    for (let i = 1; i < w.points.length; i++) {
      const p = w.points[i - 1], q = w.points[i], ts = [0, 1];
      for (let j = 0; j < polygon.length; j++) {
        const hit = intersection(p, q, polygon[j], polygon[(j + 1) % polygon.length]);
        if (hit) ts.push(Math.max(0, Math.min(1, hit.t)));
      }
      ts.sort((x, z) => x - z);
      const at = (t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      for (let m = 1; m < ts.length; m++) {
        if (ts[m] - ts[m - 1] < 1e-9) continue;
        if (deep(at((ts[m - 1] + ts[m]) / 2))) {
          changed = true;
          if (current.length && distance(current.at(-1), at(ts[m - 1])) > 1e-9) current.push(at(ts[m - 1]));
          flush(); current = [at(ts[m])];
        } else if (distance(current.at(-1), at(ts[m])) > 1e-9) current.push(at(ts[m]));
      }
    }
    if (!changed) { out.push(w); continue; }
    flush();
  }
  return out;
}

// The closest points of two outlines (p on a, q on b) and the edges they lie on.
function closestApproach(a, b) {
  let best = { d: Infinity };
  const near = (v, s, t) => {
    const dx = t.x - s.x, dy = t.y - s.y, len2 = dx * dx + dy * dy || 1,
      k = Math.max(0, Math.min(1, ((v.x - s.x) * dx + (v.y - s.y) * dy) / len2));
    return { x: s.x + k * dx, y: s.y + k * dy };
  };
  const scan = (from, to, flip) => {
    for (let i = 0; i < from.length; i++)
      for (let j = 0; j < to.length; j++) {
        const s = to[j], t = to[(j + 1) % to.length], q = near(from[i], s, t), d = distance(from[i], q);
        if (d < best.d) {
          const own = [from[i], from[(i + 1) % from.length]], other = [s, t];
          best = flip ? { d, p: q, q: from[i], edgeP: other, edgeQ: own } : { d, p: from[i], q, edgeP: own, edgeQ: other };
        }
      }
  };
  scan(a, b, false);
  scan(b, a, true);
  return best;
}
// Where a seam crosses from a hole to the outer edge: the shortest crossing
// whose two ends keep clear of every doorway in `avoid` (a seam through a
// doorway would split it), sampling the hole's edge every 2 px; the plain
// shortest crossing when none is clear.
function seamCrossing(hole, outer, avoid) {
  const clear = (pt) => avoid.every((d) => pointSegment(pt, d.a, d.b) > SEAM_WIDTH + 1),
    nearestOn = (pt, ring) => {
      let best = null;
      for (let j = 0; j < ring.length; j++) {
        const s0 = ring[j], t0 = ring[(j + 1) % ring.length], dx = t0.x - s0.x, dy = t0.y - s0.y, l2 = dx * dx + dy * dy || 1,
          k = Math.max(0, Math.min(1, ((pt.x - s0.x) * dx + (pt.y - s0.y) * dy) / l2)), q = { x: s0.x + k * dx, y: s0.y + k * dy }, d = distance(pt, q);
        if (!best || d < best.d) best = { q, d };
      }
      return best;
    };
  let best = null;
  if (avoid.length)
    for (let i = 0; i < hole.length; i++) {
      const a = hole[i], b = hole[(i + 1) % hole.length], steps = Math.max(1, Math.ceil(distance(a, b) / 2));
      for (let k = 0; k < steps; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps };
        if (!clear(p)) continue;
        const n = nearestOn(p, outer);
        if (n && clear(n.q) && (!best || n.d < best.d)) best = { d: n.d, p, q: n.q };
      }
    }
  return best || closestApproach(hole, outer);
}

// A rectangle `width` wide from p to q, reaching 2 px into both outlines.
function bridgeQuad(p, q, width, dir = null) {
  const len = distance(p, q), u = len > 1e-6 ? { x: (q.x - p.x) / len, y: (q.y - p.y) / len } : dir || { x: 1, y: 0 },
    n = { x: -u.y * width / 2, y: u.x * width / 2 }, e = 2,
    a = { x: p.x - u.x * e, y: p.y - u.y * e }, b = { x: q.x + u.x * e, y: q.y + u.y * e };
  return [{ x: a.x + n.x, y: a.y + n.y }, { x: b.x + n.x, y: b.y + n.y }, { x: b.x - n.x, y: b.y - n.y }, { x: a.x - n.x, y: a.y - n.y }];
}
// The stretch of an outline edge centred on p, `width` long: where a bridge
// meets the outline, so the wall there can be opened.
function bridgeMouth(edge, p, width) {
  const [s, t] = edge, len = distance(s, t);
  if (len < 1e-6) return null;
  const u = { x: (t.x - s.x) / len, y: (t.y - s.y) / len };
  return { a: { x: p.x - u.x * width / 2, y: p.y - u.y * width / 2 }, b: { x: p.x + u.x * width / 2, y: p.y + u.y * width / 2 } };
}

// Stretches of boundary two of the outlines share that end up inside the
// merged region; walls along them no longer separate anything.
function sharedStretches(polygons, merged, tolerance) {
  const out = [];
  for (let i = 0; i < polygons.length; i++)
    for (let j = i + 1; j < polygons.length; j++) {
      if (!boxesTouch(bbox(polygons[i]), bbox(polygons[j]), tolerance)) continue;
      for (const [a, b] of polyEdges(polygons[i]))
        for (const [r, s] of polyEdges(polygons[j])) {
          const o = segmentOverlap(a, b, r, s, tolerance);
          if (o && boundaryDistance(midpoint(o.a, o.b), merged) > 0.5) out.push(o);
        }
    }
  return out;
}

// Merges regions into the first one, whose ID is kept so references stay
// valid. Doors between merged regions are removed, doors onto other regions
// are re-pointed, and walls on the merged-away boundaries are cut. Mutates `g`.
export function mergeRegions(g, spaceIds, { label, use, maxGap = 0, named = 1, keepHoles = false } = {}) {
  if (!Array.isArray(spaceIds) || spaceIds.length < 2) throw new Error("Choose at least two regions to merge.");
  if (new Set(spaceIds).size !== spaceIds.length) throw new Error("Each region can be listed only once.");
  if (use !== undefined && use !== null && use !== "stair") throw new Error("A region's use is either stair or none.");
  const inputs = spaceIds.map((id) => {
    const s = g.spaces.find((s) => s.id === id);
    if (!s) throw new Error(`Unknown region ${id}`);
    return s;
  });
  const ids = new Set(spaceIds), [kept, ...gone] = inputs, goneIds = new Set(gone.map((s) => s.id)),
    outlines = inputs.map((s) => s.polygon), from = regionState(kept), bridges = [], seams = [],
    polygon = mergeOutlines(outlines, { others: g.spaces.filter((s) => !ids.has(s.id)).map((s) => s.polygon), maxGap, bridges, keepHoles, seams, avoid: g.doors });
  const name = label === undefined || label === null || (typeof label === "string" && !label.trim())
    ? (inputs.slice(0, named).find((s) => !GENERIC_LABEL.test(s.label)) || kept).label
    : regionLabel(label);
  // Omitted `use` keeps a stair only when every merged region is one.
  const stair = use === "stair" || (use === undefined && inputs.every((s) => s.use === "stair")),
    walkable = inputs.filter((s) => s.access !== "nonwalkable");
  kept.polygon = polygon;
  kept.label = name;
  // The merged region is what the first (kept) region was: merging pieces into
  // a hallway gives a hallway, never a big room. A stair stays a stair only as
  // described above; a kept stair that is not one any more becomes a room.
  const keptUse = from.use;
  kept.kind = stair ? "lobby" : keptUse === "stair" ? "room" : from.kind;
  if (stair) kept.use = "stair";
  else if (keptUse && keptUse !== "stair") kept.use = keptUse;
  else delete kept.use;
  kept.confidence = Math.min(...inputs.map((s) => s.confidence));
  // Access follows the doors: the transaction flags the region unknown when
  // no usable doorway remains.
  if (!walkable.length) kept.access = stair ? "unknown" : "nonwalkable";
  else if (walkable.every((s) => s.access === "unknown")) kept.access = "unknown";
  else delete kept.access;
  g.spaces = g.spaces.filter((s) => !goneIds.has(s.id));
  const map = (id) => (goneIds.has(id) ? kept.id : id), remap = (list) => [...new Set(list.map(map))];
  const internal = g.doors.filter((d) => d.spaceIds.length === 2 && d.spaceIds.every((id) => ids.has(id))),
    internalIds = new Set(internal.map((d) => d.id));
  g.doors = g.doors
    .filter((d) => !internalIds.has(d.id))
    .map((d) => (d.spaceIds.some((id) => goneIds.has(id)) ? { ...d, spaceIds: remap(d.spaceIds) } : d));
  for (const o of sharedStretches(outlines, polygon, MERGE_SNAP))
    g.walls = cutWallGap(g.walls, o.a, o.b, MERGE_WALL_TOLERANCE);
  // Open the walls where a bridge meets each room, so the merged room is one space.
  for (const br of bridges)
    for (const m of [bridgeMouth(br.edgeP, br.p, br.width), bridgeMouth(br.edgeQ, br.q, br.width)])
      if (m) g.walls = cutWallGap(g.walls, m.a, m.b, MERGE_WALL_TOLERANCE);
  // Pieces taken from a region between the rooms leave walls inside the merged room.
  if (bridges.length || spaceIds.some((id) => id.includes(":between-"))) g.walls = cutInteriorWalls(g.walls, polygon);
  g.pois = g.pois.map((p) => (goneIds.has(p.spaceId) ? { ...p, spaceId: kept.id } : p));
  const nodes = g.graph.nodes.filter((n) => !internalIds.has(n.doorId)).map((n) => ({ ...n, spaceIds: remap(n.spaceIds) })),
    nodeIds = new Set(nodes.map((n) => n.id));
  g.graph = { nodes, edges: g.graph.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)) };
  // Seams that open a kept hole: small regions of the same kind, joined to the
  // merged region on both sides by open circulation joins.
  const seamIds = seams.map((sm, k) => {
    const id = `${kept.id}:seam-${k + 1}`;
    g.spaces.push({ ...clone(kept), id, polygon: sm.polygon });
    sm.sides.forEach(([a, b], j) => g.doors.push({ id: `coverage-open-${id}-${j + 1}`, label: "Open circulation join", a, b, spaceIds: [kept.id, id], confidence: 1 }));
    return id;
  });
  return { keptId: kept.id, removedIds: [...goneIds], internal, inputs: inputs.map(regionState), from, to: regionState(kept), seamIds };
}

// References outside the geometry (access records, nav overrides, connector
// landings, source coverage, presentation) follow merged regions to the kept ID.
function remapRegionReferences(b, f, remap, droppedDoors) {
  const map = (id) => remap.get(id) ?? id, list = (ids) => [...new Set(ids.map(map))];
  for (const r of f.access.records) {
    if (remap.has(r.spaceId)) r.spaceId = map(r.spaceId);
    if (r.adjacentIds.some((id) => remap.has(id))) r.adjacentIds = list(r.adjacentIds);
  }
  f.navOverrides = (f.navOverrides || []).filter((o) => !remap.has(o.spaceId) && !droppedDoors.has(o.doorId));
  for (const n of b.nodes) if (n.floorId === f.id && n.spaceIds.some((id) => remap.has(id))) n.spaceIds = list(n.spaceIds);
  for (const s of f.sources) {
    s.geometryIds = s.geometryIds.filter((id) => !remap.has(id) && !droppedDoors.has(id));
    for (const i of s.coverage?.items || []) if (i.spaceId && remap.has(i.spaceId)) i.spaceId = map(i.spaceId);
  }
  for (const id of remap.keys()) if (f.presentation?.rooms) delete f.presentation.rooms[id];
}

// New regions, doors and traced walls join the source section that owns the
// region they were derived from, so section checks and rescans stay coherent.
export function assignSourceOwnership(floor, previous) {
  const old = new Set(
      ["spaces", "doors", "walls"].flatMap((k) => previous[k].map((x) => x.id)),
    ),
    owner = (id) =>
      floor.sources.find(
        (s) => id.startsWith(s.id + ":") || s.geometryIds.includes(id),
      );
  const pending = [
    ...floor.geometry.spaces.filter((s) => !old.has(s.id)).map((s) => [s.id, s]),
    ...floor.geometry.doors.filter((d) => !old.has(d.id)).map((d) => [d.id, d]),
    ...floor.geometry.walls.filter((w) => !old.has(w.id)).map((w) => [w.id, w]),
  ];
  for (const [id, item] of pending) {
    if (owner(id)) continue;
    const touches = (s) =>
        s.polygon.some((p) =>
          edges(item).some(([a, b]) => pointSegment(p, a, b) < 0.6),
        ),
      related = floor.geometry.spaces.filter((s) =>
        s.id === id
          ? false
          : item.polygon
            ? touches(s)
            : item.spaceIds
              ? item.spaceIds.includes(s.id)
              : id.includes(s.id + ":w:"),
      );
    const source = related.map((s) => owner(s.id)).find(Boolean);
    if (source && !source.geometryIds.includes(id)) source.geometryIds.push(id);
  }
}
export function newAccessRecord(fields) {
  return AccessRecordSchema.parse({
    attemptedChecks: [],
    adjacentIds: [],
    review: { status: "unreviewed", reviewer: "", at: null, notes: "" },
    createdAt: new Date().toISOString(),
    version: ACCESS_VERSION,
    ...fields,
  });
}

// Access tiers are reported separately so an inventory or a polygon is never
// presented as proof that a room can route.
export function accessInventory(building, rooms = null) {
  const floors = building.floors.map((f) => {
    const items = f.sources.flatMap((s) => s.coverage?.items || []),
      summaries = f.sources.map((s) => coverageSummary(f, s)),
      states = f.geometry.spaces.map((s) => ({
        space: s,
        ...spaceAccessState(f, s),
      })),
      count = (status, pick = () => true) =>
        states.filter((x) => x.status === status && pick(x.space)).length,
      dests = states.filter((x) => destination(x.space));
    const priority = {
      missing: 0,
      "stale-unknown": 1,
      unknown: 2,
      unresolved: 3,
    };
    return {
      floorId: f.id,
      label: f.label,
      inventory: {
        total: items.length,
        accounted: summaries.reduce(
          (n, x) => n + (x.mapped || 0) + (x.excluded?.length || 0),
          0,
        ),
        excluded: items.filter((i) => i.excluded).length,
      },
      regions: f.geometry.spaces.length,
      destinations: dests.length,
      verified: count("verified", destination),
      legacy: count("legacy", destination),
      assumed: count("assumed", destination),
      destinationsVerified: dests.filter((x) =>
        ["verified", "legacy"].includes(x.status),
      ).length,
      unresolved: count("unresolved"),
      unknown: count("unknown") + count("stale-unknown") + count("missing"),
      nonwalkable: count("nonwalkable"),
      ready: rooms
        ? rooms.filter((r) => r.floorId === f.id && r.ready).length
        : null,
      queue: states
        .filter((x) => x.status in priority)
        .sort((x, z) => priority[x.status] - priority[z.status])
        .map((x) => ({
          spaceId: x.space.id,
          label: x.space.label,
          kind: x.space.kind,
          status: x.status,
          reason: x.reason,
          record: x.record || null,
        })),
      records: f.access?.records || [],
    };
  });
  return { floors };
}

// Builds the affected floor graph on a copy and checks doorway endpoints,
// collisions and reachability. The live project is untouched.
export function checkRouteAccess(building, floorId, geometry, spaceIds) {
  const b = clone(building),
    f = b.floors.find((f) => f.id === floorId);
  f.geometry = clone(geometry);
  f.geometryStatus = "reviewed";
  // Existing proposed/rejected openings must stay blocked on the draft too.
  // The newly appended candidate has its own ID and needs no record removal.
  f.revision++;
  let built;
  try {
    built = buildGraph(b, floorId);
  } catch (e) {
    return { passed: false, message: e.message, results: [] };
  }
  return { ...routeAccessResults(built, floorId, spaceIds), building: built };
}
export function routeAccessResults(built, floorId, spaceIds) {
  const f = built.floors.find((f) => f.id === floorId),
    contexts = new Map();
  const usable = built.edges.filter(
      (e) => !e.restricted && !edgeIssue(built, e, { contexts }),
    ),
    adjacency = new Map(built.nodes.map((n) => [n.id, []]));
  for (const e of usable) {
    adjacency.get(e.from)?.push(e.to);
    if (e.direction === "both") adjacency.get(e.to)?.push(e.from);
  }
  const roomDoors = new Map();
  for (const x of built.floors)
    for (const s of x.geometry.spaces.filter(destination))
      for (const n of roomDoorNodes(built, s.id))
        roomDoors.set(n.id, [...(roomDoors.get(n.id) || []), s.id]);
  const results = spaceIds.map((id) => {
    const s = f.geometry.spaces.find((s) => s.id === id);
    if (!s) return { spaceId: id, passed: false, message: "Region missing" };
    if (s.access === "nonwalkable")
      return { spaceId: id, passed: true, message: "Non-walkable; no route" };
    // Rooms start at their doorways. Corridors and lobbies are crossed by the
    // centreline, so any of their reviewed junctions is a valid start.
    const circulation = ["corridor", "lobby"].includes(s.kind);
    let starts = built.nodes.filter(
      (n) =>
        n.floorId === floorId &&
        (n.doorId || (circulation && n.type === "junction")) &&
        n.spaceIds.includes(id) &&
        n.status === "reviewed",
    );
    // A corridor piece can be crossed by the spine without holding a vertex.
    if (!starts.length && circulation) {
      const through = built.edges.filter(
        (e) => e.floorId === floorId && e.path.some((p, i) => {
          if (!i) return false;
          const m = midpoint(e.path[i - 1], p);
          // The merged area's centreline can run along the seam between pieces.
          return inside(m, s.polygon) || s.polygon.some((v, k) => pointSegment(m, v, s.polygon[(k + 1) % s.polygon.length]) <= 1.5);
        }),
      );
      starts = built.nodes.filter(
        (n) => n.status === "reviewed" && through.some((e) => e.from === n.id || e.to === n.id),
      );
    }
    if (!starts.length)
      return { spaceId: id, passed: false, message: "No valid doorway node" };
    const bad = built.edges.filter(
      (e) => starts.some((n) => [e.from, e.to].includes(n.id)) && edgeIssue(built, e, { contexts }),
    );
    if (bad.length)
      return {
        spaceId: id,
        passed: false,
        message: `Doorway path ${bad[0].id}: ${edgeIssue(built, bad[0], { requireReviewed: false, contexts }) || edgeIssue(built, bad[0], { contexts })}`,
      };
    const own = new Set(starts.map((n) => n.id)),
      seen = new Set(own),
      queue = [...own];
    for (let i = 0; i < queue.length; i++)
      for (const next of adjacency.get(queue[i]) || [])
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    const reached = [...seen].filter((n) =>
      (roomDoors.get(n) || []).some((room) => room !== id),
    );
    if (destination(s) && !roomDoorNodes(built, id).length)
      return {
        spaceId: id,
        passed: false,
        message: "Room has no usable doorway endpoint",
      };
    return reached.length
      ? {
          spaceId: id,
          passed: true,
          message: `Doorway reaches ${reached.length} other room doorway nodes without wall crossings`,
        }
      : {
          spaceId: id,
          passed: false,
          message: "Doorway is isolated from other rooms",
        };
  });
  return {
    passed: results.every((r) => r.passed),
    message: results.map((r) => r.message).join("; "),
    results,
  };
}

// Applies a transaction of accepted access decisions. Every opening passes
// validation and route checks before the project changes; nothing else does.
export function applyAccessDecisions(
  building,
  floorId,
  decisions,
  { reviewer, reviewStatus = "human-reviewed", notes = "", reason } = {},
) {
  if (!reviewer?.trim()) throw new Error("Record who accepted these decisions.");
  if (decisions.some((d) => d.op === "replace-source")) {
    if (decisions.length !== 1) throw new Error("Apply source replacement as a separate transaction.");
    return applySourceProposal(building, floorId, decisions[0], { reviewer, notes });
  }
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const g = clone(floor.geometry),
    view = () => ({ ...floor, geometry: g }),
    affected = new Set(),
    added = [],
    removed = [],
    records = [],
    now = new Date().toISOString();
  const errorsBefore = new Set(
    geometryIssues(floor)
      .filter((i) => i.severity === "error")
      .map((i) => i.message),
  );
  // User region edits. Merges run first so later edits see the merged IDs.
  const remap = new Map(),
    superseded = new Set(),
    relabelled = new Set(),
    droppedDoors = new Set();
  let seq = 0;
  const recordId = (base) => `${base}:${Date.now().toString(36)}-${seq++}`,
    resolve = (id) => {
      while (remap.has(id)) id = remap.get(id);
      return id;
    },
    region = (id) => {
      const s = g.spaces.find((s) => s.id === resolve(id));
      if (!s) throw new Error(`Unknown region ${id}`);
      return s;
    },
    tracedWalls = (id) => g.walls.some((w) => w.id.startsWith(`${floorId}:${id}:w:`) || w.id.startsWith(`${id}:w:`)),
    manual = (description) => ({ method: "manual", description: description.slice(0, 3000), crops: [] });
  // Unmerge: put back both regions of a recorded two-region merge, as they were
  // before it, with the doors, walls and points of interest it changed. Only a
  // merge whose kept region still has the merged outline can be undone (undo a
  // later merge of that region first).
  const unmerged = [], mergeUndos = [];
  for (const d of decisions.filter((d) => d.op === "unmerge-spaces")) {
    const rec = floor.access.records.find((r) => r.id === d.recordId), u = rec?.merge;
    if (!u) throw new Error("Unknown merge.");
    if (u.undone) throw new Error("That merge was already undone.");
    const kept = g.spaces.find((s) => s.id === u.keptId);
    if (!kept) throw new Error(`${u.kept.label} is no longer on the map, so this merge can't be undone.`);
    const removedAll = u.removedAll?.length ? u.removedAll : [u.removed];
    const back = removedAll.find((r) => g.spaces.some((s) => s.id === r.id));
    if (back) throw new Error(`${back.label} is already on the map.`);
    const same = kept.polygon.length === u.after.length &&
      kept.polygon.every((p, i) => Math.abs(p.x - u.after[i].x) < 1e-6 && Math.abs(p.y - u.after[i].y) < 1e-6);
    if (!same) throw new Error(`${kept.label} changed shape after this merge; unmerge its later merge first.`);
    const from = regionState(kept);
    g.spaces = g.spaces.map((s) => (s.id === u.keptId ? clone(u.kept) : s));
    g.spaces.push(...removedAll.map(clone));
    // Regions the merge only cut into get their whole shape back; pieces split off go.
    const parts = new Set(u.carvedParts || []);
    g.spaces = g.spaces.filter((s) => !parts.has(s.id));
    for (const c of u.carved || []) {
      if (g.spaces.some((s) => s.id === c.id)) g.spaces = g.spaces.map((s) => (s.id === c.id ? clone(c) : s));
      else g.spaces.push(clone(c));
    }
    let restoredDoors;
    if (u.doorsBefore?.length) {
      // Every doorway of the regions involved returns exactly as it was.
      const involved = new Set([u.keptId, ...removedAll.map((r) => r.id), ...(u.carved || []).map((c) => c.id), ...parts]),
        before = new Set(u.doorsBefore.map((x) => x.id));
      const same = (x, y) => distance(x.a, y.a) < 1e-6 && distance(x.b, y.b) < 1e-6 && JSON.stringify(x.spaceIds) === JSON.stringify(y.spaceIds);
      restoredDoors = u.doorsBefore.filter((x) => { const y = g.doors.find((z) => z.id === x.id); return !y || !same(x, y); }).map(clone);
      g.doors = [...g.doors.filter((x) => !before.has(x.id) && !x.spaceIds.some((id) => involved.has(id))), ...u.doorsBefore.map(clone)];
    } else {
      for (const r of u.repointedDoors) {
        const door = g.doors.find((x) => x.id === r.id);
        if (door) door.spaceIds = [...r.spaceIds];
      }
      restoredDoors = u.internalDoors.filter((x) => !g.doors.some((y) => y.id === x.id)).map(clone);
      g.doors.push(...restoredDoors);
    }
    const addedWalls = new Set(u.addedWallIds);
    g.walls = g.walls.filter((w) => !addedWalls.has(w.id));
    g.walls.push(...u.removedWalls.filter((w) => !g.walls.some((x) => x.id === w.id)).map(clone));
    const poiHome = new Map([...(u.poiIds || []).map((id) => [id, u.removedId]), ...(u.pois || []).map((p) => [p.id, p.spaceId])]);
    g.pois = g.pois.map((p) => (poiHome.has(p.id) ? { ...p, spaceId: poiHome.get(p.id) } : p));
    [u.keptId, ...removedAll.map((r) => r.id)].forEach((id) => superseded.add(id));
    relabelled.add(u.keptId);
    unmerged.push({ recordId: rec.id, u, restoredDoors });
    records.push({
      id: recordId(`${u.keptId}:unmerged`),
      kind: "classification",
      status: "accepted",
      spaceId: u.keptId,
      change: { from, to: regionState(u.kept) },
      reason: `${removedAll.map((r) => r.label).join(", ")} unmerged from ${from.label}; the regions are back as they were before the merge.`.slice(0, 3000),
      evidence: manual(`Undid merge record ${rec.id} in the editor.`),
    });
  }
  // A doorway put back by an unmerge returns as it was before the merge: the
  // geometry is restored exactly, so an accepted record is carried over. A
  // doorway without its own record (usable before the merge) is checked again
  // and recorded as restored; one that was not accepted stays a proposal.
  for (const { u, restoredDoors } of unmerged)
    for (const door of restoredDoors) {
      const prior = floor.access.records.findLast((r) => r.doorId === door.id && r.kind === "opening"),
        check = prior?.status === "accepted" ? null : validateOpening(
          { ...view(), geometry: { ...g, doors: g.doors.filter((x) => x.id !== door.id) } },
          { spaceId: door.spaceIds[0], adjacentId: door.spaceIds[1] || null, openingType: prior?.openingType || "door", a: door.a, b: door.b },
        ),
        accepted = !prior ? true : prior.status === "accepted";
      records.push({
        ...(prior ? clone(prior) : { openingType: door.spaceIds.length === 1 ? "exterior-door" : "door",
          evidence: manual(`Doorway restored by an unmerge; it was usable before the merge${check && !check.passed ? " (the local opening check did not pass; review it)" : ""}.`) }),
        id: recordId(`${door.id}:restored`),
        kind: "opening",
        status: accepted ? "accepted" : "proposed",
        spaceId: door.spaceIds[0],
        doorId: door.id,
        adjacentIds: door.spaceIds,
        segment: { a: door.a, b: door.b },
        label: door.label,
        reason: `Doorway restored when ${u.kept.label} was unmerged.`,
        validation: prior?.status === "accepted" && prior.validation ? prior.validation
          : { passed: accepted, failures: check?.failures || [], checkedAt: now, geometryRevision: floor.revision + 1, routeCheck: null },
        merge: null,
      });
    }
  for (const d of decisions.filter((d) => d.op === "merge-spaces")) {
    const chosenIds = Array.isArray(d.spaceIds) ? d.spaceIds.map(resolve) : d.spaceIds,
      // Close rooms that do not touch: only what lies directly between them is taken.
      plan = Array.isArray(chosenIds) && chosenIds.length >= 2 && d.maxGap > MERGE_SNAP && new Set(chosenIds).size === chosenIds.length
        ? planMerge(g, chosenIds, d.maxGap) : { absorb: [], carve: [] },
      wholeIds = Array.isArray(chosenIds) ? [...chosenIds, ...plan.absorb] : chosenIds,
      carvedIds = new Set(plan.carve.map((c) => c.id)),
      touched = new Set([...(Array.isArray(wholeIds) ? wholeIds : []), ...carvedIds]),
      carvedBefore = plan.carve.map((c) => clone(g.spaces.find((s) => s.id === c.id))).filter(Boolean),
      doorsBefore = clone(g.doors.filter((x) => x.spaceIds.some((id) => touched.has(id)))),
      carving = plan.carve.length ? applyCarves(g, plan.carve) : { between: [], parts: [], whole: [], trimmed: [] },
      spaceIds = Array.isArray(wholeIds) ? [...wholeIds, ...carving.whole, ...carving.between] : wholeIds,
      // Boundary-traced walls are regenerated around the merged outline only
      // when the merged regions had them (raster walls are cut instead).
      traced = Array.isArray(spaceIds) && spaceIds.some(tracedWalls),
      several = Array.isArray(spaceIds) && spaceIds.length >= 2,
      goneIds = several ? new Set(wholeIds.slice(1)) : new Set(),
      before = several && {
        kept: clone(g.spaces.find((s) => s.id === spaceIds[0]) ?? null),
        removed: wholeIds.slice(1).map((id) => clone(g.spaces.find((s) => s.id === id) ?? null)),
        doors: g.doors.filter((x) => x.spaceIds.some((id) => goneIds.has(id))).map((x) => ({ id: x.id, spaceIds: [...x.spaceIds] })),
        pois: g.pois.filter((p) => goneIds.has(p.spaceId)).map((p) => ({ id: p.id, spaceId: p.spaceId })),
      },
      // Only the chosen regions can name the result, never ones taken in between.
      m = mergeRegions(g, spaceIds, { label: d.label, use: d.use, maxGap: d.maxGap ?? 0, keepHoles: plan.keepHoles });
    // Doorways trimmed by a cut keep their evidence on the new segment.
    for (const trimmedDoor of carving.trimmed) {
      // The doorway as it is after the merge (it may now open onto the merged region).
      const door = g.doors.find((x) => x.id === trimmedDoor.id);
      if (!door || !door.spaceIds.every((id) => g.spaces.some((sp) => sp.id === id))) continue;
      const prior = floor.access.records.findLast((r) => r.doorId === door.id && r.kind === "opening");
      if (prior) records.push({ ...clone(prior), id: recordId(`${door.id}:trimmed`), spaceId: door.spaceIds.includes(prior.spaceId) ? prior.spaceId : door.spaceIds[0], segment: { a: door.a, b: door.b }, adjacentIds: door.spaceIds,
        reason: `Doorway trimmed where a merge took the part of the region between the rooms.`, merge: null });
    }
    let undo = null;
    if (before?.kept && before.removed.every(Boolean)) {
      const removedId = m.removedIds[0];
      undo = {
        keptId: m.keptId, removedId: wholeIds[1] ?? removedId, kept: before.kept, removed: before.removed[0], removedAll: before.removed,
        // Regions only partly taken: their shape before, and pieces split off them.
        carved: carvedBefore, carvedParts: [...carving.parts, ...m.seamIds], doorsBefore,
        after: clone(g.spaces.find((s) => s.id === m.keptId).polygon),
        internalDoors: clone(m.internal),
        repointedDoors: before.doors.filter((x) => !m.internal.some((i) => i.id === x.id)),
        // Filled in once the transaction's walls are final (see reconcileWalls below).
        removedWalls: [],
        addedWallIds: [],
        pois: before.pois,
        records: floor.access.records.filter((r) => goneIds.has(r.spaceId)).map((r) => ({ id: r.id, spaceId: r.spaceId })),
        adjacent: floor.access.records.filter((r) => r.adjacentIds.some((id) => goneIds.has(id))).map((r) => ({ id: r.id, adjacentIds: [...r.adjacentIds] })),
        undone: false,
      };
      mergeUndos.push(undo);
    }
    for (const id of m.removedIds) {
      remap.set(id, m.keptId);
      affected.add(id);
    }
    if (traced) affected.add(m.keptId);
    [m.keptId, ...m.removedIds].forEach((id) => superseded.add(id));
    if (m.from.label !== m.to.label) relabelled.add(m.keptId);
    const labels = m.inputs.map((s) => s.label).join(", ");
    for (const door of m.internal) {
      droppedDoors.add(door.id);
      records.push({
        id: recordId(`${door.id}:merged`),
        kind: "rejected-door",
        status: "rejected",
        spaceId: m.keptId,
        doorId: door.id,
        openingType: doorRecord(floor, door.id)?.openingType || "door",
        adjacentIds: [m.keptId],
        segment: { a: door.a, b: door.b },
        label: door.label,
        reason: `Doorway removed: the regions it joined (${labels}) were merged into ${m.to.label}.`.slice(0, 3000),
        evidence: manual("Removed by a region merge in the editor."),
      });
    }
    records.push({
      id: recordId(`${m.keptId}:merged`),
      kind: "classification",
      status: "accepted",
      spaceId: m.keptId,
      change: { from: m.from, to: m.to },
      reason: (d.reason || `${labels} merged into one region, ${m.to.label}.`).slice(0, 3000),
      evidence: manual(`Merged regions ${spaceIds.join(", ")} in the editor; ${m.keptId} is kept.`),
      merge: undo,
    });
  }
  for (const d of decisions.filter((d) => d.op === "carve")) {
    if (g.spaces.some((s) => s.id === d.space.id))
      throw new Error(`Region ${d.space.id} already exists`);
    for (const id of carveSpace(g, clone(d.space))) affected.add(id);
    records.push(d.record);
  }
  for (const d of decisions.filter((d) => d.op === "classify")) {
    const s = g.spaces.find((s) => s.id === d.spaceId);
    if (!s) throw new Error(`Unknown region ${d.spaceId}`);
    const from = { kind: s.kind, access: s.access || null, label: s.label };
    if (d.to.kind) s.kind = d.to.kind;
    if (s.kind !== "lobby") delete s.use; // a stair is always a lobby
    if (d.to.label) s.label = d.to.label;
    if (d.to.access === "nonwalkable") s.access = "nonwalkable";
    else if (d.to.access === "unknown") s.access = "unknown";
    affected.add(s.id);
    records.push({
      ...d.record,
      change: {
        from,
        to: { kind: s.kind, access: s.access || null, label: s.label },
      },
    });
  }
  for (const d of decisions.filter((d) => d.op === "rename-space")) {
    const s = region(d.spaceId),
      from = regionState(s),
      label = regionLabel(d.label);
    if (label === s.label) continue;
    s.label = label;
    relabelled.add(s.id);
    records.push({
      id: recordId(`${s.id}:renamed`),
      kind: "classification",
      status: "accepted",
      spaceId: s.id,
      change: { from, to: regionState(s) },
      reason: (d.reason || `Renamed from ${from.label} to ${label}.`).slice(0, 3000),
      evidence: manual("Region name entered in the editor."),
    });
  }
  for (const d of decisions.filter((d) => d.op === "set-space-use")) {
    if (d.use !== "stair" && d.use !== null)
      throw new Error("A region's use is either stair or none.");
    const s = region(d.spaceId),
      from = regionState(s);
    // A stair is walkable and stored as a lobby (the stair-landing convention).
    if (d.use === "stair") {
      s.kind = "lobby";
      s.use = "stair";
      if (s.access === "nonwalkable") s.access = "unknown";
    } else {
      s.kind = "room";
      delete s.use;
    }
    superseded.add(s.id);
    records.push({
      id: recordId(`${s.id}:use`),
      kind: "classification",
      status: "accepted",
      spaceId: s.id,
      change: { from, to: regionState(s) },
      reason: (d.reason || (d.use === "stair" ? `${s.label} marked as a stair.` : `${s.label} is no longer marked as a stair; it is a room.`)).slice(0, 3000),
      evidence: manual("Region use chosen in the editor."),
    });
  }
  for (const d of decisions.filter((d) => d.op === "set-space-kind")) {
    if (!SPACE_KINDS.includes(d.kind))
      throw new Error(`A region's kind is one of ${SPACE_KINDS.join(", ")}.`);
    const s = region(d.spaceId),
      from = regionState(s);
    if (d.kind === "closed") {
      // Doors are kept: doorNodeProblem ignores doorways into non-walkable regions.
      s.use = "closed";
      s.access = "nonwalkable";
    } else {
      if (s.access === "nonwalkable") {
        const access = reopenedAccess(floor, s.id);
        if (access) s.access = access;
        else delete s.access;
      }
      s.kind = ROLES[d.kind].kind;
      if (ROLES[d.kind].use) s.use = ROLES[d.kind].use;
      else delete s.use;
    }
    superseded.add(s.id);
    records.push({
      id: recordId(`${s.id}:kind`),
      kind: "classification",
      status: "accepted",
      spaceId: s.id,
      change: { from, to: regionState(s) },
      reason: (d.reason || (d.kind === "closed"
        ? `${s.label} closed: it cannot be entered and is never routed through; its doorways are kept, unused.`
        : `${s.label} set to ${d.kind}${from.access === "nonwalkable" ? " and re-opened" : ""}${from.use === "stair" && s.use !== "stair" ? "; it is no longer a stair" : ""}.`)).slice(0, 3000),
      evidence: manual("Region kind chosen in the editor."),
    });
  }
  for (const d of decisions.filter((d) => d.op === "reject-door")) {
    const door = g.doors.find((x) => x.id === d.doorId);
    if (!door) throw new Error(`Unknown door ${d.doorId}`);
    g.doors = g.doors.filter((x) => x !== door);
    // `wall`: "wall" draws an explicit wall across the old opening (the map
    // author made it a wall), "none" leaves no doorway and no wall; otherwise
    // the opening is closed as usual.
    if (d.wall === "wall") g.walls.push({ id: `${door.id}:wall`, points: [door.a, door.b] });
    else if (d.wall !== "none") removed.push(door);
    door.spaceIds.forEach((id) => affected.add(id));
    records.push({
      ...d.record,
      doorId: door.id,
      segment: { a: door.a, b: door.b },
      adjacentIds: door.spaceIds,
    });
  }
  for (const d of decisions.filter((d) => d.op === "opening")) {
    const r = d.record,
      result = validateOpening(view(), {
        spaceId: r.spaceId,
        adjacentId: r.adjacentIds[1] || null,
        openingType: r.openingType,
        a: r.segment.a,
        b: r.segment.b,
      });
    if (!result.passed)
      throw new Error(
        `${r.label || r.spaceId}: ${result.failures.map((f) => f.message).join("; ")}`,
      );
    const door = {
      id: r.doorId,
      label: r.label || "Verified opening",
      a: result.segment.a,
      b: result.segment.b,
      spaceIds: r.adjacentIds,
      confidence: r.evidence.confidence ?? 1,
    };
    if (g.doors.some((x) => x.id === door.id))
      throw new Error(`Door ${door.id} already exists`);
    g.doors.push(door);
    added.push(door);
    door.spaceIds.forEach((id) => affected.add(id));
    records.push({
      ...r,
      segment: { a: door.a, b: door.b },
      validation: {
        passed: true,
        checkedAt: now,
        geometryRevision: floor.revision + 1,
        failures: [],
        routeCheck: null,
      },
    });
  }
  records.push(
    ...decisions.filter((d) => d.op === "unresolved").map((d) => d.record),
  );
  // A new name alone must not turn an existing validation error into a "new" one.
  const labelNow = new Map(g.spaces.map((s) => [s.id, s.label])),
    relabel = (s) => labelNow.has(s.id) && labelNow.get(s.id) !== s.label;
  if (floor.geometry.spaces.some(relabel))
    for (const i of geometryIssues({ ...floor, geometry: { ...floor.geometry, spaces: floor.geometry.spaces.map((s) => (relabel(s) ? { ...s, label: labelNow.get(s.id) } : s)) } }))
      if (i.severity === "error") errorsBefore.add(i.message);
  const geometryOps = decisions.some((d) => d.op !== "unresolved");
  if (geometryOps)
    reconcileWalls(g, floorId, [...affected], added, removed);
  // A recorded merge undoes its whole effect on walls, traced walls included.
  if (mergeUndos.length) {
    const beforeKeys = new Set(floor.geometry.walls.map((w) => JSON.stringify(w))),
      finalKeys = new Set(g.walls.map((w) => JSON.stringify(w)));
    for (const undo of mergeUndos) {
      undo.removedWalls = floor.geometry.walls.filter((w) => !finalKeys.has(JSON.stringify(w))).map(clone);
      undo.addedWallIds = g.walls.filter((w) => !beforeKeys.has(JSON.stringify(w))).map((w) => w.id);
    }
  }
  const stamped = records.map((r) =>
    newAccessRecord({
      ...r,
      geometryRevision: geometryOps ? floor.revision + 1 : floor.revision,
      review: { status: reviewStatus, reviewer, at: now, notes },
    }),
  );
  if (!geometryOps) {
    const b = clone(building),
      f = b.floors.find((f) => f.id === floorId);
    f.access.records.push(...stamped);
    return { building: b, records: stamped, flagChanges: [] };
  }
  const next = geometryChanged(
      building,
      floorId,
      g,
      reason || "Source-backed access corrections",
    ),
    f = next.floors.find((f) => f.id === floorId);
  if (remap.size) remapRegionReferences(next, f, remap, droppedDoors);
  for (const { recordId: id, u } of unmerged) {
    for (const r of f.access.records) {
      if (r.id === id) r.merge = { ...r.merge, undone: true };
      const home = (u.records || []).find((x) => x.id === r.id);
      if (home) r.spaceId = home.spaceId;
      else if ((u.recordIds || []).includes(r.id)) r.spaceId = u.removedId;
      const adj = u.adjacent.find((a) => a.id === r.id);
      if (adj) r.adjacentIds = [...adj.adjacentIds];
    }
  }
  // Earlier automated proposals for regions the developer has now decided.
  for (const r of f.access.records)
    if (superseded.has(r.spaceId) && r.kind === "classification" && r.status === "proposed") {
      r.status = "rejected";
      r.review = { status: "rejected", reviewer, at: now, notes: "Superseded by a developer region edit" };
    }
  // A renamed region shows its new name, not an older display-only label.
  for (const id of relabelled) if (f.presentation?.rooms?.[id]) f.presentation.rooms[id].label = null;
  f.access.records.push(...stamped);
  assignSourceOwnership(f, floor.geometry);
  const flagChanges = reconcileAccessFlags(f.geometry, f);
  const newErrors = geometryIssues(f).filter(
    (i) => i.severity === "error" && !errorsBefore.has(i.message),
  );
  if (newErrors.length)
    throw new Error(`Geometry validation failed: ${newErrors[0].message}`);
  f.geometryStatus = "reviewed";
  f.reviewer = reviewer;
  f.reviewNotes = notes || floor.reviewNotes;
  f.geometry.review = {
    status: "reviewed",
    reviewer,
    reviewedAt: now,
    issues: f.geometry.review.issues.map((i) => ({ ...i, resolved: true })),
  };
  for (const s of f.sources)
    if (
      floor.sources.find((x) => x.id === s.id)?.coverage?.stage === "complete" &&
      !coverageSummary(f, s).missing.length
    )
      s.coverage.stage = "complete";
  const built = buildGraph(next, floorId),
    check = routeAccessResults(built, floorId, [
      ...new Set(
        stamped
          .filter((r) => r.kind === "opening")
          .flatMap((r) => r.adjacentIds),
      ),
    ]);
  const builtFloor = built.floors.find((x) => x.id === floorId);
  for (const r of builtFloor.access.records.filter((r) =>
    stamped.some((s) => s.id === r.id && s.kind === "opening"),
  )) {
    const result = check.results.find((x) => x.spaceId === r.spaceId);
    r.validation.routeCheck = {
      passed: !!result?.passed,
      message: result?.message || "",
    };
    r.validation.geometryRevision = builtFloor.revision;
  }
  // An unmerge puts back the floor exactly as it was before the merge, so a
  // route check that fails (as it already did then) is recorded, not refused.
  const restoring = decisions.length && decisions.every((d) => d.op === "unmerge-spaces");
  if (!check.passed && !restoring)
    throw new Error(`Route access check failed: ${check.message}`);
  return { building: built, records: stamped, flagChanges, check };
}

// Generic pipeline import. The same access transaction owns geometry, wall
// gaps, evidence and graph generation. A visual proposal alone cannot enable
// an opening. This is explicitly agent inspection, never human review.
function applySourceProposal(building, floorId, decision, { reviewer, notes }) {
  const floor = building.floors.find(f => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const source = floor.sources.find(s => s.id === decision.sourceId);
  if (!source) throw new Error("Unknown source.");
  const proposal = MapSchema.parse(decision.map);
  const geometry = mergeProposal(floor, source.id, proposal);
  const classifications = decision.classifications || [], classified = [];
  for (const c of classifications) {
    const region = geometry.spaces.find(s => s.id === c.spaceId);
    if (!region || !c.evidence?.crops?.length) throw new Error("Classification needs a mapped region and original-source evidence.");
    const from = { kind: region.kind, access: region.access || null, label: region.label };
    if (c.evidence.verifier?.verdict === "supported") {
      if (c.to.access === "nonwalkable") region.access = "nonwalkable";
      if (["lobby", "corridor"].includes(c.to.kind)) region.kind = c.to.kind;
    }
    classified.push({ ...c, from, region });
  }
  const errors = geometryIssues({ ...floor, geometry }).filter(i => i.severity === "error");
  if (errors.length) throw new Error(`Proposal needs geometry repair: ${errors[0].message}`);
  const next = geometryChanged(building, floorId, geometry, "Hybrid pipeline source proposal"),
    f = next.floors.find(f => f.id === floorId), now = new Date().toISOString(),
    owned = id => id.startsWith(source.id + ":") || source.geometryIds.includes(id),
    s = f.sources.find(s => s.id === source.id);
  s.geometryIds = ["spaces", "walls", "doors", "pois"].flatMap(k => f.geometry[k].filter(x => owned(x.id)).map(x => x.id));
  if (decision.coverage) s.coverage = {
    ...clone(decision.coverage), stage: "needs-review",
    items: decision.coverage.items.map(i => ({ ...i, spaceId: i.spaceId ? sourceFeatureId(source, i.spaceId) : null })),
  };
  const provided = new Map((decision.records || []).map(r => [r.doorId, r]));
  const blockedRegions = new Set(f.geometry.spaces.filter(s => regionNeedsSemanticReview(f, s.id)).map(s => s.id));
  for (const c of classified) {
    if (c.evidence.verifier?.verdict === "supported") blockedRegions.delete(c.spaceId);
    else blockedRegions.add(c.spaceId);
  }
  const stamped = classified.map((c, i) => newAccessRecord({
    id: `${source.id}:classification:${f.revision}:${i}`, kind: "classification",
    status: blockedRegions.has(c.spaceId) ? "proposed" : "accepted", spaceId: c.spaceId,
    reason: c.reason, evidence: c.evidence, geometryRevision: f.revision,
    change: { from: c.from, to: { kind: c.region.kind, access: c.region.access || null, label: c.region.label } },
    review: { status: "agent-inspected", reviewer, at: now, notes: notes || "Original-source region classification" },
  }));
  for (const door of f.geometry.doors.filter(d => owned(d.id))) {
    const input = provided.get(door.id),
      type = input?.openingType || (door.spaceIds.length === 1 ? "exterior-door" : "door"),
      check = validateOpening({ ...f, geometry: { ...f.geometry, doors: f.geometry.doors.filter(d => d.id !== door.id) } }, {
        spaceId: door.spaceIds[0], adjacentId: door.spaceIds[1] || null, openingType: type, a: door.a, b: door.b,
      }),
      supported = input?.evidence?.verifier?.verdict === "supported" && input.evidence.crops.length > 0 && check.passed && !door.spaceIds.some(id => blockedRegions.has(id));
    if (check.passed) { door.a = check.segment.a; door.b = check.segment.b; }
    stamped.push(newAccessRecord({
      id: `${door.id}:pipeline-record:${f.revision}`, kind: "opening",
      status: supported ? "accepted" : "proposed", spaceId: door.spaceIds[0], doorId: door.id,
      openingType: type, adjacentIds: door.spaceIds, segment: { a: door.a, b: door.b }, label: door.label,
      reason: supported ? "Original source supports this opening; local validation passed."
        : "Opening remains disabled until source and geometry checks pass.",
      evidence: input?.evidence || { method: "ai-agent", description: "Unverified extraction candidate", crops: [] },
      validation: { passed: check.passed, failures: check.failures, checkedAt: now, geometryRevision: f.revision, routeCheck: null },
      geometryRevision: f.revision,
      review: { status: "agent-inspected", reviewer, at: now, notes: notes || "Automatic hybrid pipeline" },
    }));
  }
  f.access.records.push(...stamped);
  // Raster-segmented proposals already carry exact shared-boundary walls (one
  // polyline per boundary, open at doorways). Re-tracing every polygon edge
  // from both sides would turn them into thousands of two-point pieces.
  if (proposal.extraction?.provider !== "Local raster segmentation")
    f.geometry.walls = traceBoundaryWalls(f.geometry);
  f.geometryStatus = "reviewed";
  f.reviewer = reviewer;
  f.reviewNotes = "Agent inspected geometry; doorway evidence and unresolved access are recorded separately.";
  f.geometry.review = { ...f.geometry.review, status: "reviewed", reviewer, reviewedAt: now };
  reconcileAccessFlags(f.geometry, f);
  let built = buildGraph(next, floorId);
  const ids = [...new Set(stamped.filter(r => r.kind === "opening" && r.status === "accepted").flatMap(r => r.adjacentIds))];
  const check = routeAccessResults(built, floorId, ids);
  let downgraded = false;
  const bf = built.floors.find(x => x.id === floorId);
  for (const r of bf.access.records.filter(r => r.kind === "opening" && stamped.some(s => s.id === r.id) && r.status === "accepted")) {
    const results = check.results.filter(x => r.adjacentIds.includes(x.spaceId));
    r.validation.routeCheck = { passed: results.every(x => x.passed), message: results.map(x => x.message).join("; ") };
    if (!r.validation.routeCheck.passed) { r.status = "proposed"; r.reason = r.validation.routeCheck.message; downgraded = true; }
  }
  if (downgraded) { reconcileAccessFlags(bf.geometry, bf); built = buildGraph(built, floorId); }
  return { building: built, records: built.floors.find(f => f.id === floorId).access.records.filter(r => stamped.some(s => s.id === r.id)), check, flagChanges: [] };
}
