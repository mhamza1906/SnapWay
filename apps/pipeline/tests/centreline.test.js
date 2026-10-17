import test from "node:test";
import assert from "node:assert/strict";
import { newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { buildGraph } from "../shared/building/graph.js";
import { traceBoundaryWalls } from "../shared/building/coverage.js";
import { routeBuilding } from "../shared/building/routing.js";
import { edgeIssue } from "../shared/building/validation.js";
import { centrelineNetwork } from "../shared/building/centreline.js";
import { wallClearance } from "../shared/building/nav-network.js";
import { inside, pointSegment } from "../shared/map.js";

// Synthetic layouts (not real buildings) for the corridor-centreline network.
const rect = (x, y, r, b) => [{ x, y }, { x: r, y }, { x: r, y: b }, { x, y: b }];
const space = (id, kind, polygon) => ({ id, label: id, kind, polygon, confidence: 1 });
const door = (id, a, b, spaceIds) => ({ id, label: id, a, b, spaceIds, confidence: 1 });
function building(spaces, doors, { scale = null } = {}) {
  const b = newBuilding(), f = newFloor("t", "Test floor", 1);
  f.width = 700; f.height = 500;
  f.geometry.spaces = spaces;
  f.geometry.doors = doors;
  f.geometry.walls = traceBoundaryWalls(f.geometry);
  if (scale) f.geometry.scale = { pixelsPerMetre: scale, a: { x: 0, y: 0 }, b: { x: scale, y: 0 }, knownMetres: 1 };
  f.geometryStatus = "reviewed";
  f.reviewer = "Test";
  f.geometry.review.status = "reviewed";
  b.floors = [f];
  return buildGraph(parseBuilding(b), "t");
}
const floorOf = (b) => b.floors[0];
const routeNodes = (b, r) => [r.steps[0].from, ...r.steps.map((s) => s.to)].map((id) => b.nodes.find((n) => n.id === id));
const routePoints = (r) => r.steps.flatMap((s) => s.path);
function assertClean(b, r, label) {
  assert.ok(r, `${label}: route exists`);
  for (const s of r.steps) assert.equal(edgeIssue(b, b.edges.find((e) => e.id === s.edgeId)), null, `${label}: ${s.edgeId}`);
  const walkable = floorOf(b).geometry.spaces.filter((s) => s.access !== "nonwalkable");
  for (const p of routePoints(r)) assert.ok(walkable.some((s) => inside(p, s.polygon)), `${label}: ${p.x},${p.y} leaves walkable space`);
}
const doorsOn = (b, r) => routeNodes(b, r).filter((n) => n.doorId).map((n) => n.doorId);

test("centreline primitives: a straight corridor gives one centred spine; a wide hall one spine without corner spurs", () => {
  const corridor = centrelineNetwork([rect(0, 0, 400, 40)]);
  assert.equal(corridor.edges.length, 1);
  assert.ok(corridor.edges[0].path.every((p) => Math.abs(p.y - 20) < 1.5));
  const hall = centrelineNetwork([rect(0, 0, 300, 200)]);
  assert.equal(hall.edges.length, 1, "corner spurs are pruned");
  assert.ok(hall.edges[0].path.every((p) => Math.abs(p.y - 100) < 1.5));
});

test("narrow corridor opening into a wide hall: centred spine, one hall spine, routes through the right openings both ways", () => {
  const b = building([
    space("N", "corridor", rect(0, 90, 200, 110)),
    space("H", "lobby", rect(200, 0, 500, 200)),
    space("R1", "room", rect(40, 40, 100, 90)),
    space("R2", "room", rect(500, 80, 560, 120)),
  ], [
    door("dN", { x: 200, y: 90 }, { x: 200, y: 110 }, ["N", "H"]),
    door("d1", { x: 60, y: 90 }, { x: 70, y: 90 }, ["R1", "N"]),
    door("d2", { x: 500, y: 95 }, { x: 500, y: 105 }, ["R2", "H"]),
  ]);
  for (const [a, z] of [["R1", "R2"], ["R2", "R1"]]) {
    const r = routeBuilding(b, a, z);
    assertClean(b, r, `${a}->${z}`);
    assert.deepEqual(doorsOn(b, r).filter((d) => d !== "dN"), a === "R1" ? ["d1", "d2"] : ["d2", "d1"]);
    // In the narrow corridor the route follows its centre line (y = 100).
    for (const p of routePoints(r).filter((p) => p.x > 75 && p.x < 190)) assert.ok(Math.abs(p.y - 100) < 1.5, `${p.x},${p.y}`);
  }
  const hallNodes = b.nodes.filter((n) => n.spaceIds.includes("H") && !n.doorId);
  assert.ok(hallNodes.length <= 3, `hall has a single spine, got ${hallNodes.length} vertices`);
});

test("L-shaped turn: the bend stays inside one polyline edge and keeps clearance around the corner", () => {
  const L = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 130 }, { x: 130, y: 130 }, { x: 130, y: 400 }, { x: 100, y: 400 }];
  const b = building([
    space("C", "corridor", L),
    space("A", "room", rect(340, 40, 400, 100)),
    space("B", "room", rect(40, 340, 100, 400)),
  ], [
    door("dA", { x: 360, y: 100 }, { x: 370, y: 100 }, ["A", "C"]),
    door("dB", { x: 100, y: 360 }, { x: 100, y: 370 }, ["B", "C"]),
  ]);
  for (const [a, z] of [["A", "B"], ["B", "A"]]) {
    const r = routeBuilding(b, a, z);
    assertClean(b, r, `${a}->${z}`);
    assert.deepEqual(doorsOn(b, r), a === "A" ? ["dA", "dB"] : ["dB", "dA"]);
    const f = floorOf(b);
    for (const p of routePoints(r).filter((p) => !f.geometry.doors.some((d) => pointSegment(p, d.a, d.b) < 1)))
      assert.ok(wallClearance(f, p) >= 10, `route keeps clear of walls at ${p.x},${p.y}`);
  }
  // No navigation vertex at the corner: only the two doorway joints.
  const corner = b.nodes.filter((n) => n.spaceIds.includes("C") && !n.doorId && n.position.x < 140 && n.position.y < 140);
  assert.equal(corner.length, 0);
});

test("T-junction: exactly one junction vertex joins three arms; every pair routes both ways", () => {
  const T = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 130 }, { x: 265, y: 130 }, { x: 265, y: 330 }, { x: 235, y: 330 }, { x: 235, y: 130 }, { x: 100, y: 130 }];
  const b = building([
    space("C", "corridor", T),
    space("W", "room", rect(40, 100, 100, 130)),
    space("E", "room", rect(400, 100, 460, 130)),
    space("S", "room", rect(220, 330, 280, 390)),
  ], [
    door("dW", { x: 100, y: 110 }, { x: 100, y: 120 }, ["W", "C"]),
    door("dE", { x: 400, y: 110 }, { x: 400, y: 120 }, ["E", "C"]),
    door("dS", { x: 245, y: 330 }, { x: 255, y: 330 }, ["S", "C"]),
  ]);
  const degree = (id) => b.edges.filter((e) => e.from === id || e.to === id).length;
  const junctions = b.nodes.filter((n) => n.spaceIds.includes("C") && !n.doorId && degree(n.id) >= 3);
  assert.equal(junctions.length, 1);
  assert.ok(Math.abs(junctions[0].position.x - 250) < 2 && Math.abs(junctions[0].position.y - 115) < 2, JSON.stringify(junctions[0].position));
  for (const [a, z] of [["W", "E"], ["W", "S"], ["E", "S"]])
    for (const [p, q] of [[a, z], [z, a]]) {
      const r = routeBuilding(b, p, q);
      assertClean(b, r, `${p}->${q}`);
      assert.deepEqual(doorsOn(b, r), [`d${p}`, `d${q}`]);
    }
});

test("a room with two doors is crossed through both openings, in order, in both directions", () => {
  const b = building([
    space("N", "corridor", rect(0, 100, 400, 130)),
    space("S", "corridor", rect(0, 230, 400, 260)),
    space("M", "room", rect(150, 130, 250, 230)),
    space("A", "room", rect(20, 40, 80, 100)),
    space("B", "room", rect(320, 260, 380, 320)),
  ], [
    door("dMN", { x: 195, y: 130 }, { x: 205, y: 130 }, ["M", "N"]),
    door("dMS", { x: 195, y: 230 }, { x: 205, y: 230 }, ["M", "S"]),
    door("dA", { x: 45, y: 100 }, { x: 55, y: 100 }, ["A", "N"]),
    door("dB", { x: 345, y: 260 }, { x: 355, y: 260 }, ["B", "S"]),
  ]);
  const ab = routeBuilding(b, "A", "B"), ba = routeBuilding(b, "B", "A");
  assertClean(b, ab, "A->B");
  assertClean(b, ba, "B->A");
  assert.deepEqual(doorsOn(b, ab), ["dA", "dMN", "dMS", "dB"]);
  assert.deepEqual(doorsOn(b, ba), ["dB", "dMS", "dMN", "dA"]);
  // Doorway vertices are at the centre of each opening, never on a solid wall.
  for (const n of b.nodes.filter((n) => n.doorId)) {
    const d = floorOf(b).geometry.doors.find((d) => d.id === n.doorId);
    assert.ok(Math.hypot(n.position.x - (d.a.x + d.b.x) / 2, n.position.y - (d.a.y + d.b.y) / 2) < 0.5);
  }
});

test("clearance: every edge stores its narrowest width; below 0.9 m is flagged when the floor has a scale", () => {
  const spaces = [space("N", "corridor", rect(0, 90, 300, 110)), space("A", "room", rect(20, 30, 80, 90)), space("B", "room", rect(220, 30, 280, 90))],
    doors = [door("dA", { x: 45, y: 90 }, { x: 55, y: 90 }, ["A", "N"]), door("dB", { x: 245, y: 90 }, { x: 255, y: 90 }, ["B", "N"])];
  const wide = building(spaces, doors, { scale: 20 }), narrow = building(spaces, doors, { scale: 40 });
  const spine = (b) => b.edges.find((e) => e.id.includes(":spine:"));
  assert.ok(spine(wide).clearance.widthPx >= 19 && spine(wide).clearance.widthM >= 0.95);
  assert.equal(spine(wide).clearance.issue, null);
  assert.ok(spine(narrow).clearance.widthM < 0.9);
  assert.match(spine(narrow).clearance.issue, /below 0\.9 m/);
  assert.ok(wide.edges.filter((e) => e.floorId).every((e) => e.clearance && e.clearance.widthPx !== null));
});

test("developer overrides survive rebuilds: move a junction, reconnect a doorway, reshape a spine", () => {
  let b = building([
    space("C", "corridor", rect(0, 100, 400, 140)),
    space("A", "room", rect(20, 40, 80, 100)),
    space("B", "room", rect(300, 40, 360, 100)),
  ], [
    door("dA", { x: 45, y: 100 }, { x: 55, y: 100 }, ["A", "C"]),
    door("dB", { x: 325, y: 100 }, { x: 335, y: 100 }, ["B", "C"]),
  ]);
  const joint = b.nodes.find((n) => b.edges.some((e) => e.from === "dB:nav" && e.to === n.id));
  const f = b.floors[0];
  f.navOverrides = [
    { op: "move-node", at: joint.position, to: { x: joint.position.x + 20, y: 120 } },
    { op: "door-link", doorId: "dA", to: { x: 100, y: 120 } },
  ];
  b = buildGraph(b, "t");
  assert.ok(b.floors[0].navOverrides.every((o) => o.applied), JSON.stringify(b.floors[0].navOverrides));
  const moved = b.nodes.find((n) => Math.abs(n.position.x - (joint.position.x + 20)) < 0.5 && Math.abs(n.position.y - 120) < 0.5);
  assert.ok(moved, "junction moved");
  const aEdge = b.edges.find((e) => e.from === "dA:nav" || e.to === "dA:nav");
  assert.ok(aEdge.path.some((p) => Math.abs(p.x - 100) < 1 && Math.abs(p.y - 120) < 1), JSON.stringify(aEdge.path));
  const r = routeBuilding(b, "A", "B");
  assertClean(b, r, "A->B after overrides");
  // An override that would leave walkable space is reported, not applied.
  b.floors[0].navOverrides.push({ op: "move-node", at: { x: 100, y: 120 }, to: { x: 100, y: 60 } });
  b = buildGraph(b, "t");
  assert.equal(b.floors[0].navOverrides.at(-1).applied, false);
});

test("doorways never attach to an edgeless centreline vertex", async () => {
  const { nearestOnNetwork, pruneNetwork } = await import("../shared/building/centreline.js");
  const net = {
    nodes: [{ id: 0, p: { x: 0, y: 0 } }, { id: 1, p: { x: 100, y: 0 } }, { id: 2, p: { x: 50, y: 0.5 } }],
    edges: [{ a: 0, b: 1, path: [{ x: 0, y: 0 }, { x: 100, y: 0 }], length: 100, minHalf: 10 }],
    clearance: () => 10,
  };
  const hit = nearestOnNetwork(net, { x: 50, y: 5 });
  assert.ok(hit.edge && !hit.node, "snaps to the edge, not the orphan vertex");
  assert.deepEqual(pruneNetwork(net).nodes.map((n) => n.id).sort(), [0, 1]);
});

test("a spine through a thin corridor piece keeps every segment on a linked opening", () => {
  const b = building([
    space("A", "room", rect(0, 0, 100, 100)),
    space("C1", "corridor", rect(100, 0, 300, 40)),
    space("C2", "corridor", rect(300, 0, 316, 40)),
    space("C3", "corridor", rect(316, 0, 500, 40)),
    space("B", "room", rect(500, 0, 600, 100)),
  ], [
    door("dA", { x: 100, y: 10 }, { x: 100, y: 30 }, ["A", "C1"]),
    door("j1", { x: 300, y: 0 }, { x: 300, y: 40 }, ["C1", "C2"]),
    door("j2", { x: 316, y: 0 }, { x: 316, y: 40 }, ["C2", "C3"]),
    door("dB", { x: 500, y: 10 }, { x: 500, y: 30 }, ["C3", "B"]),
  ]);
  const bad = b.edges.filter((e) => edgeIssue(b, e, { requireReviewed: false }));
  assert.deepEqual(bad.map((e) => [e.id, edgeIssue(b, e, { requireReviewed: false })]), []);
  assert.ok(routeBuilding(b, "A", "B") && routeBuilding(b, "B", "A"));
  const junctions = b.nodes.filter((n) => n.id.includes(":nav:"));
  assert.ok(junctions.every((n) => !inside(n.position, rect(300, 0, 316, 40)) || n.doorId), "no graph vertex added for the thin piece");
});

test("skeleton tracing keeps every chain, including diagonal staircases", async () => {
  const cl = await import("../shared/building/centreline.js");
  const rot = (pts, a) => pts.map((p) => ({ x: 300 + (p.x - 300) * Math.cos(a) - (p.y - 200) * Math.sin(a), y: 200 + (p.x - 300) * Math.sin(a) + (p.y - 200) * Math.cos(a) }));
  for (const angle of [0.3, 0.7, 1.1]) {
    const polys = [rot(rect(0, 180, 600, 220), angle), rot(rect(280, 0, 320, 400), angle), rot(rect(80, 100, 200, 300), angle)];
    const R = cl.walkableRaster(polys, []), D = cl.distanceField(R), K = cl.skeletonize(R), G = cl.skeletonGraph(R, K, D);
    let px = 0;
    for (let i = 0; i < K.length; i++) if (K[i]) px++;
    const traced = new Set(G.edges.flatMap((e) => e.path.map((p) => `${Math.floor((p.x - R.x0) / R.res)},${Math.floor((p.y - R.y0) / R.res)}`)));
    assert.ok(traced.size >= px * 0.75, `angle ${angle}: traced ${traced.size} of ${px} skeleton pixels`);
    const net = cl.centrelineNetwork(polys, []), seen = new Set([net.edges[0].a]);
    for (let grew = true; grew;) { grew = false; for (const e of net.edges) if (seen.has(e.a) !== seen.has(e.b)) { seen.add(e.a); seen.add(e.b); grew = true; } }
    assert.ok(net.edges.every((e) => seen.has(e.a)), `angle ${angle}: centreline is one connected network`);
  }
});

test("room paths cross doorways head-on instead of grazing the wall", () => {
  // Doors near opposite corners of a deep room: a straight door-to-door line
  // would leave each opening at a shallow angle along the wall.
  const b = building([
    space("C", "corridor", rect(0, 0, 400, 40)),
    space("R", "room", rect(0, 40, 400, 240)),
    space("D", "corridor", rect(0, 240, 400, 280)),
  ], [
    door("top", { x: 20, y: 40 }, { x: 44, y: 40 }, ["C", "R"]),
    door("bottom", { x: 356, y: 240 }, { x: 380, y: 240 }, ["R", "D"]),
  ]);
  const e = b.edges.find((e) => e.id.startsWith("R:door-link"));
  assert.ok(e, "door-to-door edge exists");
  const [p, q] = e.path, [y, z] = e.path.slice(-2);
  assert.ok(Math.abs(q.x - p.x) < 0.5 && q.y > p.y, "leaves the top door straight in");
  assert.ok(Math.abs(z.x - y.x) < 0.5 && y.y < z.y, "enters the bottom door straight on");
  assert.ok(!e.clearance?.issue, e.clearance?.issue);
});
