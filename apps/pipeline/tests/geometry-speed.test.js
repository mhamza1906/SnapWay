import test from "node:test";
import assert from "node:assert/strict";
import { pointSegment, edgeProblem, edgeContext } from "../shared/map.js";
import { nearestSegmentDistance } from "../shared/building/nav-network.js";

// Deterministic pseudo-random numbers so a failure is reproducible.
function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("grid nearest-segment search equals the brute-force minimum", () => {
  const r = random(7);
  for (const count of [0, 5, 40, 400]) {
    const segs = Array.from({ length: count }, () => {
      const a = { x: r() * 2000, y: r() * 1200 },
        long = r() < 0.1;
      return { a, b: { x: a.x + (r() - 0.5) * (long ? 1500 : 60), y: a.y + (r() - 0.5) * (long ? 900 : 60) } };
    });
    const grid = nearestSegmentDistance(segs);
    for (let k = 0; k < 500; k++) {
      // Points inside, on and well outside the segments' extent.
      const p = k % 50 === 0 ? { x: -800 + r() * 3600, y: -800 + r() * 2800 }
        : k % 7 === 0 && count ? { ...segs[k % count].a }
        : { x: r() * 2000, y: r() * 1200 };
      let brute = Infinity;
      for (const s of segs) brute = Math.min(brute, pointSegment(p, s.a, s.b));
      assert.equal(grid(p), brute, `${count} segments at ${JSON.stringify(p)}`);
    }
  }
});

test("a shared edge context gives the same answers as a fresh one per edge", () => {
  // Two rooms and a corridor; edges cross walls, doors and open floor.
  const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const map = {
    spaces: [{ id: "a", polygon: sq(0, 0, 100, 100) }, { id: "b", polygon: sq(100, 0, 100, 100) }, { id: "c", polygon: sq(0, 100, 200, 40) }],
    doors: [{ id: "d1", spaceIds: ["a", "c"], a: { x: 40, y: 100 }, b: { x: 60, y: 100 } },
      { id: "d2", spaceIds: ["b", "c"], a: { x: 140, y: 100 }, b: { x: 160, y: 100 } }],
    walls: [{ id: "w", points: [{ x: 100, y: 0 }, { x: 100, y: 100 }] }, { id: "w2", points: [{ x: 0, y: 100 }, { x: 40, y: 100 }] }],
    graph: { nodes: [
      { id: "na", position: { x: 50, y: 50 }, spaceIds: ["a"] }, { id: "nb", position: { x: 150, y: 50 }, spaceIds: ["b"] },
      { id: "nc", position: { x: 100, y: 120 }, spaceIds: ["c"] }, { id: "nd1", position: { x: 50, y: 100 }, spaceIds: ["a", "c"], doorId: "d1" },
      { id: "far", position: { x: 500, y: 500 }, spaceIds: ["a"] }], edges: [] },
  };
  const context = edgeContext(map), ids = map.graph.nodes.map((n) => n.id);
  let problems = 0;
  for (const from of ids)
    for (const to of ids) {
      const e = { id: `${from}-${to}`, from, to };
      assert.equal(edgeProblem(map, e, context), edgeProblem(map, e), e.id);
      if (edgeProblem(map, e)) problems++;
    }
  assert.ok(problems > 5, "the fixture exercises failing edges too");
  assert.equal(edgeProblem(map, { id: "ok", from: "na", to: "nd1" }, context), null);
  assert.equal(edgeProblem(map, { id: "wall", from: "na", to: "nb" }, context), "crosses a wall");
});
