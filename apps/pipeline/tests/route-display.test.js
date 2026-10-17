import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pointSegment, distance } from "../shared/map.js";
import { parseBuilding } from "../shared/building/schema.js";
import { routeBuilding } from "../shared/building/routing.js";
import { pathLength } from "../shared/building/validation.js";
import {
  routeDisplaySegments,
  routePassThroughNodes,
  terminalArrow,
  collinearSimplify,
} from "../shared/building/route-display.js";

const lab = parseBuilding(
  await readFile("public/buildings/routing-fixture.json", "utf8"),
);
const onLine = (p, line) =>
  line.some((q, i) => i && pointSegment(p, line[i - 1], q) < 1e-6);
const stepVertices = (route, floorId) =>
  route.steps.filter((s) => s.floorId === floorId).flatMap((s) => s.path);

test("contiguous same-floor steps become one polyline with one terminal arrow and every bend kept", () => {
  const route = routeBuilding(lab, "lab-f1:a", "lab-f1:c"),
    before = JSON.stringify(route),
    segments = routeDisplaySegments(route, "lab-f1");
  assert.ok(route.steps.length > 1);
  assert.equal(segments.length, 1);
  const [s] = segments;
  assert.ok(s.startsRoute && s.endsRoute);
  // Same geometric line: every graph vertex lies on the display polyline and
  // every display vertex is an original vertex; lengths match.
  for (const p of stepVertices(route, "lab-f1")) assert.ok(onLine(p, s.displayPoints));
  for (const p of s.displayPoints)
    assert.ok(stepVertices(route, "lab-f1").some((q) => distance(p, q) < 1e-9));
  const total = route.steps.reduce((n, x) => n + pathLength(x.path), 0);
  assert.ok(Math.abs(pathLength(s.displayPoints) - total) < 1e-6);
  assert.ok(s.displayPoints.length > 2, "bend retained");
  assert.equal(s.edgeIds.length, route.steps.length);
  assert.equal(segments.map((x) => terminalArrow(x.displayPoints, 8)).filter(Boolean).length, 1);
  assert.equal(JSON.stringify(route), before, "display composition never mutates the route");
});

test("reversed routes render the same line in the opposite direction", () => {
  const f = routeDisplaySegments(routeBuilding(lab, "lab-f1:a", "lab-f1:c"), "lab-f1")[0],
    r = routeDisplaySegments(routeBuilding(lab, "lab-f1:c", "lab-f1:a"), "lab-f1")[0];
  assert.ok(Math.abs(pathLength(f.displayPoints) - pathLength(r.displayPoints)) < 1e-6);
  const arrowF = terminalArrow(f.displayPoints),
    arrowR = terminalArrow(r.displayPoints);
  assert.ok(distance(arrowF, f.displayPoints.at(-1)) < 1e-6);
  assert.ok(distance(arrowR, r.displayPoints.at(-1)) < 1e-6);
  assert.ok(distance(f.displayPoints[0], r.displayPoints.at(-1)) < 1);
});

test("floor transitions split segments and never draw across floors", () => {
  const route = routeBuilding(lab, "lab-f1:a", "lab-f2:c"),
    one = routeDisplaySegments(route, "lab-f1"),
    two = routeDisplaySegments(route, "lab-f2");
  assert.equal(one.length, 1);
  assert.equal(two.length, 1);
  assert.ok(one[0].leavesBy && !one[0].arrivesFrom && one[0].startsRoute);
  assert.ok(two[0].arrivesFrom && two[0].endsRoute);
  for (const s of [...one, ...two])
    assert.ok(s.edgeIds.every((id) => lab.edges.find((e) => e.id === id).floorId));
});

test("leaving and re-entering a floor yields separate segments, each with its own arrow", () => {
  const p = (x, y) => ({ x, y }),
    route = {
      startNode: "n1",
      endNode: "n8",
      steps: [
        { edgeId: "e1", from: "n1", to: "n2", floorId: "f1", path: [p(0, 0), p(10, 0)] },
        { edgeId: "e2", from: "n2", to: "n3", floorId: "f1", path: [p(10, 0), p(10, 10)] },
        { edgeId: "up", from: "n3", to: "n4", floorId: null, path: [p(10, 10), p(5, 5)] },
        { edgeId: "e3", from: "n4", to: "n5", floorId: "f2", path: [p(5, 5), p(20, 5)] },
        { edgeId: "down", from: "n5", to: "n6", floorId: null, path: [p(20, 5), p(30, 30)] },
        { edgeId: "e4", from: "n6", to: "n7", floorId: "f1", path: [p(30, 30), p(40, 30)] },
        { edgeId: "e5", from: "n7", to: "n8", floorId: "f1", path: [p(40, 30), p(50, 30), p(60, 30)] },
      ],
    };
  const f1 = routeDisplaySegments(route, "f1");
  assert.equal(f1.length, 2);
  assert.deepEqual(f1[0].displayPoints, [p(0, 0), p(10, 0), p(10, 10)]);
  assert.deepEqual(f1[1].displayPoints, [p(30, 30), p(60, 30)], "collinear points share one line");
  assert.deepEqual(f1[1].points, [p(30, 30), p(40, 30), p(50, 30), p(60, 30)]);
  assert.ok(f1[0].startsRoute && f1[0].leavesBy && !f1[0].endsRoute);
  assert.ok(f1[1].arrivesFrom && f1[1].endsRoute);
  assert.equal(f1.map((s) => terminalArrow(s.displayPoints)).filter(Boolean).length, 2);
  assert.equal(routeDisplaySegments(route, "f2").length, 1);
  // A gap between same-floor steps is never bridged.
  route.steps[1].path = [p(11, 0), p(11, 10)];
  assert.equal(routeDisplaySegments(route, "f1").length, 3);
});

test("pass-through landings and shared doorways keep meaningful markers only", () => {
  const route = {
    startNode: "a",
    endNode: "a",
    steps: [],
  };
  assert.deepEqual(routeDisplaySegments(route, "f1"), []);
  const through = {
    startNode: "s",
    endNode: "e",
    steps: [
      { edgeId: "w", from: "s", to: "l1", floorId: "f1", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
      { edgeId: "c1", from: "l1", to: "l2", floorId: null, path: [{ x: 1, y: 0 }, { x: 1, y: 0 }] },
      { edgeId: "c2", from: "l2", to: "l3", floorId: null, path: [{ x: 1, y: 0 }, { x: 1, y: 0 }] },
      { edgeId: "w2", from: "l3", to: "e", floorId: "f3", path: [{ x: 1, y: 0 }, { x: 2, y: 0 }] },
    ],
  };
  assert.deepEqual(routePassThroughNodes(through).map((x) => x.nodeId), ["l2"]);
  assert.equal(routeDisplaySegments(through, "f2").length, 0);
});

test("terminal arrow sits back from the destination along the final heading", () => {
  const pts = [{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }];
  assert.deepEqual(terminalArrow(pts, 8), { x: 22, y: 20, angle: 0 });
  const a = terminalArrow(pts, 40);
  assert.equal(a.angle, 90);
  assert.deepEqual(collinearSimplify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }]), [
    { x: 0, y: 0 },
    { x: 9, y: 0 },
  ]);
});
