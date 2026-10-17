// Turns corridor-centreline networks into building graph nodes and edges.
// Navigation vertices sit at corridor junctions, spine ends, doorways and
// connector landings; bends stay inside polyline edges. Wall and room polygon
// vertices are never used as navigation vertices.
import { inside, distance, midpoint, pointSegment, intersection } from "../map.js";
import { doorNodeProblem, doorRecord, regionNeedsSemanticReview } from "./access-state.js";
import { centrelineNetwork, nearestOnNetwork, ridgeFrom } from "./centreline.js";

export const WHEELCHAIR_WIDTH_M = 0.9;
const CIRCULATION = new Set(["corridor", "lobby"]);

const usable = (f, d) => !doorNodeProblem(f, d.id);
const area = (p) => Math.abs(p.reduce((n, a, i) => { const z = p[(i + 1) % p.length]; return n + a.x * z.y - z.x * a.y; }, 0) / 2);
const walkable = (f, s) => s.access !== "nonwalkable" && !regionNeedsSemanticReview(f, s.id);

// Corridors, lobbies, rooms the developer marked as halls (use "hall") and
// large halls (three or more usable doors) form circulation areas; pieces
// joined through usable openings are one area.
export function circulationClusters(f) {
  const doorsOf = (s) => f.geometry.doors.filter((d) => d.spaceIds.includes(s.id) && usable(f, d));
  // A large hall: three or more usable doors and at least 3x the median room area.
  const rooms = f.geometry.spaces.filter((s) => !CIRCULATION.has(s.kind) && walkable(f, s)).map((s) => area(s.polygon)).sort((a, b) => a - b),
    median = rooms.length ? rooms[Math.floor(rooms.length / 2)] : Infinity,
    hall = (s) => doorsOf(s).length >= 3 && area(s.polygon) >= 3 * median;
  const circ = f.geometry.spaces.filter((s) => walkable(f, s) && (CIRCULATION.has(s.kind) || s.use === "hall" || hall(s))),
    ids = new Set(circ.map((s) => s.id)),
    parent = new Map(circ.map((s) => [s.id, s.id])),
    root = (x) => (parent.get(x) === x ? x : (parent.set(x, root(parent.get(x))), parent.get(x)));
  for (const d of f.geometry.doors)
    if (d.spaceIds.length === 2 && d.spaceIds.every((id) => ids.has(id)) && usable(f, d)) parent.set(root(d.spaceIds[0]), root(d.spaceIds[1]));
  const groups = new Map();
  for (const s of circ) (groups.get(root(s.id)) || groups.set(root(s.id), []).get(root(s.id))).push(s);
  return [...groups.values()];
}

const segments = (pts, closed = false) =>
  pts.slice(closed ? 0 : 1).map((p, i) => (closed ? { a: p, b: pts[(i + 1) % pts.length] } : { a: pts[i], b: p }));

// Clearance helper for paths outside a raster (room door links): distance to
// the nearest wall or fixed obstacle.
export function wallClearance(f, p) {
  let best = Infinity;
  for (const w of f.geometry.walls) for (const s of segments(w.points)) best = Math.min(best, pointSegment(p, s.a, s.b));
  for (const s of f.geometry.spaces.filter((s) => s.access === "nonwalkable"))
    for (const e of segments(s.polygon, true)) best = Math.min(best, pointSegment(p, e.a, e.b));
  return best;
}

// Distance from a point to the nearest of `segs`, equal to the brute-force
// minimum. Segments are binned in a uniform grid and rings of cells around the
// point are searched until no unseen segment can be closer than the best found.
export function nearestSegmentDistance(segs) {
  const brute = (p) => {
    let d = Infinity;
    for (const s of segs) { const q = pointSegment(p, s.a, s.b); if (q < d) d = q; }
    return d;
  };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { a, b } of segs) {
    x0 = Math.min(x0, a.x, b.x); x1 = Math.max(x1, a.x, b.x);
    y0 = Math.min(y0, a.y, b.y); y1 = Math.max(y1, a.y, b.y);
  }
  if (segs.length < 32 || ![x0, y0, x1, y1].every(Number.isFinite)) return brute;
  const size = Math.max(4, Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / segs.length)),
    cols = Math.floor((x1 - x0) / size) + 1, rows = Math.floor((y1 - y0) / size) + 1,
    cells = Array.from({ length: cols * rows }, () => []),
    col = (x) => Math.floor((x - x0) / size), row = (y) => Math.floor((y - y0) / size);
  segs.forEach(({ a, b }, i) => {
    for (let r = row(Math.min(a.y, b.y)); r <= row(Math.max(a.y, b.y)); r++)
      for (let c = col(Math.min(a.x, b.x)); c <= col(Math.max(a.x, b.x)); c++) cells[r * cols + c].push(i);
  });
  const seen = new Uint32Array(segs.length);
  let stamp = 0;
  return (p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return brute(p);
    stamp++;
    const cx = col(p.x), cy = row(p.y),
      last = Math.max(Math.abs(cx), Math.abs(cx - cols + 1), Math.abs(cy), Math.abs(cy - rows + 1));
    let d = Infinity;
    const scan = (c, r) => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return;
      for (const i of cells[r * cols + c]) {
        if (seen[i] === stamp) continue;
        seen[i] = stamp;
        const q = pointSegment(p, segs[i].a, segs[i].b);
        if (q < d) d = q;
      }
    };
    for (let k = 0; k <= last; k++) {
      for (let r = cy - k; r <= cy + k; r++)
        if (r === cy - k || r === cy + k) for (let c = cx - k; c <= cx + k; c++) scan(c, r);
        else { scan(cx - k, r); if (k) scan(cx + k, r); }
      // Unseen segments lie outside these rings, at least k cells away.
      if (d <= k * size - 1e-6) break;
    }
    return d;
  };
}

// Minimum clear width along a whole path, turns included (sampled every ~1 px).
export function pathClearance(f, path, clearanceAt) {
  let width = Infinity, at = null;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], n = Math.max(1, Math.ceil(distance(a, b)));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }, w = 2 * clearanceAt(p);
      if (w < width) { width = w; at = p; }
    }
  }
  const ppm = f.geometry.scale?.pixelsPerMetre || null,
    widthM = ppm && Number.isFinite(width) ? width / ppm : null,
    issue = !Number.isFinite(width) ? null
      : width < 4 ? "Route runs against a wall or obstacle"
      : widthM !== null && widthM < WHEELCHAIR_WIDTH_M ? `Clear width ${widthM.toFixed(2)} m is below ${WHEELCHAIR_WIDTH_M} m (wheelchair)`
      : null;
  return { widthPx: Number.isFinite(width) ? Math.round(width * 10) / 10 : null, widthM: widthM === null ? null : Math.round(widthM * 100) / 100,
    at: issue ? { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 } : null, issue };
}

/**
 * Builds the centreline graph for every circulation area on floor `f` and
 * appends nodes/edges to building `b`. Returns the space IDs it handled.
 */
export function buildCirculation(b, f, { newNode, newEdge, overrides = [] }) {
  const handled = new Set(), report = [];
  for (const cluster of circulationClusters(f)) {
    const ids = new Set(cluster.map((s) => s.id)),
      key = [...ids].sort()[0],
      doors = f.geometry.doors.filter((d) => d.spaceIds.some((id) => ids.has(id))),
      internal = doors.filter((d) => d.spaceIds.length === 2 && d.spaceIds.every((id) => ids.has(id))),
      blockers = [
        ...f.geometry.walls.flatMap((w) => segments(w.points)),
        // Space boundaries are crossed only at usable openings, even without a drawn wall.
        ...boundaryBlockers(cluster, f.geometry.doors.filter((d) => usable(f, d))),
        // Closed or unverified openings and obstacles inside the area block the walk.
        ...f.geometry.doors.filter((d) => !usable(f, d)).map((d) => ({ a: d.a, b: d.b })),
      ];
    // Spurs into spaces with stair/lift landings are real branches, not noise.
    const landings = b.nodes.filter((n) => n.floorId === f.id && n.connectorId && n.spaceIds.some((id) => ids.has(id))),
      landingSpaces = new Set(landings.flatMap((n) => n.spaceIds)),
      keep = (p) => cluster.some((s) => landingSpaces.has(s.id) && inside(p, s.polygon));
    let net;
    try {
      net = centrelineNetwork(cluster.map((s) => s.polygon), blockers, { keep });
      // Pruning must not strip the whole centreline from a piece that has its
      // own doorways out of the area; those pieces keep their spurs.
      const external = doors.filter((d) => usable(f, d) && !internal.includes(d)),
        covered = (s) => net.edges.some((e) => e.path.some((q, i) => inside(q, s.polygon) || (i && inside(midpoint(e.path[i - 1], q), s.polygon)))),
        bare = cluster.filter((s) => external.some((d) => d.spaceIds.includes(s.id)) && !covered(s));
      if (bare.length)
        net = centrelineNetwork(cluster.map((s) => s.polygon), blockers, {
          keep: (p) => keep(p) || bare.some((s) => inside(p, s.polygon)) });
    } catch {
      continue;
    }
    if (!net.nodes.length) continue;
    // Exact check against wall, boundary and obstacle segments: the raster test
    // alone can step diagonally past a one-cell blocker.
    const clear = (p, q) => blockers.every((s) => {
      const hit = intersection(p, q, s.a, s.b);
      return !hit || hit.t < 1e-6 || hit.t > 1 - 1e-6;
    });
    for (const id of ids) handled.add(id);
    const spaceAt = (p) => {
      const hits = cluster.filter((s) => inside(p, s.polygon));
      if (hits.length <= 1) return hits[0] || null;
      // On a seam, pick the piece the point is deepest inside.
      const depth = (s) => Math.min(...s.polygon.map((v, i) => pointSegment(p, v, s.polygon[(i + 1) % s.polygon.length])));
      return hits.sort((x, y) => depth(y) - depth(x))[0];
    };

    // Split a network edge at a point and return the vertex there.
    const vertexAt = (hit) => {
      if (hit.node) return hit.node.id;
      const e = hit.edge, near = net.nodes.find((n) => (n.id === e.a || n.id === e.b) && distance(n.p, hit.q) < 1.5);
      if (near) return near.id;
      const id = Math.max(...net.nodes.map((n) => n.id)) + 1;
      net.nodes.push({ id, p: hit.q });
      net.edges = net.edges.filter((x) => x !== e);
      net.edges.push({ ...e, b: id, path: [...e.path.slice(0, hit.segment), hit.q] }, { ...e, a: id, path: [hit.q, ...e.path.slice(hit.segment)] });
      return id;
    };

    // Real doors inside the area (not analytical joins): the spine passes
    // through the centre of the opening, with a doorway vertex there.
    const doorVertex = new Map();
    for (const d of internal) {
      if (!usable(f, d) || doorRecord(f, d.id)?.openingType === "decomposition-join") continue;
      for (const e of [...net.edges]) {
        const i = e.path.findIndex((p, k) => k && segmentsCross(e.path[k - 1], p, d.a, d.b));
        if (i < 1) continue;
        const m = midpoint(d.a, d.b), hit = { edge: e, segment: i, q: m };
        if (!net.visible(e.path[i - 1], m, 0) || !net.visible(m, e.path[i], 0)) continue;
        doorVertex.set(vertexAt(hit), d);
        break;
      }
    }

    // Doors and landings leading out of the area join the spine through the
    // centre of the opening: straight in along the door normal to the ridge,
    // then to the nearest visible point on the centreline.
    const branches = [];
    const attach = (from, normal, endpoint) => {
      let ridge = ridgeFrom(net, from, normal) || from,
        hit = nearestOnNetwork(net, ridge, (q) => net.visible(ridge, q) && clear(ridge, q));
      // Nothing reachable from the ridge: go straight from the opening's centre.
      if (!hit) {
        ridge = from;
        hit = nearestOnNetwork(net, from, (q) => net.visible(from, q) && clear(from, q));
      }
      if (!hit) return null;
      const v = vertexAt(hit), target = net.nodes.find((n) => n.id === v).p;
      let path = [from, ridge, target].filter((p, i, a) => !i || distance(p, a[i - 1]) > 0.5);
      if (path.length === 3 && pointSegment(ridge, from, target) < 1) path = [from, target];
      branches.push({ endpoint, v, path });
      return v;
    };
    for (const d of doors) {
      if (!usable(f, d) || internal.includes(d)) continue;
      const side = cluster.find((s) => d.spaceIds.includes(s.id)), m = midpoint(d.a, d.b),
        len = distance(d.a, d.b) || 1, n = { x: -(d.b.y - d.a.y) / len, y: (d.b.x - d.a.x) / len },
        normal = inside({ x: m.x + n.x * 2, y: m.y + n.y * 2 }, side.polygon) ? n : { x: -n.x, y: -n.y };
      attach(m, normal, { doorId: d.id });
    }
    // Landings join the centreline inside their own space.
    for (const n of landings) {
      const own = cluster.filter((s) => n.spaceIds.includes(s.id)),
        local = (q) => own.some((s) => inside(q, s.polygon)) && net.visible(n.position, q) && clear(n.position, q),
        hit = nearestOnNetwork(net, n.position, local) || nearestOnNetwork(net, n.position, (q) => net.visible(n.position, q) && clear(n.position, q));
      if (!hit) continue;
      const v = vertexAt(hit);
      branches.push({ endpoint: { nodeId: n.id }, v, path: [n.position, net.nodes.find((x) => x.id === v).p] });
    }

    // Developer overrides: moved vertices, edited spine paths, reconnected doors.
    applyOverrides(f, net, branches, overrides.filter((o) => ids.has(o.spaceId) || !o.spaceId), report);

    // Merge vertices closer than 1 px (spur ends on landings, double splits).
    for (let guard = 0; guard < 1000; guard++) {
      const e = net.edges.find((e) => e.a !== e.b && e.path.reduce((s, q, k) => (k ? s + distance(e.path[k - 1], q) : 0), 0) < 1);
      if (!e) break;
      net.edges = net.edges.filter((x) => x !== e);
      for (const x of net.edges) { if (x.a === e.b) x.a = e.a; if (x.b === e.b) x.b = e.a; }
      for (const br of branches) if (br.v === e.b) br.v = e.a;
      if (doorVertex.has(e.b) && !doorVertex.has(e.a)) doorVertex.set(e.a, doorVertex.get(e.b));
      net.nodes = net.nodes.filter((n) => n.id !== e.b);
    }
    net.edges = net.edges.filter((e) => e.a !== e.b);
    // Emit graph nodes and edges. A landing or doorway sitting on a vertex is that vertex.
    const nodeFor = new Map(), used = new Set();
    for (const br of branches) {
      const v = net.nodes.find((n) => n.id === br.v);
      if (v && br.endpoint.nodeId && distance(v.p, br.path[0]) < 1) { nodeFor.set(v.id, br.endpoint.nodeId); br.skip = true; }
    }
    for (const v of net.nodes) {
      if (nodeFor.has(v.id)) continue;
      const door = doorVertex.get(v.id);
      if (door) { nodeFor.set(v.id, `${door.id}:nav`); continue; }
      const space = spaceAt(v.p);
      if (!space) continue;
      let id = `${key}:nav:${Math.round(v.p.x)}:${Math.round(v.p.y)}`;
      while (used.has(id)) id += "b";
      used.add(id);
      nodeFor.set(v.id, id);
      b.nodes.push(newNode(id, f.id, `${space.label} junction`, "junction", v.p, [space.id]));
    }
    // Reported clearance is exact: distance to the nearest wall, blocked boundary
    // or obstacle segment (the raster is only used to find the centreline).
    const exact = nearestSegmentDistance(blockers);
    const node = (id) => b.nodes.find((n) => n.id === id);
    // A segment that passes through a thin piece between two others gets a
    // polyline point (not a graph vertex) inside that piece, so each segment
    // crosses exactly one opening between linked spaces. The line is unchanged.
    const throughSeams = (path) => path.flatMap((q, i) => {
      if (!i) return [q];
      const p = path[i - 1], cuts = [];
      for (const s of cluster)
        for (let j = 0; j < s.polygon.length; j++) {
          const hit = intersection(p, q, s.polygon[j], s.polygon[(j + 1) % s.polygon.length]);
          if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6) cuts.push(hit.t);
        }
      cuts.sort((x, y) => x - y);
      const extra = [];
      for (let j = 1; j < cuts.length; j++)
        if (cuts[j] - cuts[j - 1] > 1e-3) {
          const t = (cuts[j] + cuts[j - 1]) / 2;
          extra.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
        }
      return [...extra, q];
    });
    let k = 0;
    for (const e of net.edges) {
      const a = node(nodeFor.get(e.a)), z = node(nodeFor.get(e.b));
      if (!a || !z || a.id === z.id) continue;
      const path = throughSeams([a.position, ...e.path.slice(1, -1), z.position]);
      b.edges.push(newEdge(`${key}:spine:${k++}`, f, a, z, path, {
        simplify: false, traversal: "corridor", clearance: pathClearance(f, path, exact) }));
    }
    for (const br of branches.filter((br) => !br.skip)) {
      const a = br.endpoint.doorId ? node(`${br.endpoint.doorId}:nav`) : node(br.endpoint.nodeId), z = node(nodeFor.get(br.v));
      if (!a || !z || a.id === z.id) continue;
      const path = throughSeams([a.position, ...br.path.slice(1, -1), z.position]);
      b.edges.push(newEdge(`${br.endpoint.doorId || br.endpoint.nodeId}:${key}:branch`, f, a, z, path, {
        simplify: false, traversal: br.endpoint.doorId ? "doorway" : "corridor", clearance: pathClearance(f, path, exact) }));
    }
  }
  return { handled, report };
}

// Each polygon edge minus the stretches covered by openings lying on it.
export function boundaryBlockers(spaces, doors, tolerance = 2) {
  const out = [];
  for (const s of spaces)
    for (const { a, b } of segments(s.polygon, true)) {
      const len = distance(a, b);
      if (len < 1e-6) continue;
      const t = (p) => ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len),
        gaps = doors
          .filter((d) => pointSegment(d.a, a, b) <= tolerance && pointSegment(d.b, a, b) <= tolerance)
          .map((d) => [Math.min(t(d.a), t(d.b)), Math.max(t(d.a), t(d.b))])
          .sort((x, y) => x[0] - y[0]);
      let from = 0;
      const at = (u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
      for (const [g0, g1] of gaps) {
        if (g0 > from) out.push({ a: at(from), b: at(Math.min(1, g0)) });
        from = Math.max(from, g1);
      }
      if (from < 1) out.push({ a: at(from), b });
    }
  return out;
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) <= 0 && o(c, d, a) * o(c, d, b) <= 0;
}

/**
 * Developer corrections, replayed after every rebuild so they survive it:
 *  - { op: "move-node", at, to }: move the vertex nearest `at` to `to`.
 *  - { op: "edge-path", from, to, path }: replace the spine between two vertices.
 *  - { op: "door-link", doorId, to }: join a doorway to the centreline at `to`.
 * Each change must stay in walkable space; otherwise it is reported as stale.
 */
export function applyOverrides(f, net, branches, overrides, report) {
  const nearest = (p, r = 12) => net.nodes.map((n) => ({ n, d: distance(n.p, p) })).filter((x) => x.d <= r).sort((a, b) => a.d - b.d)[0]?.n;
  for (const o of overrides) {
    let ok = false;
    if (o.op === "move-node") {
      const v = nearest(o.at);
      const incident = v ? [...net.edges.filter((e) => e.a === v.id || e.b === v.id), ...branches.filter((b) => b.v === v.id)] : [];
      const moved = (path, atEnd) => (atEnd ? [...path.slice(0, -1), o.to] : [o.to, ...path.slice(1)]);
      const trial = incident.map((x) => ({ x, path: x.a === v?.id ? moved(x.path, false) : moved(x.path, true) }));
      if (v && net.clearance(o.to) > 0 && trial.every(({ path }) => path.every((p, i) => !i || net.visible(path[i - 1], p, 0)))) {
        v.p = o.to;
        for (const { x, path } of trial) x.path = path;
        ok = true;
      }
    } else if (o.op === "edge-path") {
      const a = nearest(o.from), z = nearest(o.to),
        e = a && z && net.edges.find((e) => (e.a === a.id && e.b === z.id) || (e.a === z.id && e.b === a.id));
      if (e) {
        const forward = e.a === a.id, path = [a.p, ...o.path.slice(1, -1), z.p];
        if (path.every((p, i) => !i || net.visible(path[i - 1], p, 0))) { e.path = forward ? path : [...path].reverse(); ok = true; }
      }
    } else if (o.op === "door-link") {
      const br = branches.find((b) => b.endpoint.doorId === o.doorId),
        hit = br && nearestOnNetwork(net, o.to, (q) => net.visible(br.path[0], q, 0));
      if (br && hit && distance(hit.q, o.to) < 25) {
        const e = hit.edge, near = hit.node || net.nodes.find((n) => (n.id === e.a || n.id === e.b) && distance(n.p, hit.q) < 1.5);
        let v = near?.id;
        if (v === undefined) {
          v = Math.max(...net.nodes.map((n) => n.id)) + 1;
          net.nodes.push({ id: v, p: hit.q });
          net.edges = net.edges.filter((x) => x !== e);
          net.edges.push({ ...e, b: v, path: [...e.path.slice(0, hit.segment), hit.q] }, { ...e, a: v, path: [hit.q, ...e.path.slice(hit.segment)] });
        }
        br.v = v;
        br.path = [br.path[0], net.nodes.find((n) => n.id === v).p];
        ok = true;
      }
    }
    report.push({ i: o.i, op: o.op, applied: ok });
  }
}
