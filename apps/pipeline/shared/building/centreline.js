// Corridor-centreline network: an invisible walking road through walkable space.
// Walkable polygons are rasterised, a Euclidean distance field to the nearest
// wall/obstacle gives clearance, and morphological thinning gives the medial
// axis. Short spurs created by small boundary details are pruned, chains are
// simplified without leaving walkable space, and only junctions and endpoints
// become navigation vertices; bends stay inside polyline edges.
import { distance, pointSegment } from "../map.js";

const INF = 1e20;

// --- raster -----------------------------------------------------------------
export function walkableRaster(polygons, blockers = [], { maxCells = 450000, minRes = 1, pad = 2 } = {}) {
  const pts = polygons.flat(),
    xmin = Math.min(...pts.map((p) => p.x)),
    ymin = Math.min(...pts.map((p) => p.y)),
    xmax = Math.max(...pts.map((p) => p.x)),
    ymax = Math.max(...pts.map((p) => p.y)),
    res = Math.max(minRes, Math.sqrt(((xmax - xmin) * (ymax - ymin)) / maxCells)),
    x0 = xmin - pad * res,
    y0 = ymin - pad * res,
    w = Math.ceil((xmax - xmin) / res) + 2 * pad,
    h = Math.ceil((ymax - ymin) / res) + 2 * pad,
    mask = new Uint8Array(w * h);
  // Scanline fill: a cell is walkable when its centre is inside any polygon.
  for (const poly of polygons)
    for (let r = 0; r < h; r++) {
      const y = y0 + (r + 0.5) * res,
        xs = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - x0) / res - 0.5)),
          c1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / res - 0.5));
        for (let c = c0; c <= c1; c++) mask[r * w + c] = 1;
      }
    }
  // Walls, closed doors and fixed obstacles cut through the walkable area.
  const half = Math.max(res * 0.75, 0.75);
  for (const { a, b } of blockers) {
    const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - half - x0) / res)),
      c1 = Math.min(w - 1, Math.ceil((Math.max(a.x, b.x) + half - x0) / res)),
      r0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - half - y0) / res)),
      r1 = Math.min(h - 1, Math.ceil((Math.max(a.y, b.y) + half - y0) / res));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        if (pointSegment({ x: x0 + (c + 0.5) * res, y: y0 + (r + 0.5) * res }, a, b) <= half) mask[r * w + c] = 0;
  }
  return { x0, y0, w, h, res, mask };
}

// Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}
/** Distance (floor px) from each walkable cell centre to the nearest blocked cell. */
export function distanceField({ w, h, res, mask }) {
  const g = new Float64Array(w * h), n = Math.max(w, h),
    f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? INF : 0;
  for (let c = 0; c < w; c++) {
    for (let r = 0; r < h; r++) f[r] = g[r * w + c];
    edt1d(f, h, d, v, z);
    for (let r = 0; r < h; r++) g[r * w + c] = d[r];
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) f[c] = g[r * w + c];
    edt1d(f, w, d, v, z);
    for (let c = 0; c < w; c++) g[r * w + c] = Math.sqrt(d[c]) * res;
  }
  return g;
}

// Zhang–Suen thinning to a one-cell-wide, 8-connected medial axis. Only the
// remaining foreground is scanned each pass; the raster is padded, so
// foreground cells never touch the grid edge.
export function skeletonize({ w, h, mask }) {
  const s = Uint8Array.from(mask);
  let active = [];
  for (let i = 0; i < w * h; i++) if (s[i]) active.push(i);
  const del = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const pass of [0, 1]) {
      del.length = 0;
      for (const i of active) {
        const p0 = s[i - w], p1 = s[i - w + 1], p2 = s[i + 1], p3 = s[i + w + 1],
          p4 = s[i + w], p5 = s[i + w - 1], p6 = s[i - 1], p7 = s[i - w - 1],
          b = p0 + p1 + p2 + p3 + p4 + p5 + p6 + p7;
        if (b < 2 || b > 6) continue;
        const a = (!p0 && p1) + (!p1 && p2) + (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p0);
        if (a !== 1) continue;
        if (pass === 0 ? !(p0 && p2 && p4) && !(p2 && p4 && p6) : !(p0 && p2 && p6) && !(p0 && p4 && p6)) del.push(i);
      }
      for (const i of del) s[i] = 0;
      if (del.length) { changed = true; active = active.filter((i) => s[i]); }
    }
  }
  return s;
}

// --- skeleton graph -------------------------------------------------------------
const OFF = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];
function neighbours(s, w, h, i) {
  const r = Math.floor(i / w), c = i % w, out = [];
  for (const [dr, dc] of OFF) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && cc >= 0 && rr < h && cc < w && s[rr * w + cc]) out.push(rr * w + cc);
  }
  return out;
}
// Crossing number: 1 = endpoint, 2 = line, 3+ = junction. Staircase pixels stay "line".
function crossing(s, w, h, i) {
  const r = Math.floor(i / w), c = i % w,
    p = OFF.map(([dr, dc]) => { const rr = r + dr, cc = c + dc; return rr >= 0 && cc >= 0 && rr < h && cc < w ? s[rr * w + cc] : 0; });
  let n = 0;
  for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) n++;
  return p.every((x) => x) ? 0 : n;
}

export function skeletonGraph(raster, skel, dist) {
  const { w, h, res, x0, y0 } = raster,
    pt = (i) => ({ x: x0 + ((i % w) + 0.5) * res, y: y0 + (Math.floor(i / w) + 0.5) * res }),
    pixels = [];
  for (let i = 0; i < w * h; i++) if (skel[i]) pixels.push(i);
  const isNode = new Map();
  for (const i of pixels) { const cn = crossing(skel, w, h, i); if (cn !== 2) isNode.set(i, true); }
  // Group adjacent node pixels into one vertex.
  const cluster = new Map(), nodes = [];
  for (const i of isNode.keys()) {
    if (cluster.has(i)) continue;
    const id = nodes.length, members = [i];
    cluster.set(i, id);
    for (let k = 0; k < members.length; k++)
      for (const j of neighbours(skel, w, h, members[k])) if (isNode.has(j) && !cluster.has(j)) { cluster.set(j, id); members.push(j); }
    const ps = members.map(pt);
    nodes.push({ id, p: { x: ps.reduce((a, q) => a + q.x, 0) / ps.length, y: ps.reduce((a, q) => a + q.y, 0) / ps.length }, pixels: members });
  }
  // Chains: connected pieces of line pixels between vertex clusters. Each piece
  // is turned into edges with shortest pixel paths, so two-pixel-thick diagonal
  // steps cannot cut a chain short (a greedy walk loses whole corridors there).
  const edges = [], inPiece = new Set();
  const bfs = (sources, allowed) => {
    const prev = new Map(), d = new Map(), order = [];
    for (const s of sources) if (!prev.has(s)) { prev.set(s, -1); d.set(s, 0); order.push(s); }
    for (let k = 0; k < order.length; k++)
      for (const j of neighbours(skel, w, h, order[k])) if (allowed.has(j) && !prev.has(j)) { prev.set(j, order[k]); d.set(j, d.get(order[k]) + 1); order.push(j); }
    return { prev, d, order };
  };
  const walk = (prev, end) => { const out = []; for (let c = end; c !== -1; c = prev.get(c)) out.push(c); return out.reverse(); };
  const vertexAtPixel = (i) => { const id = nodes.length; nodes.push({ id, p: pt(i), pixels: [i] }); return id; };
  const link = (a, b, pix) => edges.push({ a, b, path: [nodes[a].p, ...pix.map(pt), nodes[b].p] });
  for (const start of pixels) {
    if (cluster.has(start) || inPiece.has(start)) continue;
    const members = new Set([start]), queue = [start];
    inPiece.add(start);
    for (let k = 0; k < queue.length; k++)
      for (const j of neighbours(skel, w, h, queue[k])) if (!cluster.has(j) && !inPiece.has(j)) { inPiece.add(j); members.add(j); queue.push(j); }
    const touch = new Map();
    for (const m of members) for (const j of neighbours(skel, w, h, m)) if (cluster.has(j)) {
      const id = cluster.get(j);
      if (!touch.has(id)) touch.set(id, new Set());
      touch.get(id).add(m);
    }
    const ids = [...touch.keys()];
    const pathTo = (from, target) => {
      const r = bfs([...from], members), end = r.order.find((x) => target.has(x));
      return end === undefined ? null : walk(r.prev, end);
    };
    if (ids.length === 0) {
      // A ring with no junction: split it into two halves between far-apart pixels.
      const a = bfs([start], members).order.at(-1), r = bfs([a], members), z = r.order.at(-1), half = walk(r.prev, z);
      const near = new Set(half.flatMap((x) => [x, ...neighbours(skel, w, h, x)]));
      const rest = new Set([...members].filter((x) => !near.has(x) || x === a || x === z || neighbours(skel, w, h, x).some((y) => y === a || y === z)));
      const va = vertexAtPixel(a), vz = vertexAtPixel(z);
      link(va, vz, half.slice(1, -1));
      const back = bfs([z], rest);
      if (back.prev.has(a)) link(vz, va, walk(back.prev, a).slice(1, -1));
    } else if (ids.length === 1) {
      const [id] = ids, t = [...touch.get(id)], r = bfs([t[0]], members),
        far = t.reduce((best, x) => ((r.d.get(x) ?? -1) > (r.d.get(best) ?? -1) ? x : best), t[0]);
      if ((r.d.get(far) ?? 0) > 3) link(id, id, walk(r.prev, far)); // leaves and re-enters the same vertex: a loop
      else {
        const fromVertex = bfs(t, members), end = fromVertex.order.at(-1);
        link(id, vertexAtPixel(end), walk(fromVertex.prev, end).slice(0, -1));
      }
    } else if (ids.length === 2) {
      const pix = pathTo(touch.get(ids[0]), touch.get(ids[1]));
      if (pix) link(ids[0], ids[1], pix);
    } else {
      // Three or more vertices on one piece: join them at the most central pixel.
      const reach = ids.map((id) => bfs([...touch.get(id)], members).d);
      let hub = start, best = Infinity;
      for (const m of members) { const sum = reach.reduce((n, d) => n + (d.get(m) ?? 1e9), 0); if (sum < best) { best = sum; hub = m; } }
      const v = vertexAtPixel(hub);
      for (const id of ids) { const pix = pathTo(new Set([hub]), touch.get(id)); if (pix) link(v, id, pix.slice(1)); }
    }
  }
  const clearance = (p) => sample(raster, dist, p);
  for (const e of edges) {
    e.length = e.path.reduce((s, q, k) => (k ? s + distance(e.path[k - 1], q) : 0), 0);
    e.minHalf = Math.min(...e.path.map(clearance));
  }
  return { nodes: nodes.map((n) => ({ id: n.id, p: n.p })), edges: edges.filter((e) => e.a !== e.b || e.length > res * 3) };
}

export function sample({ x0, y0, w, h, res }, field, p) {
  const c = Math.floor((p.x - x0) / res), r = Math.floor((p.y - y0) / res);
  return c < 0 || r < 0 || c >= w || r >= h ? 0 : field[r * w + c];
}

/** True when the straight segment stays in walkable cells with at least `margin` px clearance. */
export function visible(raster, dist, a, b, margin = 0) {
  const n = Math.max(2, Math.ceil(distance(a, b) / (raster.res * 0.5)));
  for (let k = 0; k <= n; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
    if (sample(raster, dist, p) <= margin) return false;
  }
  return true;
}

// Douglas–Peucker that only accepts shortcuts staying inside walkable space.
export function simplifyChain(path, ok, tol) {
  if (path.length <= 2) return path;
  const a = path[0], z = path.at(-1);
  let worst = -1, at = -1;
  for (let i = 1; i < path.length - 1; i++) {
    const d = pointSegment(path[i], a, z);
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol && ok(a, z)) return [a, z];
  return [...simplifyChain(path.slice(0, at + 1), ok, tol).slice(0, -1), ...simplifyChain(path.slice(at), ok, tol)];
}

// Removes leaf spurs shorter than `factor` x the clearance at their junction
// (corner artefacts, small boundary jogs), then merges degree-2 vertices.
export function pruneNetwork(net, { factor = 2, keep = () => false, minLength = 0 } = {}) {
  let { nodes, edges } = net;
  const degree = () => { const d = new Map(nodes.map((n) => [n.id, 0])); for (const e of edges) { d.set(e.a, d.get(e.a) + 1); d.set(e.b, d.get(e.b) + 1); } return d; };
  // Adjacent junction pixels can leave a twin vertex with no edges; a doorway
  // must never attach to it, so edgeless vertices are dropped.
  const dropIsolated = () => { const d = degree(); if (edges.length) nodes = nodes.filter((n) => d.get(n.id) > 0); };
  dropIsolated();
  for (let round = 0; round < 50; round++) {
    const deg = degree();
    const spur = edges.find((e) => {
      const leaf = deg.get(e.a) === 1 ? e.a : deg.get(e.b) === 1 ? e.b : null;
      if (leaf === null || deg.get(e.a) + deg.get(e.b) === 2) return false;
      if (keep(nodes.find((n) => n.id === leaf).p)) return false;
      const root = leaf === e.a ? e.b : e.a, rootHalf = net.clearance(nodes.find((n) => n.id === root).p);
      return e.length < Math.max(minLength, factor * rootHalf);
    });
    if (!spur) break;
    edges = edges.filter((e) => e !== spur);
    const d2 = degree();
    nodes = nodes.filter((n) => d2.get(n.id) > 0 || !edges.length);
  }
  // Merge straight-through vertices so only junctions and ends remain.
  for (let round = 0; round < 1000; round++) {
    const deg = degree(), mid = nodes.find((n) => deg.get(n.id) === 2 && edges.filter((e) => e.a === n.id || e.b === n.id).every((e) => e.a !== e.b));
    if (!mid) break;
    const [e1, e2] = edges.filter((e) => e.a === mid.id || e.b === mid.id);
    const p1 = e1.b === mid.id ? e1.path : [...e1.path].reverse(),
      p2 = e2.a === mid.id ? e2.path : [...e2.path].reverse(),
      a = e1.b === mid.id ? e1.a : e1.b, b = e2.a === mid.id ? e2.b : e2.a;
    if (a === b && p1.length + p2.length < 4) break;
    edges = edges.filter((e) => e !== e1 && e !== e2);
    edges.push({ a, b, path: [...p1, ...p2.slice(1)], length: e1.length + e2.length, minHalf: Math.min(e1.minHalf, e2.minHalf) });
    nodes = nodes.filter((n) => n !== mid);
  }
  dropIsolated();
  return { ...net, nodes, edges };
}

/**
 * Builds the centreline network for one connected walkable area.
 * Returns vertices, polyline edges, and helpers bound to the same distance field.
 */
export function centrelineNetwork(polygons, blockers = [], { keep = () => false, pruneFactor = 2 } = {}) {
  const raster = walkableRaster(polygons, blockers),
    dist = distanceField(raster),
    skel = skeletonize(raster),
    graph = skeletonGraph(raster, skel, dist),
    clearance = (p) => sample(raster, dist, p),
    ok = (a, b) => visible(raster, dist, a, b, raster.res * 0.5);
  const net = pruneNetwork({ ...graph, clearance }, { factor: pruneFactor, keep, minLength: raster.res * 3 });
  net.edges = net.edges.map((e) => {
    const tol = Math.max(raster.res * 1.2, Math.min(e.minHalf * 0.35, 6));
    return { ...e, path: simplifyChain(e.path, ok, tol) };
  });
  // A closed loop comes back to its own vertex; give it a second vertex halfway.
  for (const e of [...net.edges].filter((e) => e.a === e.b)) {
    const k = Math.floor(e.path.length / 2), id = Math.max(...net.nodes.map((n) => n.id)) + 1;
    net.nodes.push({ id, p: e.path[k] });
    net.edges = net.edges.filter((x) => x !== e);
    net.edges.push({ ...e, b: id, path: e.path.slice(0, k + 1) }, { ...e, a: id, path: e.path.slice(k) });
  }
  return { ...net, raster, dist, clearance, visible: (a, b, margin = raster.res * 0.5) => visible(raster, dist, a, b, margin) };
}

// Nearest point on any network edge polyline (or vertex) to p.
export function nearestOnNetwork(net, p, accept = () => true) {
  let best = null;
  for (const e of net.edges)
    for (let i = 1; i < e.path.length; i++) {
      const a = e.path[i - 1], b = e.path[i], dx = b.x - a.x, dy = b.y - a.y,
        t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))),
        q = { x: a.x + t * dx, y: a.y + t * dy }, d = distance(p, q);
      if ((!best || d < best.d) && accept(q)) best = { d, q, edge: e, segment: i, t };
    }
  const linked = new Set(net.edges.flatMap((e) => [e.a, e.b]));
  for (const n of net.nodes) {
    if (net.edges.length && !linked.has(n.id)) continue;
    const d = distance(p, n.p);
    if ((!best || d < best.d - 1e-6) && accept(n.p)) best = { d, q: n.p, node: n };
  }
  return best;
}

// Walks from a door midpoint along its inward normal to the corridor ridge
// (where clearance stops increasing): the natural door-to-centreline joint.
export function ridgeFrom(net, m, normal, maxDepth = 400) {
  const step = net.raster.res * 0.5, entry = net.raster.res * 3 + 2;
  let best = null, bestC = -1, drop = 0;
  for (let k = step; k <= maxDepth; k += step) {
    const p = { x: m.x + normal.x * k, y: m.y + normal.y * k }, c = net.clearance(p);
    // The opening itself can sit on a wall band (e.g. before its gap is cut).
    if (c <= 0 && k <= entry && !best) continue;
    if (c <= 0) break;
    if (c > bestC + 1e-9) { bestC = c; best = p; drop = 0; }
    else if (++drop > 3) break;
  }
  return best;
}
