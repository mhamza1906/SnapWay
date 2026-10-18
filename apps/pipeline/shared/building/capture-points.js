// Photo capture planning on the corridor centreline graph (docs/photo-capture.md,
// "Pipeline map API"). Pure functions: nothing here changes a building.
//
// A corridor is a chain of `traversal: "corridor"` edges joined through plain
// vertices with exactly two corridor edges. Chains end at junctions (three or
// more corridor edges), door vertices, connector landings and dead ends; they
// run through analytical joins between segmented corridor pieces.
// Capture points always lie on the stored edge polylines (the centreline), so
// they stay in walkable space. Metres are reported only for a verified scale.
import { createHash } from "node:crypto";
import { centre, distance, inside, pointSegment } from "../map.js";
import { doorRecord } from "./access-state.js";

export const TURN_DEG = 30;
const CIRCULATION = new Set(["corridor", "lobby"]);
const PRIORITY = { spacing: 0, turn: 1, door: 2, junction: 3, start: 4, end: 4 };
const r2 = (v) => Math.round(v * 100) / 100;
const angleOf = (a, b) => ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 360;
const normAngle = (a) => { const v = Math.round((((a % 360) + 360) % 360) * 10) / 10; return v >= 360 ? 0 : v; };
const polyLength = (pts) => pts.reduce((s, p, i) => (i ? s + distance(pts[i - 1], p) : 0), 0);

export class CaptureError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const floorOf = (building, floorId) => {
  const f = building.floors.find((f) => f.id === floorId);
  if (!f) throw new CaptureError("Unknown floor.", 404);
  return f;
};
export const scaleOf = (floor) => {
  const ppm = floor.geometry.scale?.pixelsPerMetre;
  return Number.isFinite(ppm) && ppm > 0 ? ppm : null;
};

function corridorEdges(building, floorId) {
  return building.edges
    .filter((e) => e.floorId === floorId && e.traversal === "corridor" && e.path.length >= 2)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Corridor chains of one floor, each with a stable ID (hash of its sorted edge
// IDs), a label from the space it mostly runs through, and a forward
// orientation (+x for mostly horizontal chains, +y for vertical ones).
export function corridorChains(building, floorId) {
  const floor = floorOf(building, floorId),
    edges = corridorEdges(building, floorId),
    nodes = new Map(building.nodes.map((n) => [n.id, n])),
    incident = new Map();
  for (const e of edges)
    for (const id of new Set([e.from, e.to])) (incident.get(id) || incident.set(id, []).get(id)).push(e);
  const degree = (id) => (incident.get(id) || []).reduce((n, e) => n + (e.from === e.to ? 2 : 1), 0);
  // Analytical joins between segmented corridor pieces are not real doors:
  // a chain runs through them.
  const joinDoor = (doorId) => doorId.includes("coverage-open-") || doorRecord(floor, doorId)?.openingType === "decomposition-join";
  const passes = (id) => {
    const n = nodes.get(id);
    return degree(id) === 2 && !!n && (!n.doorId || joinDoor(n.doorId)) && !n.connectorId && !["stair", "elevator"].includes(n.type);
  };
  const used = new Set(), raw = [];
  const walk = (startNode, first) => {
    const steps = [];
    let at = startNode, e = first;
    while (e && !used.has(e.id)) {
      used.add(e.id);
      const reversed = e.from !== at, next = reversed ? e.from : e.to;
      steps.push({ edge: e, reversed });
      at = next;
      if (!passes(at)) break;
      e = incident.get(at).find((x) => !used.has(x.id));
    }
    return steps;
  };
  const ends = [...incident.keys()].filter((id) => !passes(id)).sort();
  for (const id of ends) for (const e of incident.get(id)) if (!used.has(e.id)) raw.push(walk(id, e));
  // Closed loops of plain vertices: start at the smallest edge ID.
  for (const e of edges) if (!used.has(e.id)) raw.push(walk(e.from, e));

  const labelled = raw.filter((s) => s.length).map((steps) => Object.assign(buildChain(floor, nodes, steps, degree), { _realDoor: (n) => !!n?.doorId && !joinDoor(n.doorId) }));
  // Chains through the same space get "part n" in reading order.
  const groups = new Map();
  for (const c of labelled) (groups.get(c.label) || groups.set(c.label, []).get(c.label)).push(c);
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.path[0].y - b.path[0].y || a.path[0].x - b.path[0].x || a.id.localeCompare(b.id));
    list.forEach((c, i) => (c.label = `${c.label}, part ${i + 1}`));
  }
  return labelled.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || b.lengthPx - a.lengthPx);
}

function buildChain(floor, nodes, steps, degree) {
  const start = (s) => (s.reversed ? s.edge.to : s.edge.from), stop = (s) => (s.reversed ? s.edge.from : s.edge.to);
  let p0 = nodes.get(start(steps[0]))?.position || steps[0].edge.path[0],
    p1 = nodes.get(stop(steps.at(-1)))?.position || steps.at(-1).edge.path.at(-1);
  const dx = p1.x - p0.x, dy = p1.y - p0.y, flip = Math.abs(dx) >= Math.abs(dy) ? dx < -1e-6 : dy < -1e-6;
  if (flip && start(steps[0]) !== stop(steps.at(-1))) steps = [...steps].reverse().map((s) => ({ edge: s.edge, reversed: !s.reversed }));
  const ppm = scaleOf(floor), path = [], segments = [], nodeIds = [start(steps[0])];
  let at = 0;
  for (const s of steps) {
    const pts = s.reversed ? [...s.edge.path].reverse() : s.edge.path, len = polyLength(pts);
    for (const p of pts) if (!path.length || distance(path.at(-1), p) > 1e-6) path.push({ x: p.x, y: p.y });
    segments.push({ edgeId: s.edge.id, reversed: s.reversed, startPx: r2(at), endPx: r2(at + len), _start: at, _len: len, _edge: s.edge });
    at += len;
    nodeIds.push(stop(s));
  }
  const id = "corridor-" + createHash("sha256").update(steps.map((s) => s.edge.id).sort().join("\n")).digest("hex").slice(0, 12);
  return { id, label: chainLabel(floor, path, nodeIds.map((n) => nodes.get(n))), lengthPx: r2(at), lengthM: ppm ? r2(at / ppm) : null,
    path: path.map((p) => ({ x: r2(p.x), y: r2(p.y) })), segments, nodeIds, _path: path, _length: at, _degree: degree };
}

// The walkable space the chain runs through for the longest stretch.
function chainLabel(floor, path, chainNodes) {
  const spaces = floor.geometry.spaces.filter((s) => s.access !== "nonwalkable"),
    weight = new Map();
  for (let i = 1; i < path.length; i++) {
    const m = { x: (path[i - 1].x + path[i].x) / 2, y: (path[i - 1].y + path[i].y) / 2 },
      hits = spaces.filter((s) => inside(m, s.polygon)),
      s = hits.find((s) => CIRCULATION.has(s.kind)) || hits[0];
    if (s) weight.set(s, (weight.get(s) || 0) + distance(path[i - 1], path[i]));
  }
  const best = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0]
    || spaces.find((s) => chainNodes.some((n) => n?.spaceIds?.includes(s.id)));
  return best?.label || "Corridor";
}

// Public view of a chain (no internal fields).
export function chainView(c) {
  return { id: c.id, label: c.label, lengthPx: c.lengthPx, lengthM: c.lengthM, path: c.path,
    segments: c.segments.map(({ edgeId, reversed, startPx, endPx }) => ({ edgeId, reversed, startPx, endPx })), nodeIds: c.nodeIds };
}

const roomSpace = (s) => s && !CIRCULATION.has(s.kind) && s.use !== "hall" && s.access !== "nonwalkable";

// Floor-level nodes (chain ends, junctions, doors) and landmarks (rooms, doors).
export function floorFeatures(building, floorId, chains = corridorChains(building, floorId)) {
  const floor = floorOf(building, floorId), byId = new Map(building.nodes.map((n) => [n.id, n])),
    spaces = new Map(floor.geometry.spaces.map((s) => [s.id, s])), out = new Map(), degree = chains[0]?._degree;
  const label = (n, kind) => {
    if (kind === "door") { const d = floor.geometry.doors.find((d) => d.id === n.doorId); return d ? doorLabel(d, spaces) : n.label; }
    const s = spaces.get(n.spaceIds[0]);
    return n.connectorId || !s ? n.label : `${s.label} ${kind}`;
  };
  const add = (n, kind) => n && !out.has(n.id) && out.set(n.id, { id: n.id, kind, label: label(n, kind), x: r2(n.position.x), y: r2(n.position.y) });
  for (const c of chains) {
    for (const id of [c.nodeIds[0], c.nodeIds.at(-1)]) {
      const n = byId.get(id);
      add(n, c._realDoor(n) ? "door" : degree(id) >= 3 ? "junction" : "end");
    }
    for (const d of attachedDoors(building, floor, c)) add(byId.get(d.doorNodeId), "door");
  }
  const landmarks = [
    ...floor.geometry.spaces.filter(roomSpace).map((s) => { const p = centre(s.polygon); return { kind: "room", id: s.id, label: s.label, x: r2(p.x), y: r2(p.y) }; }),
    ...floor.geometry.doors.map((d) => ({ kind: "door", id: d.id, label: doorLabel(d, spaces), x: r2((d.a.x + d.b.x) / 2), y: r2((d.a.y + d.b.y) / 2) })),
  ];
  return { nodes: [...out.values()], landmarks };
}

function doorLabel(d, spaces) {
  const room = d.spaceIds.map((id) => spaces.get(id)).find(roomSpace);
  return room ? `Door to ${room.label}` : d.label;
}

// Doors of rooms whose doorway edge joins a vertex of this chain.
function attachedDoors(building, floor, chain) {
  const onChain = new Set(chain.nodeIds), byId = new Map(building.nodes.map((n) => [n.id, n])),
    spaces = new Map(floor.geometry.spaces.map((s) => [s.id, s])), found = [];
  for (const e of building.edges) {
    if (e.floorId !== floor.id || e.traversal !== "doorway") continue;
    for (const [here, there] of [[e.from, e.to], [e.to, e.from]]) {
      const door = byId.get(there);
      if (!onChain.has(here) || onChain.has(there) || !door?.doorId) continue;
      const d = floor.geometry.doors.find((x) => x.id === door.doorId);
      if (d && d.spaceIds.some((id) => roomSpace(spaces.get(id)))) found.push({ vertexId: here, doorNodeId: there, door: d });
    }
  }
  return found;
}

// Walking view of a chain: pieces in walking order with their stored edges.
function walking(chain, direction) {
  if (!["forward", "reverse"].includes(direction)) throw new CaptureError('direction must be "forward" or "reverse".');
  const L = chain._length, rev = direction === "reverse",
    pieces = (rev ? [...chain.segments].reverse() : chain.segments).map((s) => ({
      edge: s._edge, reversed: rev ? !s.reversed : s.reversed, start: rev ? L - s._start - s._len : s._start, len: s._len,
    }));
  const nodes = rev ? [...chain.nodeIds].reverse() : chain.nodeIds;
  const path = rev ? [...chain._path].reverse() : chain._path;
  return { L, pieces, nodes, path, rev };
}

// Position at walking distance s: point, piece, stored-edge fraction and the
// direction of the outgoing segment (incoming at the end).
function locate(w, s) {
  s = Math.max(0, Math.min(w.L, s));
  const atEnd = s >= w.L - 1e-9;
  let k = w.pieces.findIndex((p) => s < p.start + p.len - 1e-9);
  if (k < 0 || atEnd) k = w.pieces.length - 1;
  // Zero-length pieces carry no direction; move to a real one.
  while (w.pieces[k].len < 1e-9 && k + 1 < w.pieces.length && !atEnd) k++;
  const piece = w.pieces[k], stored = piece.edge.path, total = polyLength(stored),
    local = Math.max(0, Math.min(piece.len, s - piece.start)),
    fromStart = piece.reversed ? piece.len - local : local;
  // Walk the stored polyline (from -> to) to the point.
  let acc = 0, point = stored[0], seg = 0;
  for (let i = 1; i < stored.length; i++) {
    const d = distance(stored[i - 1], stored[i]);
    if (fromStart <= acc + d + 1e-9 || i === stored.length - 1) {
      const t = d > 1e-12 ? Math.max(0, Math.min(1, (fromStart - acc) / d)) : 0;
      point = { x: stored[i - 1].x + (stored[i].x - stored[i - 1].x) * t, y: stored[i - 1].y + (stored[i].y - stored[i - 1].y) * t };
      seg = i;
      break;
    }
    acc += d;
  }
  return { point, piece, fraction: total > 1e-12 ? fromStart / total : 0, angle: segmentAngle(w, s, atEnd, w.minSeg) };
}

// Map-frame angle of the outgoing walking segment at s (incoming at the end).
// Segments shorter than `minSeg` (corner chamfers and other raster artefacts
// of a segmented clean redraw) are skipped; if every remaining segment is
// short, the longest one is used.
function segmentAngle(w, s, atEnd, minSeg) {
  const pts = w.path, segs = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = distance(pts[i - 1], pts[i]);
    segs.push({ a: pts[i - 1], b: pts[i], start: acc, len });
    acc += len;
  }
  const pick = (list) => list.find((g) => g.len >= minSeg) || list.filter((g) => g.len > 1e-6).sort((x, y) => y.len - x.len)[0];
  const ahead = atEnd ? [] : segs.filter((g) => g.start + g.len > s + 1e-9),
    g = pick(ahead) || pick([...segs].reverse());
  return g ? angleOf(g.a, g.b) : 0;
}

function pointAt(w, s, { ppm, floor, building, nearbyPx }) {
  const at = locate(w, s);
  return {
    x: r2(at.point.x), y: r2(at.point.y), edgeId: at.piece.edge.id, referenceEdgeId: at.piece.edge.id,
    fraction: Math.round(at.fraction * 1e6) / 1e6, corridorDistancePx: r2(s), distanceM: ppm ? r2(s / ppm) : null,
    forwardAngleDeg: normAngle(at.angle), nearby: nearby(floor, at.point, nearbyPx),
  };
}

function nearby(floor, p, radius) {
  const spaces = new Map(floor.geometry.spaces.map((s) => [s.id, s])), out = [];
  for (const d of floor.geometry.doors) {
    const m = { x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 }, dist = distance(p, m);
    if (dist <= radius) out.push({ kind: "door", id: d.id, label: doorLabel(d, spaces), distancePx: r2(dist) });
  }
  for (const s of floor.geometry.spaces.filter(roomSpace)) {
    const dist = inside(p, s.polygon) ? 0 : Math.min(...s.polygon.map((a, i) => pointSegment(p, a, s.polygon[(i + 1) % s.polygon.length])));
    if (dist <= radius) out.push({ kind: "room", id: s.id, label: s.label, distancePx: r2(dist) });
  }
  return out.sort((a, b) => a.distancePx - b.distancePx).slice(0, 6);
}

function context(building, floorId, corridorId, options = {}) {
  const { direction = "forward", spacingM = 2 } = options;
  const floor = floorOf(building, floorId), chains = options.chains || corridorChains(building, floorId),
    chain = chains.find((c) => c.id === corridorId);
  if (!chain) throw new CaptureError("Unknown corridor on this floor.", 400);
  if (spacingM !== null && spacingM !== undefined && !(Number.isFinite(spacingM) && spacingM >= 0.5 && spacingM <= 50))
    throw new CaptureError("spacingM must be between 0.5 and 50.");
  const ppm = scaleOf(floor), diag = Math.hypot(floor.width, floor.height),
    spacingPx = ppm ? (spacingM ?? 2) * ppm : null,
    nearbyPx = ppm ? 3 * ppm : Math.max(20, diag * 0.025),
    mergePx = spacingPx ? spacingPx / 2 : Math.max(8, diag * 0.01),
    w = walking(chain, direction);
  w.minSeg = ppm ? Math.max(8, 0.5 * ppm) : Math.max(8, diag * 0.01);
  return { floor, chain, ppm, spacingPx, nearbyPx, mergePx, w, direction };
}

/**
 * Capture points for one corridor in walking order. Auto mode (verified
 * scale): spacing every `spacingM` along the whole polyline plus turns,
 * junctions and room doors, merged when closer than half the spacing (the
 * more important reason wins). Manual mode: start, end, junction and turn
 * suggestions only, metre fields null. Positions are computed on the forward
 * chain, so both walking directions share the same points.
 */
export function planCapturePoints(building, floorId, corridorId, options = {}) {
  const ctx = context(building, floorId, corridorId, options), { floor, chain, ppm, spacingPx, mergePx, w } = ctx,
    L = chain._length, fw = walking(chain, "forward"), auto = !!ppm,
    degree = chain._degree, byId = new Map(building.nodes.map((n) => [n.id, n]));
  // Candidates in forward distance.
  const cands = [], nodeAt = new Map();
  { let at = 0; nodeAt.set(chain.nodeIds[0], 0); chain.segments.forEach((s, i) => { at += s._len; nodeAt.set(chain.nodeIds[i + 1], at); }); }
  // Manual mode suggests only start, end, junction and turn points.
  const endReason = (id, fallback) => (degree(id) >= 3 ? "junction" : auto && chain._realDoor(byId.get(id)) ? "door" : fallback);
  const startId = chain.nodeIds[0], endId = chain.nodeIds.at(-1);
  cands.push({ s: 0, reason: endReason(startId, "start"), nodeId: startId, end: true });
  if (L > 1e-6) cands.push({ s: L, reason: endReason(endId, "end"), nodeId: endId, end: true });
  if (auto) {
    for (let k = 1; k * spacingPx < L - 1e-6; k++) cands.push({ s: k * spacingPx, reason: "spacing", nodeId: null });
    for (const d of attachedDoors(building, floor, chain)) {
      const s = nodeAt.get(d.vertexId);
      if (s !== undefined && s > 1e-6 && s < L - 1e-6) cands.push({ s, reason: "door", nodeId: d.vertexId });
    }
  }
  for (const t of turns(fw.path, auto ? Math.min(spacingPx / 4, ppm * 0.75) : mergePx / 2))
    if (t > 1e-6 && t < L - 1e-6) cands.push({ s: t, reason: "turn", nodeId: [...nodeAt].find(([, v]) => Math.abs(v - t) < 1e-6)?.[0] ?? null });
  // Merge (no duplicates at shared vertices; within mergePx keep the more important).
  cands.sort((a, b) => a.s - b.s || PRIORITY[b.reason] - PRIORITY[a.reason]);
  const kept = [];
  for (const c of cands) {
    kept.push(c);
    // Re-check after each replacement so no two kept points end up closer than mergePx.
    while (kept.length >= 2) {
      const a = kept.at(-2), b = kept.at(-1);
      if (b.s - a.s >= mergePx || (a.end && b.end && b.s - a.s > 1e-6)) break;
      const win = a.end && !b.end ? a : b.end && !a.end ? b : PRIORITY[b.reason] > PRIORITY[a.reason] ? b : a;
      kept.splice(-2, 2, win);
    }
  }
  // Short chains: two ends closer than mergePx stay two points (both are
  // real places) unless they coincide.
  const ordered = w.rev ? [...kept].reverse() : kept, dirTag = w.rev ? "r" : "f";
  const points = ordered.map((c, i) => {
    const s = w.rev ? L - c.s : c.s;
    let reason = c.reason;
    if (w.rev && reason === "start") reason = "end"; else if (w.rev && reason === "end") reason = "start";
    return { planId: `${chain.id}:${dirTag}:${Math.round(c.s * 10)}`, order: i + 1, ...pointAt(w, s, ctx), nodeId: c.nodeId ?? null, reason };
  });
  return { revision: floor.revision, scaleVerified: auto, mode: auto ? "auto" : "manual",
    spacingM: auto ? (options.spacingM ?? 2) : null,
    path: w.path.map((p) => ({ x: r2(p.x), y: r2(p.y) })), points: points.map(orderKeys) };
}

const orderKeys = (p) => ({ planId: p.planId, order: p.order, x: p.x, y: p.y, edgeId: p.edgeId, nodeId: p.nodeId, referenceEdgeId: p.referenceEdgeId,
  fraction: p.fraction, corridorDistancePx: p.corridorDistancePx, distanceM: p.distanceM, forwardAngleDeg: p.forwardAngleDeg, reason: p.reason, nearby: p.nearby });

// Forward distances of bends sharper than TURN_DEG, measured over a window
// of `win` px on each side so a jagged centreline does not create turns;
// one turn per bend (the sharpest vertex within the window).
export function turns(path, win) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distance(path[i - 1], path[i]));
  const L = cum.at(-1), at = (s) => {
    s = Math.max(0, Math.min(L, s));
    const i = Math.max(1, cum.findIndex((c) => c >= s - 1e-9));
    const d = cum[i] - cum[i - 1], t = d > 1e-12 ? (s - cum[i - 1]) / d : 0;
    return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t };
  };
  const found = [];
  for (let i = 1; i < path.length - 1; i++) {
    const s = cum[i], a = at(s - win), b = path[i], c = at(s + win);
    if (distance(a, b) < 1e-6 || distance(b, c) < 1e-6) continue;
    let bend = Math.abs(angleOf(b, c) - angleOf(a, b));
    if (bend > 180) bend = 360 - bend;
    if (bend > TURN_DEG) found.push({ s, bend });
  }
  const out = [];
  for (const t of found) {
    const last = out.at(-1);
    if (last && t.s - last.s < win) { if (t.bend > last.bend) out[out.length - 1] = t; }
    else out.push(t);
  }
  return out.map((t) => t.s);
}

/**
 * One point on the corridor centreline for an adjusted position: the nearest
 * centreline point to {x, y}, or the point at walking distance
 * `corridorDistancePx` (clamped to the corridor).
 */
export function snapToCorridor(building, floorId, corridorId, { direction = "forward", x, y, corridorDistancePx, chains } = {}) {
  const ctx = context(building, floorId, corridorId, { direction, spacingM: null, chains }), { w } = ctx;
  let s;
  if (Number.isFinite(corridorDistancePx)) s = Math.max(0, Math.min(w.L, corridorDistancePx));
  else if (Number.isFinite(x) && Number.isFinite(y)) {
    let best = Infinity, acc = 0;
    const p = { x, y };
    for (let i = 1; i < w.path.length; i++) {
      const a = w.path[i - 1], b = w.path[i], d = distance(a, b),
        t = d > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (d * d))) : 0,
        q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dist = distance(p, q);
      if (dist < best - 1e-9) { best = dist; s = acc + t * d; }
      acc += d;
    }
  } else throw new CaptureError("Give x and y, or corridorDistancePx.");
  const nodeAt = (() => { let at = 0; const m = [[w.nodes[0], 0]]; w.pieces.forEach((p, i) => { at += p.len; m.push([w.nodes[i + 1], at]); }); return m; })(),
    nodeId = nodeAt.find(([, v]) => Math.abs(v - s) < 0.5)?.[0] ?? null;
  return orderKeys({ planId: null, order: null, ...pointAt(w, s, ctx), nodeId, reason: "adjusted" });
}

// Photo points for a whole hall at once, instead of one corridor at a time.
// The hall's centreline is every corridor edge running mostly inside the hall
// (its merge seams included). Dead-end spurs shorter than one spacing (door
// stubs, raster whiskers) are dropped. Points go at junctions and dead ends
// first, then every `spacing` along each line; a point closer than 0.6 spacing
// to one already placed is skipped, which also folds parallel duplicate
// centrelines into one row of points. They are numbered in walking order: a
// depth-first walk from the dead end nearest the top-left corner.
// Spacing is `spacingM` metres on a verified scale; otherwise `spacingPx` map
// pixels (default 2.2% of the floor's larger side) and metres are null.
export function planHallPoints(building, floorId, spaceId, { spacingM = 2, spacingPx } = {}) {
  const floor = floorOf(building, floorId),
    pieces = floor.geometry.spaces.filter((s) => s.id === spaceId || s.id.startsWith(`${spaceId}:seam-`)),
    hall = pieces.find((s) => s.id === spaceId);
  if (!hall) throw new CaptureError("Unknown region.", 404);
  if (!Number.isFinite(spacingM) || spacingM < 0.5 || spacingM > 50) throw new CaptureError("spacingM must be between 0.5 and 50.");
  const ppm = scaleOf(floor), all = floor.geometry.spaces.flatMap((s) => s.polygon),
    side = Math.max(Math.max(...all.map((p) => p.x)) - Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.y)) - Math.min(...all.map((p) => p.y))),
    step = ppm ? spacingM * ppm : Number.isFinite(spacingPx) && spacingPx > 0 ? spacingPx : Math.round(0.022 * side),
    within = (p) => pieces.some((s) => inside(p, s.polygon)),
    nodes = new Map(building.nodes.map((n) => [n.id, n]));
  // Edges mostly inside the hall.
  let edges = corridorEdges(building, floorId).filter((e) => {
    const len = polyLength(e.path);
    let inLen = 0;
    for (let i = 1; i < e.path.length; i++) {
      const a = e.path[i - 1], b = e.path[i];
      if (within({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })) inLen += distance(a, b);
    }
    return len > 1e-6 && inLen >= 0.5 * len;
  });
  const incidentOf = (list) => { const m = new Map(); for (const e of list) for (const id of [e.from, e.to]) (m.get(id) || m.set(id, []).get(id)).push(e); return m; };
  for (let pass = 0; pass < 2; pass++) {
    const inc = incidentOf(edges);
    edges = edges.filter((e) => !(polyLength(e.path) < step && (inc.get(e.from).length === 1) !== (inc.get(e.to).length === 1)));
  }
  const inc = incidentOf(edges), posOf = (id, e) => nodes.get(id)?.position || (e.from === id ? e.path[0] : e.path.at(-1));
  // Walking order: depth-first over edges from the dead end nearest the top-left.
  const ends = [...inc.keys()].filter((id) => inc.get(id).length === 1),
    starts = (ends.length ? ends : [...inc.keys()]).map((id) => ({ id, p: posOf(id, inc.get(id)[0]) })).sort((a, z) => a.p.x + a.p.y - (z.p.x + z.p.y));
  const usedE = new Set(), visits = [];
  const dfs = (at) => {
    visits.push({ node: at });
    for (const e of inc.get(at) || []) {
      if (usedE.has(e.id)) continue;
      usedE.add(e.id);
      const forward = e.from === at;
      visits.push({ edge: e, forward });
      dfs(forward ? e.to : e.from);
    }
  };
  for (const s of starts) if ((inc.get(s.id) || []).some((e) => !usedE.has(e.id))) dfs(s.id);
  for (const e of edges) if (!usedE.has(e.id)) dfs(e.from);
  // Candidates: junctions and dead ends first, then spaced points along edges.
  const points = [], min = 0.6 * step,
    add = (p, reason, extra) => { if (points.every((q) => distance(q, p) >= min)) points.push({ x: r2(p.x), y: r2(p.y), reason, ...extra }); };
  const keyNodes = [...inc.keys()].filter((id) => inc.get(id).length !== 2);
  for (const id of keyNodes) add(posOf(id, inc.get(id)[0]), inc.get(id).length >= 3 ? "junction" : "end", { nodeId: id, _visit: Infinity });
  visits.forEach((v, i) => {
    if (v.node) { const kp = points.find((q) => q.nodeId === v.node); if (kp && kp._visit === Infinity) kp._visit = i; return; }
    const pts = v.forward ? v.edge.path : [...v.edge.path].reverse(), total = polyLength(pts);
    for (let k = 1; k * step < total - min / 2; k++) {
      let want = k * step, at = 0;
      for (let j = 1; j < pts.length; j++) {
        const d = distance(pts[j - 1], pts[j]);
        if (at + d >= want) {
          const t = (want - at) / (d || 1);
          add({ x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * t, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * t }, "spacing", { edgeId: v.edge.id, _visit: i + k / 1000 });
          break;
        }
        at += d;
      }
    }
  });
  points.sort((a, z) => a._visit - z._visit);
  return {
    spaceId, label: hall.label, scaleVerified: !!ppm, spacingM: ppm ? spacingM : null, spacingPx: r2(step),
    lines: edges.map((e) => e.path.map((p) => ({ x: r2(p.x), y: r2(p.y) }))),
    points: points.map(({ _visit, ...q }, i) => ({ order: i + 1, ...q, nodeId: q.nodeId ?? null, edgeId: q.edgeId ?? null })),
  };
}
