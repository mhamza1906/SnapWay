import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { validateMap } from "../shared/map.js";
import { newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { buildGraph } from "../shared/building/graph.js";
import { traceBoundaryWalls } from "../shared/building/coverage.js";
import { mergeOutlines, newAccessRecord } from "../shared/building/access.js";
import { doorAccessState, regionNeedsSemanticReview } from "../shared/building/access-state.js";
import { roomAvailability, routeBuilding } from "../shared/building/routing.js";
import { mergeHistory, mergeNeighbours, mergeSpaces, renameSpace, setSpaceStair, unmergeSpaces } from "../shared/building/region-edits.js";
import { authoringRouter, floorSummary, renderFloor } from "../server/authoring-routes.js";

// Synthetic layout (not a real building): rooms 101–103 above a hallway, 104
// and two stair pieces below it. 101|102 share an edge with an internal door;
// the stair pieces are separated by a 1.2 px hairline gap, as model-traced
// outlines often are. 102 is held for source classification.
const rect = (x, y, r, b) => [{ x, y }, { x: r, y }, { x: r, y: b }, { x, y: b }];
const space = (id, label, kind, polygon) => ({ id, label, kind, polygon, confidence: 1 });
const door = (id, a, b, spaceIds) => ({ id, label: id, a, b, spaceIds, confidence: 1 });
const at = "2026-10-17T00:00:00.000Z";
function fixture() {
  const b = newBuilding(), f = newFloor("t", "Test floor", 1);
  b.id = "region-fixture";
  b.name = "Synthetic region fixture";
  f.width = f.geometry.source.width = 400;
  f.height = f.geometry.source.height = 300;
  f.geometry.spaces = [
    space("t:hall", "Hallway", "corridor", rect(0, 100, 300, 140)),
    space("t:r1", "101", "room", rect(0, 0, 100, 100)),
    space("t:r2", "Unlabelled 2", "room", rect(100, 0, 200, 100)),
    space("t:r3", "103", "room", rect(200, 0, 300, 100)),
    space("t:r4", "104", "room", rect(0, 140, 100, 240)),
    space("t:s1", "Unlabelled stair", "room", rect(100, 140, 200, 240)),
    space("t:s2", "105", "room", rect(201.2, 140, 300, 240)),
  ];
  f.geometry.doors = [
    door("t:d1", { x: 40, y: 100 }, { x: 50, y: 100 }, ["t:r1", "t:hall"]),
    door("t:d2", { x: 140, y: 100 }, { x: 150, y: 100 }, ["t:r2", "t:hall"]),
    door("t:d12", { x: 100, y: 40 }, { x: 100, y: 50 }, ["t:r1", "t:r2"]),
    door("t:d3", { x: 240, y: 100 }, { x: 250, y: 100 }, ["t:r3", "t:hall"]),
    door("t:d4", { x: 40, y: 140 }, { x: 50, y: 140 }, ["t:r4", "t:hall"]),
    door("t:ds1", { x: 140, y: 140 }, { x: 150, y: 140 }, ["t:s1", "t:hall"]),
    door("t:ds2", { x: 240, y: 140 }, { x: 250, y: 140 }, ["t:s2", "t:hall"]),
  ];
  f.geometry.pois = [{ id: "t:poi", label: "Printer", kind: "poi", position: { x: 180, y: 20 }, spaceId: "t:r2" }];
  f.geometry.walls = [
    ...traceBoundaryWalls(f.geometry),
    // Raster-style walls: on the 101|102 boundary, on the 102|103 boundary, in the stair gap.
    { id: "raster-1", points: [{ x: 100, y: 0 }, { x: 100, y: 40 }] },
    { id: "raster-2", points: [{ x: 200, y: 0 }, { x: 200, y: 100 }] },
    { id: "raster-3", points: [{ x: 200.6, y: 150 }, { x: 200.6, y: 230 }] },
  ];
  f.navOverrides = [
    { op: "move-node", spaceId: "t:r2", at: { x: 150, y: 50 }, to: { x: 151, y: 50 }, applied: true },
    { op: "move-node", spaceId: "t:hall", at: { x: 10, y: 120 }, to: { x: 11, y: 120 }, applied: true },
  ];
  const record = (fields) => newAccessRecord({ geometryRevision: 0, createdAt: at, review: { status: "agent-inspected", reviewer: "Fixture", at: null, notes: "" }, ...fields });
  f.access.records = [
    record({ id: "t:d2:verified", kind: "opening", status: "accepted", spaceId: "t:r2", doorId: "t:d2", openingType: "door",
      adjacentIds: ["t:r2", "t:hall"], segment: { a: { x: 140, y: 100 }, b: { x: 150, y: 100 } }, label: "t:d2", reason: "Synthetic verified opening",
      evidence: { method: "manual", description: "Synthetic", crops: [] },
      validation: { passed: true, checkedAt: at, geometryRevision: 0, failures: [] } }),
    record({ id: "t:r2:held", kind: "classification", status: "proposed", spaceId: "t:r2", reason: "Unclear region",
      evidence: { method: "ai-agent", description: "Synthetic hold", crops: [], verifier: { verdict: "uncertain", observed: "", provider: "test", model: "test" } } }),
  ];
  f.geometryStatus = "reviewed";
  f.reviewer = "Fixture";
  f.geometry.review.status = "reviewed";
  b.floors = [f];
  return buildGraph(parseBuilding(b), "t");
}
const base = fixture();
const floorOf = (b) => b.floors.find((f) => f.id === "t");
const spaceOf = (b, id) => floorOf(b).geometry.spaces.find((s) => s.id === id);
const area = (p) => Math.abs(p.reduce((n, a, i) => n + a.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * a.y, 0) / 2);
const ready = (b, id) => roomAvailability(b).find((r) => r.id === id)?.ready;
const geometryErrors = (b) => validateMap(floorOf(b).geometry).filter((i) => ["polygon", "overlap", "bounds", "reference", "duplicate"].includes(i.code));
// Wall pieces lying on the vertical line x between y0 and y1 (strictly inside).
const wallsOn = (b, x, y0, y1, tol = 1.5) => floorOf(b).geometry.walls.filter((w) => w.points.slice(1).some((q, i) => {
  const p = w.points[i], m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  return Math.abs(p.x - x) <= tol && Math.abs(q.x - x) <= tol && m.y > y0 + 1 && m.y < y1 - 1;
}));

test("fixture: rooms route through the hallway; 102 is held for classification", () => {
  assert.ok(ready(base, "t:r1") && ready(base, "t:r3") && ready(base, "t:r4"));
  assert.ok(regionNeedsSemanticReview(floorOf(base), "t:r2"));
  assert.equal(wallsOn(base, 100, 0, 100).length > 0, true);
  assert.deepEqual(geometryErrors(base), []);
});

test("rename updates the label, the graph node labels and keeps a classification hold", () => {
  const renamed = renameSpace(base, "t", "t:hall", "  Main hall ", "Dev");
  assert.equal(spaceOf(renamed, "t:hall").label, "Main hall");
  const nodes = renamed.nodes.filter((n) => n.floorId === "t" && n.spaceIds.length === 1 && n.spaceIds[0] === "t:hall" && !n.doorId);
  assert.ok(nodes.length && nodes.every((n) => n.label.startsWith("Main hall")), JSON.stringify(nodes.map((n) => n.label)));
  assert.ok(!renamed.nodes.some((n) => n.label.startsWith("Hallway")));
  const record = floorOf(renamed).access.records.at(-1);
  assert.equal(record.kind, "classification");
  assert.equal(record.evidence.method, "manual");
  assert.equal(record.review.status, "human-reviewed");
  assert.deepEqual([record.change.from.label, record.change.to.label], ["Hallway", "Main hall"]);
  assert.ok(ready(renamed, "t:r1") && ready(renamed, "t:r3"));
  // A rename is not a classification decision: the held region stays held.
  const held = renameSpace(base, "t", "t:r2", "102");
  assert.ok(regionNeedsSemanticReview(floorOf(held), "t:r2"));
  assert.equal(floorOf(held).access.records.at(-1).review.status, "agent-inspected");
  assert.equal(floorOf(held).access.records.at(-1).review.reviewer, "Unnamed editor action");
  assert.throws(() => renameSpace(base, "t", "t:r1", "   "), /1–120 characters/);
  assert.throws(() => renameSpace(base, "t", "t:r1", "x".repeat(121)), /1–120 characters/);
  assert.throws(() => renameSpace(base, "t", "t:nope", "X"), /Unknown region/);
  assert.equal(renameSpace(base, "t", "t:r1", "101"), base, "an unchanged name is a no-op");
});

test("stair mark and unmark round-trip through parseBuilding and the summary", () => {
  const marked = setSpaceStair(base, "t", "t:r3", true, "Dev");
  const reparsed = parseBuilding(JSON.parse(JSON.stringify(marked)));
  assert.deepEqual([spaceOf(reparsed, "t:r3").kind, spaceOf(reparsed, "t:r3").use], ["lobby", "stair"]);
  const summary = floorSummary(reparsed, "t");
  assert.equal(summary.spaces.find((s) => s.id === "t:r3").stair, true);
  assert.equal(summary.spaces.find((s) => s.id === "t:r3").kind, "lobby");
  assert.equal(summary.spaces.find((s) => s.id === "t:r1").stair, false);
  assert.deepEqual(summary.stairs, [{ id: "t:r3", label: "103" }]);
  assert.ok(!summary.rooms.some((r) => r.id === "t:r3"), "a stair is circulation, not a destination");
  assert.equal(summary.spaces.length, floorOf(base).geometry.spaces.length);
  const record = floorOf(marked).access.records.at(-1);
  assert.deepEqual([record.change.from.use, record.change.to.use, record.review.status], [null, "stair", "human-reviewed"]);
  const svg = renderFloor(marked, "t");
  assert.match(svg, /<pattern id="stair-t"/);
  assert.match(svg, /103 · Stair<\/title>/);
  assert.match(svg, />103 \(stair\)<\/text>/);
  assert.ok(routeBuilding(marked, "t:r1", "t:r4"), "routes still cross the hallway");
  assert.equal(setSpaceStair(marked, "t", "t:r3", true), marked, "already a stair: no-op");
  const unmarked = setSpaceStair(reparsed, "t", "t:r3", false);
  assert.equal(spaceOf(unmarked, "t:r3").kind, "room");
  assert.equal("use" in spaceOf(unmarked, "t:r3"), false);
  assert.equal(floorSummary(unmarked, "t").spaces.find((s) => s.id === "t:r3").stair, false);
  assert.deepEqual(floorSummary(unmarked, "t").stairs, []);
  assert.ok(ready(unmarked, "t:r3"));
  assert.doesNotMatch(renderFloor(unmarked, "t"), /stair-t/);
  assert.throws(() => setSpaceStair(base, "t", "t:r3", "yes"), /stair: true or false/);
});

test("merging two adjacent rooms keeps the first ID, removes the internal door and shared walls, re-points the rest", () => {
  const { building: merged, spaceId } = mergeSpaces(base, "t", ["t:r1", "t:r2"], { reviewer: "Dev" });
  const f = floorOf(merged), room = spaceOf(merged, "t:r1");
  assert.equal(spaceId, "t:r1");
  assert.equal(spaceOf(merged, "t:r2"), undefined);
  assert.equal(f.geometry.spaces.length, floorOf(base).geometry.spaces.length - 1);
  assert.equal(room.label, "101", "the first non-generic label wins");
  assert.equal(room.kind, "room");
  assert.equal(area(room.polygon), 20000);
  assert.equal(room.polygon.length, 4);
  // Doors: the internal one is gone (with a rejected-door record), the external one now opens from 101.
  assert.equal(f.geometry.doors.some((d) => d.id === "t:d12"), false);
  assert.deepEqual(f.geometry.doors.find((d) => d.id === "t:d2").spaceIds, ["t:r1", "t:hall"]);
  assert.ok(!f.geometry.doors.some((d) => d.spaceIds.includes("t:r2")));
  const gone = f.access.records.findLast((r) => r.doorId === "t:d12");
  assert.deepEqual([gone.kind, gone.status, gone.spaceId], ["rejected-door", "rejected", "t:r1"]);
  // The verified record follows its door, so the door stays verified.
  const verified = f.access.records.find((r) => r.id === "t:d2:verified");
  assert.deepEqual([verified.spaceId, verified.adjacentIds], ["t:r1", ["t:r1", "t:hall"]]);
  assert.equal(doorAccessState(f, f.geometry.doors.find((d) => d.id === "t:d2")).state, "verified");
  assert.ok(!f.access.records.some((r) => r.spaceId === "t:r2" || r.adjacentIds.includes("t:r2")));
  // The hold on 102 is superseded by the merge decision.
  assert.equal(f.access.records.find((r) => r.id === "t:r2:held").status, "rejected");
  assert.equal(regionNeedsSemanticReview(f, "t:r1"), false);
  const decision = f.access.records.findLast((r) => r.kind === "classification");
  assert.deepEqual([decision.spaceId, decision.status, decision.evidence.method, decision.review.status], ["t:r1", "accepted", "manual", "human-reviewed"]);
  // Walls on the merged-away boundary (traced and raster) are gone; outer ones stay.
  assert.deepEqual(wallsOn(merged, 100, 0, 100), []);
  assert.ok(f.geometry.walls.some((w) => w.id === "raster-2"), "the wall onto 103 stays");
  assert.ok(wallsOn(merged, 200, 0, 100).length > 0);
  assert.ok(!f.geometry.walls.some((w) => w.id.startsWith("t:r2:w:")));
  // Other references follow the kept ID.
  assert.equal(f.geometry.pois[0].spaceId, "t:r1");
  assert.deepEqual(f.navOverrides.map((o) => o.spaceId), ["t:hall"]);
  assert.deepEqual(geometryErrors(merged), []);
  // Routes still reach the merged room through both of its doors.
  assert.ok(ready(merged, "t:r1"));
  for (const [from, to] of [["t:r1", "t:r3"], ["t:r4", "t:r1"]]) assert.ok(routeBuilding(merged, from, to), `${from} → ${to}`);
  assert.ok(!floorSummary(merged, "t").rooms.some((r) => r.id === "t:r2"));
  assert.equal(floorSummary(merged, "t").rooms.find((r) => r.id === "t:r1").doors, 2);
});

test("on a floor with only raster walls, a merge cuts the shared stretch of each wall and adds no traced walls", () => {
  const b = fixture(), f = floorOf(b);
  f.geometry.walls = [
    ...f.geometry.walls.filter((w) => w.id.startsWith("raster-")),
    // Runs up the 101|102 boundary, then turns along the hallway wall.
    { id: "raster-4", points: [{ x: 100, y: 60 }, { x: 100, y: 100 }, { x: 130, y: 100 }] },
  ];
  const merged = floorOf(mergeSpaces(buildGraph(b, "t"), "t", ["t:r1", "t:r2"]).building);
  assert.ok(!merged.geometry.walls.some((w) => w.id.includes(":w:")), "no boundary-traced walls appear");
  assert.deepEqual(merged.geometry.walls.map((w) => w.id).sort(), ["raster-2", "raster-3", "raster-4"]);
  assert.deepEqual(merged.geometry.walls.find((w) => w.id === "raster-4").points, [{ x: 100, y: 100 }, { x: 130, y: 100 }]);
});

test("merging as a stair across a hairline gap gives one walkable stair; a given label wins", () => {
  const { building: merged, spaceId } = mergeSpaces(base, "t", ["t:s1", "t:s2"], { stair: true });
  const stair = spaceOf(merged, spaceId), f = floorOf(merged);
  assert.equal(spaceId, "t:s1");
  assert.deepEqual([stair.kind, stair.use, stair.label], ["lobby", "stair", "105"]);
  assert.ok(Math.abs(area(stair.polygon) - 20000) < 0.01, "the 1.2 px gap is closed");
  assert.deepEqual(geometryErrors(merged), []);
  assert.equal(f.geometry.walls.some((w) => w.id === "raster-3"), false, "the wall in the gap is removed");
  assert.deepEqual(wallsOn(merged, 200.6, 140, 240), []);
  assert.deepEqual(f.geometry.doors.filter((d) => d.spaceIds.includes("t:s1")).map((d) => d.id).sort(), ["t:ds1", "t:ds2"]);
  assert.deepEqual(floorSummary(merged, "t").stairs, [{ id: "t:s1", label: "105" }]);
  assert.equal(f.access.records.at(-1).review.status, "agent-inspected");
  assert.ok(routeBuilding(merged, "t:r4", "t:r3"));
  const named = mergeSpaces(base, "t", ["t:s2", "t:s1"], { label: " Stair A ", stair: false }).building;
  assert.deepEqual([spaceOf(named, "t:s2").label, spaceOf(named, "t:s2").kind, "use" in spaceOf(named, "t:s2")], ["Stair A", "room", false]);
  // With `stair` omitted, merging two stairs keeps a stair.
  let stairs = setSpaceStair(setSpaceStair(base, "t", "t:s1", true), "t", "t:s2", true);
  stairs = mergeSpaces(stairs, "t", ["t:s1", "t:s2"]).building;
  assert.equal(spaceOf(stairs, "t:s1").use, "stair");
});

test("regions that do not share a boundary, or that would enclose a hole, are not merged", () => {
  assert.throws(() => mergeSpaces(base, "t", ["t:r1", "t:r4"]), /Only regions that share a wall can be merged: 104 does not/);
  assert.throws(() => mergeSpaces(base, "t", ["t:r1"]), /two regions at a time/);
  assert.throws(() => mergeSpaces(base, "t", ["t:r1", "t:r2", "t:r3"]), /two regions at a time/);
  assert.throws(() => mergeSpaces(base, "t", ["t:r1", "t:r1"]), /only once/);
  assert.throws(() => mergeSpaces(base, "t", ["t:r1", "t:nope"]), /Unknown region t:nope/);
  assert.throws(() => mergeOutlines([rect(0, 0, 300, 100), rect(0, 100, 100, 200), rect(200, 100, 300, 200), rect(0, 200, 300, 300)]), /surround/);
  assert.throws(() => mergeOutlines([rect(0, 0, 100, 100), rect(100, 100, 200, 200)]), /share a boundary/, "corner contact is not a shared boundary");
});

test("wall neighbours: regions sharing a wall (hairline gaps included), never corner contact", () => {
  const n = mergeNeighbours(floorOf(base));
  assert.deepEqual([...n.get("t:r1")].sort(), ["t:hall", "t:r2"]);
  assert.ok(n.get("t:s1").includes("t:s2"), "a 1.2 px hairline still counts as a shared wall");
  assert.ok(!n.get("t:r1").includes("t:r4"));
  const summary = floorSummary(base, "t");
  assert.deepEqual([...summary.spaces.find((s) => s.id === "t:r1").neighbours].sort(), ["t:hall", "t:r2"]);
  assert.deepEqual(summary.merges, []);
});

test("unmerge puts both rooms, the doorway between them and the walls back exactly; merges undo newest first", () => {
  const key = (b) => {
    const g = floorOf(b).geometry, sort = (l) => JSON.stringify([...l].sort((a, z) => (a.id < z.id ? -1 : 1)));
    return [sort(g.spaces), sort(g.doors), sort(g.walls), JSON.stringify(g.pois)];
  };
  const once = mergeSpaces(base, "t", ["t:r1", "t:r2"], { reviewer: "Dev" }).building;
  const [m1] = mergeHistory(floorOf(once));
  assert.deepEqual([m1.keptId, m1.label, m1.removedLabel, m1.undoable], ["t:r1", "101", "Unlabelled 2", true]);
  // Merge the result again with 103: only the newest merge can be undone now.
  const twice = mergeSpaces(once, "t", ["t:r1", "t:r3"]).building;
  const [m2, older] = mergeHistory(floorOf(twice));
  assert.deepEqual([m2.removedLabel, m2.undoable, older.undoable], ["103", true, false]);
  assert.match(older.reason, /unmerge the later merge first/);
  assert.throws(() => unmergeSpaces(twice, "t", older.recordId), /changed shape after this merge/);
  const back1 = unmergeSpaces(twice, "t", m2.recordId);
  assert.deepEqual(key(back1), key(once));
  const back0 = unmergeSpaces(back1, "t", mergeHistory(floorOf(back1))[0].recordId, "Dev");
  assert.deepEqual(key(back0), key(base), "the floor is exactly as before both merges");
  const f = floorOf(back0);
  // The restored internal doorway is checked again and usable; 102's records are its own again.
  assert.equal(doorAccessState(f, f.geometry.doors.find((d) => d.id === "t:d12")).state, "verified");
  assert.equal(f.access.records.find((r) => r.id === "t:r2:held").spaceId, "t:r2");
  assert.deepEqual(f.access.records.find((r) => r.id === "t:d2:verified").adjacentIds, ["t:r2", "t:hall"]);
  assert.deepEqual(mergeHistory(f), []);
  assert.deepEqual(geometryErrors(back0), []);
  assert.ok(routeBuilding(back0, "t:r1", "t:r3"));
  assert.throws(() => unmergeSpaces(back0, "t", m1.recordId), /already undone/);
  assert.throws(() => unmergeSpaces(back0, "t", "nope"), /Unknown merge/);
});

// The authoring routes over HTTP, with the same error handler as the server.
let server, url;
before(async () => {
  const app = express();
  app.use(express.json({ limit: "150mb" }));
  app.use("/api/authoring", authoringRouter());
  app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${server.address().port}/api/authoring`;
});
after(() => server.close());
const post = async (path, body) => {
  const r = await fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

test("HTTP: rename, stair and merge return {building, summary}; merge also returns the kept id", async () => {
  const renamed = await post("/spaces/rename", { building: base, floorId: "t", spaceId: "t:r3", label: "Lab 3", reviewer: "" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.summary.floors[0].spaces.find((s) => s.id === "t:r3").label, "Lab 3");
  const stair = await post("/spaces/stair", { building: renamed.data.building, floorId: "t", spaceId: "t:r3", stair: true, reviewer: "Dev" });
  assert.equal(stair.status, 200, JSON.stringify(stair.data));
  assert.deepEqual(stair.data.summary.floors[0].stairs, [{ id: "t:r3", label: "Lab 3" }]);
  const merged = await post("/spaces/merge", { building: stair.data.building, floorId: "t", spaceIds: ["t:r1", "t:r2"], stair: false, reviewer: "" });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  assert.equal(merged.data.spaceId, "t:r1");
  const f = merged.data.summary.floors[0];
  assert.ok(f.spaces.some((s) => s.id === "t:r1" && s.label === "101" && s.stair === false));
  assert.ok(!f.spaces.some((s) => s.id === "t:r2"));
  assert.equal(merged.data.building.floors[0].geometry.spaces.find((s) => s.id === "t:r3").use, "stair");
  const bad = await post("/spaces/merge", { building: base, floorId: "t", spaceIds: ["t:r1", "t:r4"], stair: false, reviewer: "" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "Only regions that share a wall can be merged: 104 does not share a wall with the rest.");
  const badStair = await post("/spaces/stair", { building: base, floorId: "t", spaceId: "t:r3" });
  assert.equal(badStair.status, 400);
  const badFloor = await post("/spaces/rename", { building: base, floorId: "nope", spaceId: "t:r3", label: "X" });
  assert.deepEqual([badFloor.status, badFloor.data.error], [400, "Unknown floor."]);
});

test("HTTP: render highlights known regions without taking pointer events", async () => {
  const { status, data } = await post("/render", { building: base, floorId: "t", overlay: { highlight: ["t:r1", "nope", 5] } });
  assert.equal(status, 200, JSON.stringify(data));
  const shapes = [...data.svg.matchAll(/<polygon data-highlight="([^"]+)"[^>]*>/g)];
  assert.deepEqual(shapes.map((m) => m[1]), ["t:r1"]);
  assert.match(shapes[0][0], /points="0,0 100,0 100,100 0,100"/);
  assert.match(shapes[0][0], /fill="#1565c0" fill-opacity="0.25" stroke="#1565c0" stroke-width="3"/);
  assert.match(shapes[0][0], /pointer-events="none"/);
  assert.match(data.svg, /<g data-overlay="true" pointer-events="none">/);
  const none = await post("/render", { building: base, floorId: "t", overlay: { highlight: ["nope"] } });
  assert.doesNotMatch(none.data.svg, /data-overlay/);
  const bad = await post("/render", { building: base, floorId: "t", overlay: { highlight: "t:r1" } });
  assert.equal(bad.status, 400);
});
