// Wall and building-footprint detection for clean floor-plan rasters, used
// by raster-rooms.js. Walls are the barriers that rooms are grown between;
// outsideLabels decides which grown areas are outside the building.
import { distanceField } from "../../shared/building/centreline.js";

const runsOf = (mask, idx) => {
  const runs = [];
  let s = -1;
  for (let k = 0; k <= idx.length; k++) {
    const on = k < idx.length && mask[idx[k]];
    if (on && s < 0) s = k;
    else if (!on && s >= 0) { runs.push([s, k - 1]); s = -1; }
  }
  return runs;
};

// One family of parallel scan lines as index arrays: 0 rows, 1 columns,
// 2 diagonals (x - y constant), 3 anti-diagonals (x + y constant).
function* scanLines(w, h, family) {
  if (family === 0) for (let y = 0; y < h; y++) { const a = new Int32Array(w); for (let x = 0; x < w; x++) a[x] = y * w + x; yield a; }
  if (family === 1) for (let x = 0; x < w; x++) { const a = new Int32Array(h); for (let y = 0; y < h; y++) a[y] = y * w + x; yield a; }
  if (family === 2) for (let c = -(h - 1); c < w; c++) {
    const a = []; for (let y = Math.max(0, -c); y < h && y + c < w; y++) a.push(y * w + y + c); yield a;
  }
  if (family === 3) for (let c = 0; c < w + h - 1; c++) {
    const a = []; for (let y = Math.max(0, c - w + 1); y < h && c - y >= 0; y++) a.push(y * w + c - y); yield a;
  }
}
const ACROSS = [1, 0, 3, 2];

// Hollow walls: two thin parallel strokes with a narrow gap. Scans run in
// four directions. A crossing matches where open floor lies on at least one
// outer side (stair treads, seat rows and hatching repeat, so neither side is
// open); it is "clear" where both sides are open. A band counts where it
// continues along the wall with a near-constant gap for at least
// `minLength` px (letter strokes are shorter) and is clear for at least
// `minClear` of that length (furniture along a wall breaks the clear side
// only in places; rows of seats never have it). Returns the filled bands.
export function hollowWalls(mask, w, h, { maxLine = 7, maxGap = 18, minLength = 40, gapTolerance = 3, maxBreak = 6, minClear = 0.3, minMargin = 20, openMargin = 80, probe = 30, minClearance = 15 } = {}) {
  const n = w * h, fill = new Uint8Array(n), gapAt = new Uint8Array(n), CLEAR = 64, THIRD = 128;
  // Clearance: distance to the nearest stroke in any direction, so floor
  // between parallel seat rows does not count as open.
  const notLine = new Uint8Array(n); for (let i = 0; i < n; i++) notLine[i] = mask[i] ? 0 : 1;
  const clearance = distanceField({ w, h, res: 1, mask: notLine });
  for (let family = 0; family < 4; family++) {
    const step = family < 2 ? 1 : Math.SQRT2, reach = Math.round(probe / step);
    gapAt.fill(0);
    for (const idx of scanLines(w, h, family)) {
      const runs = runsOf(mask, idx);
      for (let r = 0; r + 1 < runs.length; r++) {
        const [a0, a1] = runs[r], [b0, b1] = runs[r + 1], gap = b0 - a1 - 1;
        if (a1 - a0 + 1 > maxLine || b1 - b0 + 1 > maxLine || Math.abs(a1 - a0 - b1 + b0) > 2 || gap > maxGap) continue;
        const before = r > 0 ? a0 - runs[r - 1][1] - 1 : Infinity, after = r + 2 < runs.length ? runs[r + 2][0] - b1 - 1 : Infinity,
          margin = Math.max(minMargin, 2 * gap + 4);
        const far = Math.max(before, after), near = Math.min(before, after);
        if (far < margin) continue;
        // Clear: open floor on the far side (by the clearance a little way
        // out), and some floor on the near side.
        const k = before >= after ? a0 - reach : b1 + reach, open = k < 0 || k >= idx.length || clearance[idx[k]] >= minClearance;
        // A third thin line as close on the near side: glazing, a railing or
        // seat rows drawn as three or more lines, not a hollow wall. (An outer
        // wall, with nothing beyond it, may have a line drawn along its inside.)
        const third = far !== Infinity && near <= 2 * gap + 3
          && (before < after ? runs[r - 1][1] - runs[r - 1][0] < maxLine : runs[r + 2][1] - runs[r + 2][0] < maxLine);
        const v = gap + 1 + (far * step >= openMargin && open && near >= Math.max(6, gap) ? CLEAR : 0) + (third ? THIRD : 0);
        for (let k = a0; k <= b1; k++) gapAt[idx[k]] = v;
      }
    }
    // Along the wall: stretches bridging short breaks, with a near-constant
    // gap (converging lines do not count).
    const need = family < 2 ? minLength : minLength / Math.SQRT2;
    for (const idx of scanLines(w, h, ACROSS[family])) {
      let start = -1, last = -1, lo = 0, hi = 0, count = 0, clear = 0, thirds = 0;
      const flush = () => {
        if (start >= 0 && last - start + 1 >= need && clear >= minClear * count && thirds < 0.5 * count) for (let k = start; k <= last; k++) fill[idx[k]] = 1;
      };
      for (let k = 0; k < idx.length; k++) {
        const v = gapAt[idx[k]];
        if (!v) continue;
        const g = v & (CLEAR - 1), c = v & CLEAR ? 1 : 0, t = v & THIRD ? 1 : 0;
        if (start >= 0 && k - last <= maxBreak + 1 && Math.max(hi, g) - Math.min(lo, g) <= gapTolerance) {
          last = k; lo = Math.min(lo, g); hi = Math.max(hi, g); count++; clear += c; thirds += t; continue;
        }
        flush(); start = last = k; lo = hi = g; count = 1; clear = c; thirds = t;
      }
      flush();
    }
  }
  return fill;
}

// Connected wall pieces (4-connected): pixel lists with their size and
// principal extents (length of the equivalent uniform rod along each axis).
function components(mask, w, h) {
  const n = w * h, seen = new Uint8Array(n), out = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i] || seen[i]) continue;
    const px = [i]; seen[i] = 1;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let q = 0; q < px.length; q++) {
      const k = px[q], x = k % w, y = (k - x) / w;
      sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w])
        if (j >= 0 && j < n && mask[j] && !seen[j]) { seen[j] = 1; px.push(j); }
    }
    const m = px.length, mx = sx / m, my = sy / m, a = sxx / m - mx * mx, b = sxy / m - mx * my, c = syy / m - my * my;
    const mid = (a + c) / 2, root = Math.sqrt(Math.max(0, mid * mid - (a * c - b * b))), t = 0.5 * Math.atan2(2 * b, a - c);
    out.push({ px, size: m, mx, my, ux: Math.cos(t), uy: Math.sin(t), major: Math.sqrt(12 * (mid + root)), minor: Math.sqrt(12 * Math.max(0, mid - root)) });
  }
  return out;
}

// Wall pieces kept: the network of large, extended pieces; straight pieces
// broken off it (with both ends at the network, such as a hollow wall
// between pilasters or junctions); and large pieces touching it. Small
// pieces and pieces standing alone (letters of bold room labels, furniture,
// columns) go.
function filterComponents(walls, w, h, { limit, glyph, near = 10, lineRatio = 3 }) {
  const n = w * h, comps = components(walls, w, h), net = new Uint8Array(n).fill(1);
  const isNet = (c) => c.size >= limit && c.major > glyph;
  for (const c of comps) if (isNet(c)) for (const k of c.px) net[k] = 0;
  const toNet = distanceField({ w, h, res: 1, mask: net });
  for (const c of comps) {
    if (isNet(c)) continue;
    // Distance to the network: anywhere, and at each end of the piece.
    const along = (k) => (k % w - c.mx) * c.ux + ((k - k % w) / w - c.my) * c.uy;
    let lo = Infinity, hi = -Infinity, d = Infinity;
    for (const k of c.px) { const p = along(k); if (p < lo) lo = p; if (p > hi) hi = p; if (toNet[k] < d) d = toNet[k]; }
    let dLo = Infinity, dHi = Infinity;
    for (const k of c.px) {
      const p = along(k);
      if (p - lo <= 4 && toNet[k] < dLo) dLo = toNet[k];
      if (hi - p <= 4 && toNet[k] < dHi) dHi = toNet[k];
    }
    const bridging = c.major >= lineRatio * c.minor && dLo <= near && dHi <= near;
    if (!(bridging || (c.size >= limit && d <= near))) for (const k of c.px) walls[k] = 0;
  }
}

// Door openings the closing sealed: a short piece of wall that is not solid
// dark stroke (thin lines merged by the closing: a threshold, or a door leaf
// drawn shut in the wall line) between two solid wall ends it lines up with,
// with a door swing arc (thin ink, not wall) of the opening's radius centred
// on one end. Such pieces are cleared from `walls`. Returns how many.
export function sealedDoors(gray, walls, w, h, { threshold = 110, minWallHalf = 2.5, minDoor = 16, maxDoor = Math.max(40, 0.025 * Math.max(w, h)), minArc = 0.7, ink = 170 } = {}) {
  const n = w * h, dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) dark[i] = gray[i] < threshold ? 1 : 0;
  const inside = distanceField({ w, h, res: 1, mask: dark }), core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = inside[i] >= minWallHalf ? 0 : 1;
  const reach = distanceField({ w, h, res: 1, mask: core }), solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = dark[i] && reach[i] <= minWallHalf + 0.5 ? 1 : 0;
  const wallAt = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < w && y < h && walls[y * w + x] === 1; };
  const inkAt = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h && !walls[Y * w + X] && gray[Y * w + X] < ink) return true;
    }
    return false;
  };
  // Share of a quarter circle (20°–80° from the wall line) drawn in ink.
  const arc = (H, O, side, r) => {
    const phi = Math.atan2(O.y - H.y, O.x - H.x), steps = Math.max(12, Math.round(r));
    let hit = 0;
    for (let k = 0; k <= steps; k++) {
      const a = phi + side * (20 + 60 * k / steps) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      // A thin curve: ink on the circle, not on both circles 4 px either side.
      if (inkAt(H.x + r * c, H.y + r * s) && !(inkAt(H.x + (r - 4) * c, H.y + (r - 4) * s) && inkAt(H.x + (r + 4) * c, H.y + (r + 4) * s))) hit++;
    }
    // The swing area inside the arc is clear floor (stair treads, hatching
    // and text crossing a circle by chance fill it).
    let busy = 0, all = 0;
    for (let f = 0.3; f <= 0.75; f += 0.15) for (let k = 0; k <= 8; k++) {
      const a = phi + side * (25 + 50 * k / 8) * Math.PI / 180;
      all++; if (inkAt(H.x + f * r * Math.cos(a), H.y + f * r * Math.sin(a))) busy++;
    }
    return busy > 0.2 * all ? 0 : hit / (steps + 1);
  };
  const seen = new Uint8Array(n), clear = [];
  for (let i = 0; i < n; i++) {
    if (walls[i] !== 1 || solid[i] || seen[i]) continue;
    const px = [i], touch = [];
    seen[i] = 1;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let q = 0; q < px.length; q++) {
      const k = px[q], x = k % w, y = (k - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) {
        if (j < 0 || j >= n || !walls[j]) continue;
        if (solid[j]) touch.push(k);
        else if (!seen[j]) { seen[j] = 1; px.push(j); }
      }
    }
    if (px.length < minDoor || Math.hypot(x1 - x0, y1 - y0) > maxDoor + 12 || touch.length < 2) continue;
    // The two jambs: contact with solid wall falls into two clusters at
    // opposite ends of the piece.
    const t0 = touch[0];
    let far = t0, fd = 0;
    for (const k of touch) { const d = (k % w - t0 % w) ** 2 + ((k - k % w) / w - (t0 - t0 % w) / w) ** 2; if (d > fd) { fd = d; far = k; } }
    let far2 = far; fd = 0;
    for (const k of touch) { const d = (k % w - far % w) ** 2 + ((k - k % w) / w - (far - far % w) / w) ** 2; if (d > fd) { fd = d; far2 = k; } }
    const A = { x: 0, y: 0, n: 0 }, B = { x: 0, y: 0, n: 0 };
    for (const k of touch) {
      const x = k % w, y = (k - x) / w, da = (x - far % w) ** 2 + (y - (far - far % w) / w) ** 2, db = (x - far2 % w) ** 2 + (y - (far2 - far2 % w) / w) ** 2;
      const P = da <= db ? A : B; P.x += x; P.y += y; P.n++;
    }
    A.x /= A.n; A.y /= A.n; B.x /= B.n; B.y /= B.n;
    const gap = Math.hypot(B.x - A.x, B.y - A.y);
    if (gap < minDoor - 6 || gap > maxDoor) continue;
    const ux = (B.x - A.x) / gap, uy = (B.y - A.y) / gap;
    // It meets solid wall only at its ends (a stroke running alongside a
    // wall, such as a door leaf against a partition, touches it all along).
    let ends = 0;
    for (const k of touch) { const p = (k % w - A.x) * ux + ((k - k % w) / w - A.y) * uy; if (p <= 4 || p >= gap - 4) ends++; }
    if (ends < 0.8 * touch.length) continue;
    // The wall runs on in line beyond both ends (a stroke meeting a wall
    // end-on, such as a door leaf at a partition, has floor past the wall).
    const beyond = (P, s) => {
      let count = 0;
      for (let d = 3; d <= 22; d++) for (let j = -3; j <= 3; j++) if (wallAt(P.x + s * ux * d - uy * j, P.y + s * uy * d + ux * j)) { count++; break; }
      return count >= 16;
    };
    if (!beyond(A, -1) || !beyond(B, 1)) continue;
    // Jamb faces: the solid reaches about 3 px into the merged lines.
    const HA = { x: A.x - 3 * ux, y: A.y - 3 * uy }, HB = { x: B.x + 3 * ux, y: B.y + 3 * uy }, r0 = gap + 6;
    if (r0 < minDoor) continue;
    let best = 0;
    for (const [H, O] of [[HA, HB], [HB, HA]]) for (const side of [1, -1]) for (const f of [0.9, 1, 1.1])
      best = Math.max(best, arc(H, O, side, f * r0));
    if (best < minArc) continue;
    // Clear the piece along the opening (not side branches at the jambs).
    for (const k of px) {
      const x = k % w - A.x, y = (k - k % w) / w - A.y, p = x * ux + y * uy;
      if (p >= -1 && p <= gap + 1 && Math.abs(-x * uy + y * ux) <= 6) clear.push(k);
    }
  }
  for (const k of clear) walls[k] = 0;
  return clear.length;
}

export function wallMask(gray, w, h, { threshold = 110, lineThreshold = 160, closeGap = 2.5, minWallHalf = 2.5, minComponent = 0.0005, hollow = true, doors = true } = {}) {
  const n = w * h, dark = new Uint8Array(n), notDark = new Uint8Array(n);
  for (let i = 0; i < n; i++) { dark[i] = gray[i] < threshold ? 1 : 0; notDark[i] = 1 - dark[i]; }
  // Closing: dilate by r, then erode by r.
  const toDark = distanceField({ w, h, res: 1, mask: notDark }), dilated = new Uint8Array(n);
  for (let i = 0; i < n; i++) dilated[i] = toDark[i] <= closeGap ? 1 : 0;
  const inDil = distanceField({ w, h, res: 1, mask: dilated }), closed = new Uint8Array(n);
  for (let i = 0; i < n; i++) closed[i] = inDil[i] > closeGap ? 1 : 0;
  for (let i = 0; i < n; i++) if (dark[i]) closed[i] = 1;
  // Hollow walls drawn as two thin lines too far apart to close are filled.
  let fill = null;
  if (hollow) {
    const lines = new Uint8Array(n);
    for (let i = 0; i < n; i++) lines[i] = gray[i] < lineThreshold ? 1 : 0;
    fill = hollowWalls(lines, w, h);
    for (let i = 0; i < n; i++) if (fill[i]) closed[i] = 1;
  }
  // Opening: keep strokes whose core is at least minWallHalf from their edge.
  const inside = distanceField({ w, h, res: 1, mask: closed }), core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = inside[i] >= minWallHalf ? 0 : 1; // 0 = core seed
  const reach = distanceField({ w, h, res: 1, mask: core }), walls = new Uint8Array(n);
  for (let i = 0; i < n; i++) walls[i] = closed[i] && reach[i] <= minWallHalf + 0.5 || fill?.[i] ? 1 : 0;
  filterComponents(walls, w, h, { limit: Math.max(150, minComponent * n), glyph: Math.max(64, 0.03 * Math.max(w, h)) });
  if (fill) {
    // Thin strokes continuing a kept hollow wall bridge its short breaks
    // (pilasters, junctions, door jambs).
    const away = new Uint8Array(n); for (let i = 0; i < n; i++) away[i] = fill[i] && walls[i] ? 0 : 1;
    const toFill = distanceField({ w, h, res: 1, mask: away });
    for (let i = 0; i < n; i++) if (closed[i] && toFill[i] <= 10) walls[i] = 1;
  }
  if (doors) sealedDoors(gray, walls, w, h, { threshold, minWallHalf });
  return walls;
}

// Building footprint: everything a disk of `radius` px rolling in from beyond
// the image border cannot reach between the walls. Exterior doors and short
// breaks in the outer wall are narrower than the disk, so they stay closed.
export function buildingFootprint(walls, w, h, { radius = Math.max(30, 0.025 * Math.max(w, h)) } = {}) {
  const P = Math.ceil(radius) + 2, W = w + 2 * P, H = h + 2 * P, N = W * H;
  const free = new Uint8Array(N).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (walls[y * w + x]) free[(y + P) * W + x + P] = 0;
  const clear = distanceField({ w: W, h: H, res: 1, mask: free });
  // Disk centres reachable from the padded border.
  const centre = new Uint8Array(N), queue = [];
  for (let x = 0; x < W; x++) for (const i of [x, (H - 1) * W + x]) if (clear[i] > radius && !centre[i]) { centre[i] = 1; queue.push(i); }
  for (let y = 0; y < H; y++) for (const i of [y * W, y * W + W - 1]) if (clear[i] > radius && !centre[i]) { centre[i] = 1; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], x = i % W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W])
      if (j >= 0 && j < N && !centre[j] && clear[j] > radius) { centre[j] = 1; queue.push(j); }
  }
  for (let i = 0; i < N; i++) centre[i] = centre[i] ? 0 : 1;
  const toCentre = distanceField({ w: W, h: H, res: 1, mask: centre }), inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) inside[y * w + x] = toCentre[(y + P) * W + x + P] > radius ? 1 : 0;
  return inside;
}

/**
 * Grown areas outside the building, as a Set of labels of `seg` (the result
 * of segmentSpaces). A label is outside where it lies beyond the building
 * footprint. A label that runs from outside into the building (through an
 * entrance or a break in the outer wall) is split at the footprint edge:
 * its outside part gets a new label (in seg.labels, which is updated in
 * place) and inside pieces stay only when they meet the outside through a
 * doorway-like constriction (narrower than `ratio` of their widest point).
 */
export function outsideLabels(seg, walls, w, h, { radius, ratio = 0.72, minPeak = 4 } = {}) {
  const n = w * h, labels = seg.labels, inside = buildingFootprint(walls, w, h, radius ? { radius } : {});
  const inA = new Map(), outA = new Map();
  for (let i = 0; i < n; i++) {
    const l = labels[i]; if (!l) continue;
    const m = inside[i] ? inA : outA; m.set(l, (m.get(l) || 0) + 1);
  }
  const outside = new Set();
  for (const l of outA.keys()) if (!inA.has(l)) outside.add(l);
  const mixed = [...outA.keys()].filter((l) => inA.has(l));
  if (!mixed.length) return outside;
  let next = 0; for (let i = 0; i < n; i++) if (labels[i] > next) next = labels[i];
  const moveTo = new Map();
  for (const l of mixed) { moveTo.set(l, ++next); outside.add(next); }
  // Inside pieces of mixed labels: keep those behind a constriction.
  const seen = new Uint8Array(n), drop = [];
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (seen[i] || !inside[i] || !moveTo.has(l)) continue;
    const comp = [i]; seen[i] = 1;
    let peak = 0, cut = 0;
    for (let q = 0; q < comp.length; q++) {
      const k = comp[q], x = k % w;
      if (seg.dist[k] > peak) peak = seg.dist[k];
      let edge = false;
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) {
        if (j < 0 || j >= n || labels[j] !== l) continue;
        if (!inside[j]) edge = true;
        else if (!seen[j]) { seen[j] = 1; comp.push(j); }
      }
      if (edge) cut++;
    }
    // A loop, not push(...comp): a large piece overflows the argument stack.
    if (peak < minPeak || cut >= 2 * ratio * peak) for (const k of comp) drop.push(k);
  }
  for (const k of drop) labels[k] = moveTo.get(labels[k]);
  for (let i = 0; i < n; i++) if (!inside[i] && moveTo.has(labels[i])) labels[i] = moveTo.get(labels[i]);
  seg.count = next;
  return outside;
}
