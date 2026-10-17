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
export function mergeOutlines(polygons, { snap = MERGE_SNAP, others = [] } = {}) {
  const solid = (mp) => mp.filter((p) => area(unring(p[0])) > 0.5);
  const union = (list) => solid(polygonClipping.union(...list.map(ring)));
  let pieces, snapped = false;
  try {
    pieces = union(polygons);
    if (pieces.length > 1) {
      pieces = union(snapOutlines(polygons, snap));
      snapped = true;
    }
  } catch (e) {
    throw new Error(`These outlines could not be combined (${e.message}).`);
  }
  if (pieces.length !== 1) throw new Error("Regions must share a boundary to be merged.");
  const [outer, ...holes] = pieces[0].map(unring);
  // Sliver holes are gaps between outlines; anything thicker is another area.
  for (const h of holes)
    if (area(h) > 4 && (2 * area(h)) / perimeter(h) > snap)
      throw new Error("The merged region would surround an area that is not part of it; include that area too or merge fewer regions.");
  let polygon = outer;
  if (snapped || holes.length) {
    const box = bbox(polygon), near = others.filter((o) => boxesTouch(bbox(o), box));
    if (near.length) {
      const cut = solid(polygonClipping.difference(ring(polygon), ...near.map(ring)));
      if (cut.length !== 1) throw new Error("Regions must share a boundary to be merged.");
      polygon = unring(cut[0][0]);
    }
  }
  polygon = simplifyRing(polygon);
  if (polygon.length < 3 || area(polygon) < 2) throw new Error("The merged outline is degenerate.");
  return polygon;
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
export function mergeRegions(g, spaceIds, { label, use } = {}) {
  if (!Array.isArray(spaceIds) || spaceIds.length < 2) throw new Error("Choose at least two regions to merge.");
  if (new Set(spaceIds).size !== spaceIds.length) throw new Error("Each region can be listed only once.");
  if (use !== undefined && use !== null && use !== "stair") throw new Error("A region's use is either stair or none.");
  const inputs = spaceIds.map((id) => {
    const s = g.spaces.find((s) => s.id === id);
    if (!s) throw new Error(`Unknown region ${id}`);
    return s;
  });
  const ids = new Set(spaceIds), [kept, ...gone] = inputs, goneIds = new Set(gone.map((s) => s.id)),
    outlines = inputs.map((s) => s.polygon), from = regionState(kept),
    polygon = mergeOutlines(outlines, { others: g.spaces.filter((s) => !ids.has(s.id)).map((s) => s.polygon) });
  const name = label === undefined || label === null || (typeof label === "string" && !label.trim())
    ? (inputs.find((s) => !GENERIC_LABEL.test(s.label)) || kept).label
    : regionLabel(label);
  // Omitted `use` keeps a stair only when every merged region is one.
  const stair = use === "stair" || (use === undefined && inputs.every((s) => s.use === "stair")),
    walkable = inputs.filter((s) => s.access !== "nonwalkable");
  kept.polygon = polygon;
  kept.label = name;
  kept.kind = stair ? "lobby"
    : inputs.every((s) => ["corridor", "lobby"].includes(s.kind)) ? (inputs.some((s) => s.kind === "lobby") ? "lobby" : "corridor")
    : "room";
  if (stair) kept.use = "stair";
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
  g.pois = g.pois.map((p) => (goneIds.has(p.spaceId) ? { ...p, spaceId: kept.id } : p));
  const nodes = g.graph.nodes.filter((n) => !internalIds.has(n.doorId)).map((n) => ({ ...n, spaceIds: remap(n.spaceIds) })),
    nodeIds = new Set(nodes.map((n) => n.id));
  g.graph = { nodes, edges: g.graph.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)) };
  return { keptId: kept.id, removedIds: [...goneIds], internal, inputs: inputs.map(regionState), from, to: regionState(kept) };
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
  for (const d of decisions.filter((d) => d.op === "merge-spaces")) {
    const spaceIds = Array.isArray(d.spaceIds) ? d.spaceIds.map(resolve) : d.spaceIds,
      // Boundary-traced walls are regenerated around the merged outline only
      // when the merged regions had them (raster walls are cut instead).
      traced = Array.isArray(spaceIds) && spaceIds.some(tracedWalls),
      m = mergeRegions(g, spaceIds, { label: d.label, use: d.use });
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
    removed.push(door);
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
  if (!check.passed)
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
