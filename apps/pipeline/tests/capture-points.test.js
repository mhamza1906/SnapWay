import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureFixture, CAPTURE_FIXTURE_ID, CAPTURE_FIXTURE_FLOORS, FIXTURE_PIXELS_PER_METRE } from "../server/capture-fixture.js";
import { corridorChains, planCapturePoints, snapToCorridor } from "../shared/building/capture-points.js";
import { distance, inside } from "../shared/map.js";
import sharp from "sharp";
import { rasterRoomsMap } from "../server/pipelines/raster-rooms.js";
import { newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { buildGraph } from "../shared/building/graph.js";

// All tests use the SYNTHETIC TEST FIXTURE (not a real building).
const FX = CAPTURE_FIXTURE_FLOORS.scaled, UNSCALED = CAPTURE_FIXTURE_FLOORS.unscaled, PPM = FIXTURE_PIXELS_PER_METRE;
const b = captureFixture();
const chain = (floorId, part) => corridorChains(b, floorId).find((c) => c.label === `Hallway A, part ${part}`);
// Part 1: west dead end -> T junction. Part 2: T junction -> stem end.
// Part 3: T junction -> east bend -> south dead end.
const bent = chain(FX, 3);
const plan = (floorId, c, direction = "forward", spacingM = 2) => planCapturePoints(b, floorId, c.id, { direction, spacingM });
const along = (path, p) => { // walking distance of p on a polyline
  let best = Infinity, s = 0, acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], z = path[i], d = distance(a, z), t = Math.max(0, Math.min(1, ((p.x - a.x) * (z.x - a.x) + (p.y - a.y) * (z.y - a.y)) / (d * d)));
    const q = { x: a.x + (z.x - a.x) * t, y: a.y + (z.y - a.y) * t };
    if (distance(p, q) < best) { best = distance(p, q); s = acc + t * d; }
    acc += d;
  }
  return { s, off: best };
};
const onPolyline = (path, p) => along(path, p).off;
const hallway = b.floors.find((f) => f.id === FX).geometry.spaces.find((s) => s.kind === "corridor");

test("fixture: three corridor chains with stable IDs and space labels", () => {
  const chains = corridorChains(b, FX);
  assert.deepEqual(chains.map((c) => c.label), ["Hallway A, part 1", "Hallway A, part 2", "Hallway A, part 3"]);
  assert.ok(chains.every((c) => /^corridor-[0-9a-f]{12}$/.test(c.id)));
  const shuffled = { ...b, edges: [...b.edges].reverse() };
  assert.deepEqual(corridorChains(shuffled, FX).map((c) => [c.id, c.label, c.path[0]]), chains.map((c) => [c.id, c.label, c.path[0]]));
  // Every corridor edge belongs to exactly one chain; segments are contiguous.
  const ids = chains.flatMap((c) => c.segments.map((s) => s.edgeId)).sort();
  assert.deepEqual(ids, b.edges.filter((e) => e.floorId === FX && e.traversal === "corridor").map((e) => e.id).sort());
  for (const c of chains) {
    c.segments.forEach((s, i) => i && assert.equal(s.startPx, c.segments[i - 1].endPx));
    assert.equal(c.segments.at(-1).endPx, c.lengthPx);
    assert.equal(c.lengthM, Math.round((c.lengthPx / PPM) * 100) / 100);
  }
});

test("auto mode: 2 m spacing is measured along the bent polyline, not straight-line", () => {
  const p = plan(FX, bent);
  assert.equal(p.mode, "auto");
  assert.equal(p.scaleVerified, true);
  for (const pt of p.points) {
    const { s, off } = along(p.path, pt);
    assert.ok(off < 0.02, `${pt.order} on the path`);
    assert.ok(Math.abs(s - pt.corridorDistancePx) < 0.05, `${pt.order} distance ${s} vs ${pt.corridorDistancePx}`);
    assert.ok(Math.abs(pt.distanceM - pt.corridorDistancePx / PPM) < 0.01);
  }
  const spacing = p.points.filter((x) => x.reason === "spacing");
  assert.ok(spacing.length >= 6);
  for (const x of spacing) assert.ok(Math.abs(x.distanceM / 2 - Math.round(x.distanceM / 2)) < 1e-6, `spacing point at ${x.distanceM} m`);
  // 12 m (before the bend) and 16 m (after it) are 4 m apart along the path
  // but closer in a straight line.
  const at12 = p.points.find((x) => x.distanceM === 12), at16 = p.points.find((x) => x.distanceM === 16);
  assert.ok(at12 && at16);
  assert.equal(at16.corridorDistancePx - at12.corridorDistancePx, 4 * PPM);
  assert.ok(distance(at12, at16) < 4 * PPM - 10);
  // Orders are 1..n in walking order; no two points closer than half the spacing.
  p.points.forEach((x, i) => {
    assert.equal(x.order, i + 1);
    if (i) assert.ok(x.corridorDistancePx - p.points[i - 1].corridorDistancePx >= PPM - 1e-6, `gap before ${x.order}`);
  });
});

test("no duplicate points at shared edge endpoints; every point is on the centreline in walkable space", () => {
  for (const part of [1, 2, 3]) {
    const c = chain(FX, part), p = plan(FX, c);
    const keys = p.points.map((x) => `${x.x},${x.y}`);
    assert.equal(new Set(keys).size, keys.length, `part ${part}`);
    for (let i = 1; i < c.path.length; i++) assert.ok(distance(c.path[i - 1], c.path[i]) > 1e-6);
    for (const x of p.points) {
      assert.ok(inside(x, hallway.polygon), `${x.x},${x.y} in Hallway A`);
      assert.ok(onPolyline(c.path, x) < 0.02);
      const e = b.edges.find((e) => e.id === x.edgeId);
      assert.equal(e.traversal, "corridor");
      assert.ok(onPolyline(e.path, x) < 0.02, "point lies on its edge");
    }
  }
});

test("turn, junction and door points", () => {
  const p = plan(FX, bent), reasons = p.points.map((x) => x.reason);
  assert.equal(reasons[0], "junction", "part 3 starts at the T junction");
  assert.equal(reasons.at(-1), "end", "and ends at a dead end");
  const turn = p.points.filter((x) => x.reason === "turn");
  assert.equal(turn.length, 1);
  assert.deepEqual([turn[0].x, turn[0].y], [579.5, 120.5]);
  assert.equal(turn[0].forwardAngleDeg, 90, "outgoing segment after the bend faces +y");
  const doorPoints = p.points.filter((x) => x.reason === "door");
  assert.ok(doorPoints.length >= 4);
  for (const x of doorPoints) {
    assert.ok(x.nodeId);
    const doorway = b.edges.find((e) => e.traversal === "doorway" && (e.from === x.nodeId || e.to === x.nodeId));
    assert.ok(doorway, `${x.nodeId} has a room doorway`);
    assert.ok(x.nearby.some((n) => n.kind === "door"), "a door is listed nearby");
  }
  const labels = doorPoints.flatMap((x) => x.nearby.map((n) => n.label));
  for (const room of ["Door to Room 103", "Door to Room 104", "Door to Room 105", "Door to Room 106", "Door to Room 107"])
    assert.ok(labels.includes(room), room);
  // Part 2 runs south from the junction past Room 108's door.
  const stem = plan(FX, chain(FX, 2));
  assert.equal(stem.points[0].reason, "junction");
  assert.ok(stem.points.some((x) => x.reason === "door" && x.nearby.some((n) => n.label === "Door to Room 108")));
});

test("reverse direction reverses order and flips angles by 180 (right = forward + 90)", () => {
  const f = plan(FX, bent, "forward"), r = plan(FX, bent, "reverse");
  assert.equal(r.points.length, f.points.length);
  assert.deepEqual(r.points.map((x) => [x.x, x.y]), [...f.points].reverse().map((x) => [x.x, x.y]));
  assert.deepEqual(r.path, [...f.path].reverse());
  assert.equal(r.points[0].reason, "start");
  assert.equal(r.points.at(-1).reason, "junction");
  r.points.forEach((x, i) => {
    assert.equal(x.order, i + 1);
    const fwd = f.points[f.points.length - 1 - i];
    assert.ok(Math.abs(x.corridorDistancePx - (bent.lengthPx - fwd.corridorDistancePx)) < 0.05);
    if (fwd.reason !== "turn") assert.equal(x.forwardAngleDeg, (fwd.forwardAngleDeg + 180) % 360, `point ${x.order}`);
  });
  // Walking east (0°) on the plan, right (forward + 90 = 90°) faces +y (down),
  // the walker's right in the y-down map frame: cross(forward, right) > 0.
  const east = f.points.find((x) => x.forwardAngleDeg === 0), rad = (d) => (d * Math.PI) / 180;
  const fw = { x: Math.cos(rad(east.forwardAngleDeg)), y: Math.sin(rad(east.forwardAngleDeg)) },
    right = { x: Math.cos(rad(east.forwardAngleDeg + 90)), y: Math.sin(rad(east.forwardAngleDeg + 90)) };
  assert.ok(fw.x * right.y - fw.y * right.x > 0.99);
  assert.ok(Math.abs(right.y - 1) < 1e-9);
  // Reverse at the bend: outgoing segment heads west.
  assert.equal(r.points.find((x) => x.reason === "turn").forwardAngleDeg, 180);
  // The last point uses the incoming segment.
  assert.equal(f.points.at(-1).forwardAngleDeg, 90);
  assert.equal(r.points.at(-1).forwardAngleDeg, 180);
});

test("fraction is measured along the stored polyline of a bent edge (from -> to)", () => {
  const edge = b.edges.find((e) => e.floorId === FX && e.traversal === "corridor" && e.path.length >= 3);
  assert.ok(edge, "fixture has a bent edge");
  const stored = edge.path, total = stored.reduce((s, p, i) => (i ? s + distance(stored[i - 1], p) : 0), 0);
  for (const direction of ["forward", "reverse"]) {
    const pts = plan(FX, bent, direction).points.filter((x) => x.edgeId === edge.id);
    assert.ok(pts.some((x) => x.fraction > 0.05 && x.fraction < 0.95));
    for (const x of pts) {
      const expected = along(stored, x).s / total;
      assert.ok(Math.abs(x.fraction - expected) < 1e-4, `${direction} ${x.order}: ${x.fraction} vs ${expected}`);
    }
  }
  // A point after the bend on that edge is past the corner along the path.
  const after = plan(FX, bent).points.find((x) => x.edgeId === edge.id && x.y > 150 && x.x > 570);
  assert.ok(after.fraction > distance(stored[0], stored[1]) / total);
});

test("manual mode on an unscaled floor: start, end, junction and turn only, metre fields null", () => {
  const chains = corridorChains(b, UNSCALED);
  assert.equal(chains.length, 3);
  assert.ok(chains.every((c) => c.lengthM === null));
  for (const c of chains)
    for (const direction of ["forward", "reverse"]) {
      const p = planCapturePoints(b, UNSCALED, c.id, { direction });
      assert.equal(p.mode, "manual");
      assert.equal(p.scaleVerified, false);
      assert.ok(p.points.every((x) => x.distanceM === null));
      assert.ok(p.points.every((x) => ["start", "end", "junction", "turn"].includes(x.reason)), p.points.map((x) => x.reason).join());
    }
  const m = planCapturePoints(b, UNSCALED, chain(UNSCALED, 3).id, { direction: "forward" });
  assert.deepEqual(m.points.map((x) => x.reason), ["junction", "turn", "end"]);
  assert.equal(snapToCorridor(b, UNSCALED, chain(UNSCALED, 3).id, { direction: "forward", x: 590, y: 200 }).distanceM, null);
});

test("snap keeps adjusted points on the corridor centreline", () => {
  const off = snapToCorridor(b, FX, bent.id, { direction: "forward", x: 595, y: 200 });
  assert.equal(off.reason, "adjusted");
  assert.equal(off.planId, null);
  assert.deepEqual([off.x, off.y], [579.5, 200]);
  assert.equal(off.forwardAngleDeg, 90);
  // Far outside the corridor and in a room: still on the centreline.
  for (const [x, y] of [[650, 300], [20, 590], [450, 60], [799, 0], [579.5, 120.5]]) {
    for (const direction of ["forward", "reverse"]) {
      const s = snapToCorridor(b, FX, bent.id, { direction, x, y });
      assert.ok(onPolyline(bent.path, s) < 0.02, `${x},${y}`);
      assert.ok(inside(s, hallway.polygon));
    }
  }
  const byDistance = snapToCorridor(b, FX, bent.id, { direction: "reverse", corridorDistancePx: 10 });
  assert.deepEqual([byDistance.x, byDistance.y], [579.5, 469.5]);
  assert.equal(byDistance.forwardAngleDeg, 270);
  assert.equal(byDistance.distanceM, 0.5);
  const clamped = snapToCorridor(b, FX, bent.id, { direction: "forward", corridorDistancePx: 1e6 });
  assert.equal(clamped.corridorDistancePx, bent.lengthPx);
  assert.throws(() => snapToCorridor(b, FX, "corridor-unknown", { direction: "forward", x: 1, y: 1 }), /Unknown corridor/);
});

// A synthetic plan (black walls on white, not a real building)
// segmented by the local raster pipeline: jagged centrelines with corner
// chamfers, as on any raster-segmented floor.
async function rasterFloor(scaled) {
  const W = 800, H = 500, T = 10, cut = (a, z, gaps) => gaps.reduce((out, [g0, g1]) =>
    out.flatMap(([p, q]) => (g1 <= p || g0 >= q ? [[p, q]] : [[p, g0], [g1, q]].filter(([u, v]) => v > u))), [[a, z]]);
  const h = [[30, 30, 770], [470, 30, 770], [250, 30, 770, [[140, 180], [390, 430], [600, 640]]], [330, 30, 300, [[140, 180]]], [330, 380, 690, [[500, 540]]]],
    v = [[30, 30, 470], [770, 30, 470], [290, 30, 250], [530, 30, 250], [300, 330, 470], [380, 330, 470], [690, 330, 470, [[400, 440]]]],
    rects = [...h.flatMap(([y, x0, x1, g = []]) => cut(x0 - T / 2, x1 + T / 2, g).map(([a, z]) => [a, y - T / 2, z - a, T])),
      ...v.flatMap(([x, y0, y1, g = []]) => cut(y0 - T / 2, y1 + T / 2, g).map(([a, z]) => [x - T / 2, a, T, z - a]))];
  const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="white"/>` +
    rects.map(([x, y, w, hh]) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="black"/>`).join("") + "</svg>")).png().toBuffer();
  const r = await rasterRoomsMap(png), bb = newBuilding(), f = newFloor("raster", "Synthetic raster floor", 1);
  f.width = W; f.height = H; f.geometry.source.width = W; f.geometry.source.height = H;
  Object.assign(f.geometry, { spaces: r.spaces, doors: r.doors, walls: r.walls,
    scale: scaled ? { pixelsPerMetre: 20, a: { x: 0, y: 0 }, b: { x: 20, y: 0 }, knownMetres: 1 } : null });
  f.geometryStatus = "reviewed"; f.geometry.review.status = "reviewed"; bb.floors = [f];
  return buildGraph(parseBuilding(bb), "raster");
}

test("raster-segmented clean-redraw floor: every point on the centreline in walkable space, chamfers do not skew angles", async () => {
  for (const scaled of [true, false]) {
    const rb = await rasterFloor(scaled), chains = corridorChains(rb, "raster"),
      walkable = rb.floors[0].geometry.spaces.filter((s) => s.access !== "nonwalkable");
    assert.ok(chains.length >= 3, `${chains.length} chains`);
    assert.equal(chains.flatMap((c) => c.segments).length, rb.edges.filter((e) => e.traversal === "corridor").length);
    for (const c of chains)
      for (const direction of ["forward", "reverse"]) {
        const p = planCapturePoints(rb, "raster", c.id, { direction });
        assert.equal(p.mode, scaled ? "auto" : "manual");
        assert.equal(new Set(p.points.map((x) => `${x.x},${x.y}`)).size, p.points.length);
        for (const x of p.points) {
          assert.ok(walkable.some((s) => inside(x, s.polygon)), `${c.label} ${x.x},${x.y}`);
          assert.ok(onPolyline(c.path, x) < 0.02);
          assert.ok(x.fraction >= 0 && x.fraction <= 1);
          if (!scaled) assert.equal(x.distanceM, null);
        }
      }
    // The east bend: its turn faces down the vertical hallway (about 90°), not along the 45° chamfer.
    const longest = [...chains].sort((a, z) => z.lengthPx - a.lengthPx)[0],
      turn = planCapturePoints(rb, "raster", longest.id, { direction: "forward" }).points.find((x) => x.reason === "turn" && x.x > 700 && x.y < 300);
    assert.ok(turn, "turn at the east bend");
    assert.ok(Math.abs(turn.forwardAngleDeg - 90) < 5, `${turn.forwardAngleDeg}`);
  }
});

// API (own server on port 5178, run from an empty working directory so the
// building library is empty and only the synthetic fixture is listed).
let server, cwd;
const base = "http://127.0.0.1:5178/api/capture-map";
const here = dirname(fileURLToPath(import.meta.url));
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "capture-map-"));
  server = spawn(process.execPath, [join(here, "..", "server", "index.js")], { cwd,
    env: { ...process.env, APP_ENV: "dev", PORT: "5178", AI_PROVIDER: "openai", OPENAI_MODEL: "gpt-6.1-sol", OPENAI_API_KEY: "capture-test-key" },
    stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Test server startup timed out")), 15000);
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Test server exited ${code}`)); });
    server.stdout.on("data", (d) => { if (d.toString().includes("map-authoring pipeline")) { clearTimeout(timeout); resolve(); } });
  });
});
after(async () => {
  if (server && !server.killed) { const exited = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await exited; }
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("API: buildings, floor, plan, snap and stale-revision 409", async () => {
  const list = await (await fetch(base + "/buildings")).json();
  const fx = list.find((x) => x.id === CAPTURE_FIXTURE_ID);
  assert.ok(fx.name.includes("SYNTHETIC TEST FIXTURE"));
  assert.deepEqual(fx.floors, [
    { id: FX, label: "Fixture floor (20 px/m)", revision: 1, scaleVerified: true },
    { id: UNSCALED, label: "Fixture floor (no scale)", revision: 1, scaleVerified: false },
  ]);

  const floor = await (await fetch(`${base}/buildings/${CAPTURE_FIXTURE_ID}/floors/${FX}`)).json();
  assert.deepEqual(Object.keys(floor).sort(), ["buildingId", "corridors", "floorId", "floorLabel", "height", "landmarks", "nodes", "revision", "scale", "svg", "width"]);
  assert.deepEqual(floor.scale, { verified: true, pixelsPerMetre: PPM });
  assert.ok(floor.svg.startsWith("<svg") && !floor.svg.includes("<image"));
  assert.equal(floor.corridors.length, 3);
  assert.deepEqual(Object.keys(floor.corridors[0]).sort(), ["id", "label", "lengthM", "lengthPx", "nodeIds", "path", "segments"]);
  assert.deepEqual(Object.keys(floor.corridors[0].segments[0]).sort(), ["edgeId", "endPx", "reversed", "startPx"]);
  assert.ok(floor.nodes.some((n) => n.kind === "junction") && floor.nodes.some((n) => n.kind === "door") && floor.nodes.some((n) => n.kind === "end"));
  assert.ok(floor.landmarks.some((l) => l.kind === "room" && l.label === "Room 105"));
  assert.ok(floor.landmarks.some((l) => l.kind === "door" && l.label === "Door to Room 105"));
  assert.equal((await fetch(`${base}/buildings/${CAPTURE_FIXTURE_ID}/floors/nope`)).status, 404);
  assert.equal((await fetch(`${base}/buildings/nope/floors/${FX}`)).status, 404);

  const corridor = floor.corridors.find((c) => c.label === "Hallway A, part 3");
  const body = { buildingId: CAPTURE_FIXTURE_ID, floorId: FX, revision: 1, corridorId: corridor.id, direction: "forward", spacingM: 2 };
  const ok = await post("/plan", body), planned = await ok.json();
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(planned).sort(), ["mode", "path", "points", "revision", "scaleVerified", "spacingM"]);
  assert.deepEqual(Object.keys(planned.points[0]).sort(), ["corridorDistancePx", "distanceM", "edgeId", "forwardAngleDeg", "fraction",
    "nearby", "nodeId", "order", "planId", "reason", "referenceEdgeId", "x", "y"]);
  assert.deepEqual(planned, JSON.parse(JSON.stringify(plan(FX, bent))));

  const stale = await post("/plan", { ...body, revision: 0 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).currentRevision, 1);
  assert.equal((await post("/snap", { ...body, revision: 0, x: 1, y: 1 })).status, 409);
  assert.equal((await post("/plan", { ...body, corridorId: "corridor-unknown" })).status, 400);
  assert.equal((await post("/plan", { ...body, direction: "sideways" })).status, 400);

  const snap = await post("/snap", { ...body, x: 595, y: 200 }), snapped = await snap.json();
  assert.equal(snap.status, 200);
  assert.equal(snapped.reason, "adjusted");
  assert.deepEqual([snapped.x, snapped.y], [579.5, 200]);
  assert.equal((await post("/snap", { ...body, corridorId: "corridor-unknown", x: 1, y: 1 })).status, 400);
  assert.equal((await post("/snap", { ...body })).status, 400, "x/y or corridorDistancePx required");

  const manual = await (await post("/plan", { ...body, floorId: UNSCALED,
    corridorId: (await (await fetch(`${base}/buildings/${CAPTURE_FIXTURE_ID}/floors/${UNSCALED}`)).json()).corridors.find((c) => c.label.endsWith("part 3")).id })).json();
  assert.equal(manual.mode, "manual");
  assert.ok(manual.points.every((x) => x.distanceM === null));
});
