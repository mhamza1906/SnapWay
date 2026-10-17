// Rooms, hallways and doorways from a clean floor-plan raster (black walls on
// white, as produced by the clean-plan stage). Deterministic, no model call.
//
// 1. Walls: dark strokes at least `minWallHalf` px from their own edge
//    (morphological opening), so text, seat rows and stair treads drop out.
// 2. Spaces: free pixels are flooded from high to low distance-to-wall. Two
//    growing areas stay separate only where they meet through a constriction
//    (a doorway): the meeting level is well below both areas' widest points.
//    A corridor junction or a bend is not a constriction and merges.
// 3. Wall pixels are shared out to the nearest space, so spaces tile the
//    floor and neighbours share an edge along the wall centre line. Spaces
//    too small or too narrow to walk join a neighbour.
// 4. Outlines: boundary chains between spaces, each simplified once and
//    shared by both sides without crossing any other chain.
// 5. Doorways: where two spaces touch across free floor (not across a wall).
// 6. Spaces touching the image border are outside the building.
import sharp from "sharp";
import { distanceField } from "../../shared/building/centreline.js";
import { wallMask, outsideLabels } from "./raster-walls.js";
export { wallMask, outsideLabels };

const N4 = (w) => [-1, 1, -w, w];

export async function loadGray(input) {
  const { data, info } = await sharp(input).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { gray: data, w: info.width, h: info.height };
}

/**
 * Region growing on the distance-to-wall field. Areas merge unless they meet
 * through a passage narrower than `ratio` of the smaller area's widest point
 * (and narrower than `maxDoorHalf`). Returns a label image (0 = wall/none).
 */
export function segmentSpaces(walls, w, h, { ratio = 0.72, maxDoorHalf = 40, minPeak = 4 } = {}) {
  const free = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) free[i] = walls[i] ? 0 : 1;
  const dist = distanceField({ w, h, res: 1, mask: free });
  // Bucket sort free pixels by distance, high first.
  let top = 0;
  for (let i = 0; i < w * h; i++) if (free[i] && dist[i] > top) top = dist[i];
  const scale = 4, maxD = Math.ceil(top * scale) + 1, order = [];
  const byLevel = Array.from({ length: maxD + 1 }, () => []);
  for (let i = 0; i < w * h; i++) if (free[i]) byLevel[Math.round(dist[i] * scale)].push(i);
  for (let k = maxD; k >= 0; k--) for (const i of byLevel[k]) order.push(i);
  // Union-find over growing areas.
  const label = new Int32Array(w * h).fill(-1), parent = [], peak = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const nb = N4(w);
  for (const i of order) {
    // Neighbouring areas, each with the distance of its deepest neighbour pixel.
    const x = i % w, level = dist[i], roots = new Map();
    for (const o of nb) {
      const j = i + o;
      if (j < 0 || j >= w * h || (o === -1 && x === 0) || (o === 1 && x === w - 1) || label[j] < 0) continue;
      const r = find(label[j]);
      if (!(roots.get(r) >= dist[j])) roots.set(r, dist[j]);
    }
    if (!roots.size) { const id = parent.length; parent.push(id); peak.push(level); label[i] = id; continue; }
    const rs = [...roots.keys()].sort((a, b) => peak[b] - peak[a]);
    // The pixel joins the area it grows from (its deepest neighbour), not the
    // widest area: otherwise a room leaks through its door gap and along the
    // wall-side strip of the corridor, whose pixels are no deeper than the gap.
    let from = rs[0];
    for (const r of rs) if (roots.get(r) > roots.get(from)) from = r;
    label[i] = from;
    for (const r of rs.slice(1)) {
      const a = find(rs[0]), b = find(r);
      if (a === b) continue;
      const small = Math.min(peak[a], peak[b]);
      // Merge unless this is a doorway-like constriction between two real spaces.
      const constriction = level < ratio * small && level <= maxDoorHalf && small >= minPeak;
      if (!constriction) { parent[b] = a; peak[a] = Math.max(peak[a], peak[b]); }
    }
  }
  const out = new Int32Array(w * h), ids = new Map();
  for (let i = 0; i < w * h; i++) if (label[i] >= 0) {
    const r = find(label[i]);
    if (!ids.has(r)) ids.set(r, ids.size + 1);
    out[i] = ids.get(r);
  }
  return { labels: out, count: ids.size, dist, peaks: [...ids.entries()].reduce((m, [r, id]) => (m[id] = peak[r], m), [0]) };
}

// Wall pixels join the nearest space (multi-source BFS), so spaces tile.
export function shareWalls(labels, walls, w, h) {
  const out = Int32Array.from(labels), queue = [];
  for (let i = 0; i < w * h; i++) if (out[i]) queue.push(i);
  const nb = N4(w);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], x = i % w;
    for (const o of nb) {
      const j = i + o;
      if (j < 0 || j >= w * h || (o === -1 && x === 0) || (o === 1 && x === w - 1) || out[j]) continue;
      out[j] = out[i]; queue.push(j);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Regions to a map: shared-edge polygons, doorways, walls, labels and kinds.

const same = (p, q) => p.x === q.x && p.y === q.y;
const ringArea = (r) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p.x * q.y - q.x * p.y; }, 0) / 2;

// Douglas–Peucker. Tolerance 0 only drops collinear lattice points (lossless).
function dpOpen(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let best = -1, bi = -1;
    const A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dx * (pts[i].y - A.y) - dy * (pts[i].x - A.x)) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// A closed chain (the whole outline of an island) is split at the point
// farthest from its start first, and keeps at least a triangle.
function dp(pts, tol) {
  if (pts.length < 4 || !same(pts[0], pts.at(-1))) return dpOpen(pts, tol);
  const a = pts[0], d2 = (p) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  let far = 1;
  for (let i = 2; i < pts.length - 1; i++) if (d2(pts[i]) > d2(pts[far])) far = i;
  const out = [...dpOpen(pts.slice(0, far + 1), tol), ...dpOpen(pts.slice(far), tol).slice(1)];
  return out.length >= 4 || tol === 0 ? out : dp(pts, tol > 0.3 ? tol / 2 : 0);
}

// Per region: pixel area, peak distance to wall (its half-width), shared
// boundary length with each neighbour, and how much of its boundary is open
// (free floor on both sides, i.e. a passage rather than a wall).
function regionStats(rid, walls, dist, w, h) {
  const st = new Map();
  let last = null;
  const get = (r) => {
    if (last && last.id === r) return last;
    let s = st.get(r);
    if (!s) st.set(r, (s = { id: r, area: 0, peak: 0, open: 0, touch: new Map() }));
    return s;
  };
  for (let i = 0; i < w * h; i++) {
    const a = rid[i], s = (last = get(a)), x = i % w;
    s.area++;
    if (!walls[i] && dist[i] > s.peak) s.peak = dist[i];
    for (const j of [x < w - 1 ? i + 1 : -1, i + w < w * h ? i + w : -1]) {
      if (j < 0 || rid[j] === a) continue;
      const t = get(rid[j]);
      s.touch.set(rid[j], (s.touch.get(rid[j]) || 0) + 1);
      t.touch.set(a, (t.touch.get(a) || 0) + 1);
      if (!walls[i] && !walls[j]) { s.open++; t.open++; }
    }
  }
  return st;
}

// Regions chosen by `pick` join the neighbour they share most boundary with
// (0, the outside, drops them), smallest first, until none is left.
function mergeInto(rid, walls, dist, w, h, pick) {
  for (let pass = 0; pass < 8; pass++) {
    const st = regionStats(rid, walls, dist, w, h), parent = new Map();
    const find = (r) => { while (parent.has(r)) r = parent.get(r); return r; };
    const chosen = [...st.values()].filter((s) => s.id && pick(s)).sort((a, b) => a.area - b.area || a.id - b.id);
    for (const s of chosen) {
      const best = [...s.touch].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0];
      const to = best && find(best[0]);
      if (best && to !== s.id) parent.set(s.id, to);
    }
    if (!parent.size) break;
    for (let i = 0; i < w * h; i++) if (parent.has(rid[i])) rid[i] = find(rid[i]);
  }
  return rid;
}

// Every region must be one 4-connected piece that never touches itself only
// at a corner (its outline would touch itself there). A diagonal pinch gives
// one of the two other pixels to the pinched region; extra pieces get new
// IDs, and small ones join a neighbour. The outside (0) may be in pieces.
function tidyRegions(rid, walls, dist, w, h, minArea, nextId) {
  for (let round = 0; round < 4; round++) {
    let changed = 0;
    for (let pass = 0; pass < 8; pass++) {
      let n = 0;
      for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
        const i = y * w + x, a = rid[i], b = rid[i + 1], c = rid[i + w], d = rid[i + w + 1];
        if (a === d && b !== a && c !== a) { rid[i + 1] = a; n++; }
        else if (b === c && a !== b && d !== b) { rid[i + w + 1] = b; n++; }
      }
      changed += n;
      if (!n) break;
    }
    const seen = new Uint8Array(w * h), best = new Map(), comps = [];
    for (let i = 0; i < w * h; i++) {
      if (seen[i]) continue;
      const r = rid[i], queue = [i];
      seen[i] = 1;
      let border = false;
      for (let q = 0; q < queue.length; q++) {
        const k = queue[q], x = k % w;
        if (x === 0 || x === w - 1 || k < w || k >= w * (h - 1)) border = true;
        for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w])
          if (j >= 0 && j < w * h && !seen[j] && rid[j] === r) { seen[j] = 1; queue.push(j); }
      }
      const comp = { r, start: i, size: queue.length, border };
      comps.push(comp);
      const top = best.get(r);
      if (r && (!top || comp.size > top.size)) best.set(r, comp);
    }
    const fresh = new Set();
    for (const comp of comps) {
      if (comp.r ? best.get(comp.r) === comp : comp.border) continue;
      const id = nextId.value++, queue = [comp.start];
      fresh.add(id); changed++;
      rid[comp.start] = id;
      for (let q = 0; q < queue.length; q++) {
        const k = queue[q], x = k % w;
        for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w])
          if (j >= 0 && j < w * h && rid[j] === comp.r) { rid[j] = id; queue.push(j); }
      }
    }
    if (fresh.size) mergeInto(rid, walls, dist, w, h, (s) => fresh.has(s.id) && s.area < minArea);
    if (!changed) break;
  }
  return rid;
}

/**
 * Boundary chains between regions on the pixel-corner lattice. A chain is a
 * run of boundary edges with the same pair of regions and the same "open"
 * state (open = free floor on both sides, i.e. a passage, not a wall).
 */
function boundaryChains(rid, walls, w, h) {
  const W = w + 1, L = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : rid[y * w + x]),
    F = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : walls[y * w + x] ? 0 : 1),
    edges = [], at = new Map();
  const add = (v1, v2, p, q, open) => {
    const e = { v: [v1, v2], pair: p < q ? [p, q] : [q, p], open, used: false };
    edges.push(e);
    for (const v of e.v) { const list = at.get(v); if (list) list.push(e); else at.set(v, [e]); }
  };
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) {
    const a = L(x - 1, y), b = L(x, y);
    if (a !== b) add(y * W + x, (y + 1) * W + x, a, b, F(x - 1, y) && F(x, y));
  }
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) {
    const a = L(x, y - 1), b = L(x, y);
    if (a !== b) add(y * W + x, y * W + x + 1, a, b, F(x, y - 1) && F(x, y));
  }
  const key = (e) => `${e.pair[0]}:${e.pair[1]}:${e.open ? 1 : 0}`;
  const isNode = (v) => { const es = at.get(v); return es.length !== 2 || key(es[0]) !== key(es[1]); };
  const pt = (v) => ({ x: v % W, y: Math.floor(v / W) });
  const chains = [];
  const walk = (start, e0) => {
    const vs = [start]; let v = start, e = e0;
    for (;;) {
      e.used = true;
      v = e.v[0] === v ? e.v[1] : e.v[0];
      vs.push(v);
      if (v === start || isNode(v)) break;
      e = at.get(v).find((x) => !x.used);
      if (!e) break;
    }
    chains.push({ pair: e0.pair, open: e0.open, points: vs.map(pt) });
  };
  for (const [v, es] of at) if (isNode(v)) for (const e of es) if (!e.used) walk(v, e);
  for (const e of edges) if (!e.used) walk(e.v[0], e);
  return chains;
}

// Closed rings of one region as chain sequences [{ i, rev }], each with its
// signed lattice area, largest (the outline) first. Regions are pinch-free,
// so two of the region's chain ends meet at every vertex on its boundary.
function ringPlans(id, chains) {
  const ends = new Map(), own = [], k = (p) => p.y * 65536 + p.x;
  chains.forEach((c, i) => {
    if (c.pair[0] !== id && c.pair[1] !== id) return;
    own.push(i);
    for (const [p, rev] of [[c.points[0], false], [c.points.at(-1), true]]) {
      const list = ends.get(k(p));
      if (list) list.push({ i, rev }); else ends.set(k(p), [{ i, rev }]);
    }
  });
  const used = new Set(), rings = [];
  for (const s of own) {
    if (used.has(s)) continue;
    const plan = [], start = k(chains[s].points[0]);
    let i = s, rev = false, closed = false;
    for (;;) {
      used.add(i); plan.push({ i, rev });
      const p = chains[i].points, end = k(rev ? p[0] : p.at(-1));
      if (end === start) { closed = true; break; }
      const next = (ends.get(end) || []).find((e) => !used.has(e.i));
      if (!next) break;
      ({ i, rev } = next);
    }
    if (!closed) continue;
    const area = ringArea(ringPoints(plan, chains, "points"));
    if (area) rings.push({ plan, area });
  }
  return rings.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
}
function ringPoints(plan, chains, field) {
  const out = [];
  for (const { i, rev } of plan) {
    const p = chains[i][field], q = rev ? [...p].reverse() : p;
    out.push(...(out.length ? q.slice(1) : q));
  }
  if (out.length > 1 && same(out[0], out.at(-1))) out.pop();
  return out;
}

// Polygons cannot have holes. A region that encloses another (a corridor ring
// round a void, a lobby round a stair core) is cut through the hole's centre
// into simply connected pieces; the cut becomes an open circulation join.
function splitEnclosing(rid, walls, dist, w, h, minArea, nextId) {
  for (let pass = 0; ; pass++) {
    tidyRegions(rid, walls, dist, w, h, minArea, nextId);
    const chains = boundaryChains(rid, walls, w, h), ids = new Set();
    for (const c of chains) for (const r of c.pair) if (r) ids.add(r);
    const cuts = [];
    for (const r of ids) {
      const hole = ringPlans(r, chains)[1];
      if (!hole) continue;
      const pts = ringPoints(hole.plan, chains, "points");
      cuts.push({ r, y: Math.round(pts.reduce((s, p) => s + p.y, 0) / pts.length) });
    }
    if (!cuts.length || pass >= 24) return;
    for (const { r, y } of cuts) {
      const id = nextId.value++;
      for (let i = y * w; i < w * h; i++) if (rid[i] === r) rid[i] = id;
    }
  }
}

// Exact segment tests on lattice points. Two segments may only meet at a
// shared end (a chain node or the joint between consecutive segments), and
// not run along each other there.
const orient = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
const within = (p, a, b) => Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
function segmentsConflict(a, b, c, d) {
  const shared = [[a, c, b, d], [a, d, b, c], [b, c, a, d], [b, d, a, c]].filter(([p, q]) => same(p, q));
  if (shared.length > 1) return true;
  if (shared.length === 1) {
    const [p, , q1, q2] = shared[0];
    return orient(p, q1, q2) === 0 && (q1.x - p.x) * (q2.x - p.x) + (q1.y - p.y) * (q2.y - p.y) > 0;
  }
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && within(c, a, b)) || (o2 === 0 && within(d, a, b)) || (o3 === 0 && within(a, c, d)) || (o4 === 0 && within(b, c, d));
}
// Indices of chains whose simplified segments touch or cross another's.
function crossingChains(chains, cell = 32) {
  const grid = new Map();
  chains.forEach((c, ci) => {
    const p = c.simple;
    for (let k = 0; k + 1 < p.length; k++) {
      const a = p[k], b = p[k + 1], s = { a, b, c: ci,
        x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
      for (let gy = Math.floor(s.y0 / cell); gy <= Math.floor(s.y1 / cell); gy++)
        for (let gx = Math.floor(s.x0 / cell); gx <= Math.floor(s.x1 / cell); gx++) {
          const key = gy * 65536 + gx, list = grid.get(key);
          if (list) list.push(s); else grid.set(key, [s]);
        }
    }
  });
  const bad = new Set();
  for (const [key, list] of grid) {
    const gy = Math.floor(key / 65536), gx = key - gy * 65536;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const s = list[i], t = list[j], x0 = Math.max(s.x0, t.x0), y0 = Math.max(s.y0, t.y0);
      // Test each pair once, in the cell holding the corner of their overlap.
      if (x0 > Math.min(s.x1, t.x1) || y0 > Math.min(s.y1, t.y1)) continue;
      if (Math.floor(x0 / cell) !== gx || Math.floor(y0 / cell) !== gy) continue;
      if (segmentsConflict(s.a, s.b, t.a, t.b)) { bad.add(s.c); bad.add(t.c); }
    }
  }
  return bad;
}

// Topology-preserving simplification. Each chain is simplified once and
// shared by both its regions. Open chains (passages) are first tried as one
// straight doorway segment. Chains that then touch or cross another chain,
// or turn a ring inside out, are simplified again more finely, down to the
// exact lattice outline, which never crosses.
function simplifyChains(chains, rings, tol) {
  for (const c of chains) {
    c.tol = tol;
    c.straight = c.open && Math.hypot(c.points[0].x - c.points.at(-1).x, c.points[0].y - c.points.at(-1).y) >= 2;
  }
  let dirty = chains;
  for (let round = 0; round < 16; round++) {
    for (const c of dirty) c.simple = c.straight ? [c.points[0], c.points.at(-1)] : dp(c.points, c.tol);
    const bad = crossingChains(chains);
    for (const ring of rings) {
      const area = ringArea(ringPoints(ring.plan, chains, "simple"));
      if (Math.sign(area) !== Math.sign(ring.area) || Math.abs(area) < 0.5) for (const { i } of ring.plan) bad.add(i);
    }
    if (!bad.size) return chains;
    dirty = [...bad].map((i) => chains[i]);
    for (const c of dirty) if (c.straight) c.straight = false; else c.tol = c.tol > 0.3 ? c.tol / 2 : 0;
  }
  return chains;
}

const GENERIC = /^(unlabel|unlabeled|unknown|unnamed|space\b|area\b)/i;
// "Hall" alone is a room name (Innovation Hall); these words mean circulation.
// The model only names rooms: printed stair names stay rooms until the user
// marks them as stairs (or merges them into one).
const circulationKind = (label) => /\b(lobby|atrium|foyer|concourse|vestibule|entrance)\b/i.test(label) ? "lobby"
  : /\b(corridor|hallway|passage|walkway)\b/i.test(label) ? "corridor" : null;
// "THE CAVE" and "THE CAVE 210 SEATS" are one name; keep the fuller one.
function distinctLabels(labels) {
  const clean = [...new Set(labels.map((l) => l.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  return clean.filter((l, i) => !clean.slice(0, i).some((m) => m.toLowerCase().includes(l.toLowerCase())));
}
const KIND = { room: "room", restroom: "restroom", storage: "storage", corridor: "corridor", stair: "room", elevator: "room", lobby: "lobby" };

/**
 * Whole raster stage for one clean source image. `inventory` items give
 * names (and kinds) by position, in the image's own pixel frame.
 * Regions whose half-width at their widest point (peak distance to wall) is
 * below `minWalkFraction` of the image's long side cannot be walked: gaps
 * between double wall lines or wall pieces. Long thin regions up to 1.6 times
 * as wide with no opening of door width (shafts, casework, wall cavities) are
 * not walkable either. Both join the neighbour they share most boundary with.
 */
export async function rasterRoomsMap(image, { source, inventory = [], minAreaFraction = 0.00025, minWalkFraction = 0.003,
  simplify = 1.5, minDoor = 8 } = {}) {
  const { gray, w, h } = await loadGray(image);
  const walls = wallMask(gray, w, h), seg = segmentSpaces(walls, w, h);
  // Outside: anything grown from the image border.
  const outside = outsideLabels(seg, walls, w, h);
  const rid = shareWalls(seg.labels, walls, w, h);
  for (let i = 0; i < w * h; i++) if (outside.has(rid[i])) rid[i] = 0;
  const minArea = Math.max(200, minAreaFraction * w * h), minHalf = minWalkFraction * Math.max(w, h);
  // Small regions (text blobs, wall slivers), then regions too narrow to walk.
  mergeInto(rid, walls, seg.dist, w, h, (s) => s.area < minArea);
  mergeInto(rid, walls, seg.dist, w, h, (s) => s.peak < minHalf
    || (s.open < minDoor && s.peak < 1.6 * minHalf && s.area >= 3 * (2 * s.peak) ** 2));
  let top = 0; for (const v of rid) if (v > top) top = v;
  const before = Int32Array.from(rid);
  splitEnclosing(rid, walls, seg.dist, w, h, minArea, { value: top + 1 });
  // Pieces cut from one region keep its identity: same name, joined openly.
  const origin = new Map();
  for (let i = 0; i < w * h; i++) if (rid[i] && !origin.has(rid[i])) origin.set(rid[i], before[i]);
  // Region features.
  const stats = new Map();
  for (let i = 0; i < w * h; i++) {
    const r = rid[i]; if (!r) continue;
    const s = stats.get(r) || { id: r, area: 0, peak: 0, sx: 0, sy: 0 };
    s.area++; s.sx += i % w; s.sy += Math.floor(i / w);
    if (!walls[i] && seg.dist[i] > s.peak) s.peak = seg.dist[i];
    stats.set(r, s);
  }
  const ids = [...stats.keys()].sort((a, b) => a - b), spaceId = (r) => `raster-${r}`;
  const chains = boundaryChains(rid, walls, w, h), rings = new Map();
  for (const r of [0, ...ids]) rings.set(r, ringPlans(r, chains));
  simplifyChains(chains, [...rings.values()].flat(), simplify);
  // Doorways: open chains between two inside regions, or to the outside. A
  // passage that could not be straightened opens along its longest segment.
  const doors = [];
  for (const c of chains.filter((c) => c.open)) {
    let a = c.simple[0], b = c.simple[1];
    for (let k = 1; k + 1 < c.simple.length; k++) {
      const p = c.simple[k], q = c.simple[k + 1];
      if (Math.hypot(p.x - q.x, p.y - q.y) > Math.hypot(a.x - b.x, a.y - b.y)) { a = p; b = q; }
    }
    const len = Math.hypot(a.x - b.x, a.y - b.y);
    if (len < minDoor) continue;
    const pair = c.pair.filter((r) => r && stats.has(r));
    if (!pair.length) continue;
    const join = pair.length === 2 && origin.get(pair[0]) === origin.get(pair[1]);
    doors.push({ id: join ? `coverage-open-raster-${doors.length + 1}` : `raster-door-${doors.length + 1}`,
      label: join ? "Open circulation join" : len > 90 ? "Open passage" : "Doorway", a, b,
      spaceIds: pair.map(spaceId), confidence: join ? 1 : 0.6 });
  }
  const doorCount = new Map();
  for (const d of doors) for (const s of d.spaceIds) doorCount.set(s, (doorCount.get(s) || 0) + 1);
  // Names from the inventory.
  const named = new Map();
  for (const item of inventory) {
    const x = Math.round(item.position.x), y = Math.round(item.position.y);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const r = rid[y * w + x];
    if (!r) continue;
    const o = origin.get(r), list = named.get(o) || []; list.push(item); named.set(o, list);
  }
  const areas = ids.map((r) => stats.get(r).area).sort((a, b) => a - b), median = areas[Math.floor(areas.length / 2)] || 1;
  const spaces = [];
  let unnamed = 0;
  for (const r of ids) {
    const s = stats.get(r), outline = rings.get(r)[0], polygon = outline && ringPoints(outline.plan, chains, "simple");
    if (!polygon || polygon.length < 3 || Math.abs(ringArea(polygon)) < 50) continue;
    const items = named.get(origin.get(r)) || [], doorsHere = doorCount.get(spaceId(r)) || 0,
      elong = s.area / Math.max(1, (2 * s.peak) ** 2);
    // Printed names win; generic model descriptions ("Unlabelled ...") only
    // name the region, while its shape and openings decide hallway vs room.
    const specific = items.filter((i) => !GENERIC.test(i.label.trim())),
      generic = items.filter((i) => GENERIC.test(i.label.trim())),
      shapeKind = elong >= 3 || (doorsHere >= 3 && elong >= 1.8) ? "corridor"
        : doorsHere >= 3 && s.area >= 1.5 * median ? "lobby" : "room";
    let kind, label;
    if (specific.length) {
      label = distinctLabels(specific.map((i) => i.label)).join(" / ").slice(0, 120);
      const k = specific.map((i) => KIND[i.kind] || "room");
      kind = circulationKind(label) || (k.includes("corridor") && specific.length === 1 ? "corridor" : k.find((x) => x !== "corridor") || "room");
    } else {
      kind = circulationKind(generic.map((i) => i.label).join(" ")) || shapeKind;
      label = generic.length ? generic[0].label.trim().slice(0, 120)
        : kind === "corridor" ? `Hallway ${spaces.filter((x) => x.kind === "corridor").length + 1}`
        : kind === "lobby" ? `Open lobby ${spaces.filter((x) => x.kind === "lobby").length + 1}`
        : `Unlabelled room ${++unnamed}`;
    }
    spaces.push({ id: spaceId(r), label, kind, polygon, confidence: items.length ? 0.85 : 0.6,
      ...(doorsHere ? {} : { access: "unknown" }) });
  }
  const kept = new Set(spaces.map((s) => s.id));
  const finalDoors = doors.filter((d) => d.spaceIds.every((id) => kept.has(id)));
  const wallLines = chains.filter((c) => !c.open && c.simple.length >= 2 && c.pair.some((r) => kept.has(spaceId(r))))
    .map((c, i) => ({ id: `raster-wall-${i + 1}`, points: c.simple }));
  return { spaces, doors: finalDoors, walls: wallLines, width: w, height: h,
    stats: { regions: spaces.length, doors: finalDoors.length, walls: wallLines.length, corridors: spaces.filter((s) => s.kind === "corridor").length,
      lobbies: spaces.filter((s) => s.kind === "lobby").length, named: spaces.filter((s) => s.confidence > 0.8).length } };
}
