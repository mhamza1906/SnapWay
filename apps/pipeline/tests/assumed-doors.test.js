import test from "node:test";
import assert from "node:assert/strict";
import { clone, distance } from "../shared/map.js";
import { accessInventory, newAccessRecord } from "../shared/building/access.js";
import { spaceAccessState } from "../shared/building/access-state.js";
import { roomAvailability, routeBuilding } from "../shared/building/routing.js";
import { validateBuilding } from "../shared/building/validation.js";
import {
  addAssumedDoor, assumedDoors, bridgeComponents, defineAsRoom, doorEdgeOptions, defineNotRoom, editAssumedDoor, placeAssumedDoorways, removeAssumedDoor, roomsNeedingDoors,
} from "../shared/building/assumed-doors.js";
import { accessFixture } from "./fixtures/access-fixture.js";

const base = await accessFixture();
const ready = (b, id) => roomAvailability(b).find(r => r.id === id)?.ready;
const mid = d => ({ x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 });

test("a room with no doorway gets an assumed door at the midpoint of its hallway edge; it routes but is never counted as verified", () => {
  const floor = base.floors[0];
  assert.ok(roomsNeedingDoors(floor).some(s => s.id === "fx:b"));
  assert.ok(!ready(base, "fx:b"));
  const { building, placed } = placeAssumedDoorways(base, "fx", { spaceIds: ["fx:b"] });
  assert.deepEqual(placed.map(p => p.spaceId), ["fx:b"]);
  const f = building.floors[0], door = f.geometry.doors.find(d => d.id === placed[0].doorId);
  // fx:b spans x 100–200 along the corridor at y = 100.
  assert.ok(distance(mid(door), { x: 150, y: 100 }) < 0.01, JSON.stringify(door));
  assert.deepEqual(door.spaceIds, ["fx:b", "fx:corridor"]);
  const record = f.access.records.findLast(r => r.doorId === door.id);
  assert.equal(record.evidence.method, "assumed");
  assert.equal(record.review.status, "agent-inspected");
  assert.equal(spaceAccessState(f, f.geometry.spaces.find(s => s.id === "fx:b")).status, "assumed");
  assert.ok(ready(building, "fx:b"));
  const inv = accessInventory(building).floors[0];
  assert.equal(inv.assumed, 1);
  assert.ok(!inv.queue.some(q => q.spaceId === "fx:b"));
  assert.equal(validateBuilding(building).filter(i => i.severity === "error").length, 0);
  assert.equal(JSON.stringify(base.floors[0].geometry.doors.map(d => d.id)), JSON.stringify(floor.geometry.doors.map(d => d.id)));
});

test("a developer can move an assumed door along its edge, confirm it by name, or remove it", () => {
  const placed = placeAssumedDoorways(base, "fx", { spaceIds: ["fx:b"] }).building;
  const [a] = assumedDoors(placed.floors[0]);
  assert.equal(a.room.id, "fx:b");
  assert.ok(Math.abs(a.t - 0.5) < 0.01);
  const moved = editAssumedDoor(placed, "fx", a.door.id, { edgeKey: a.edgeKey, t: 0.25, width: 10 });
  const door = moved.floors[0].geometry.doors.find(d => d.id === a.door.id);
  assert.ok(distance(mid(door), { x: 125, y: 100 }) < 0.01, JSON.stringify(door));
  assert.ok(Math.abs(distance(door.a, door.b) - 10) < 0.01);
  assert.ok(ready(moved, "fx:b"));
  assert.equal(assumedDoors(moved.floors[0]).length, 1);
  assert.throws(() => editAssumedDoor(moved, "fx", a.door.id, { edgeKey: a.edgeKey, t: 0.5, width: 10, confirm: true }), /name/);
  const confirmed = editAssumedDoor(moved, "fx", a.door.id, { edgeKey: a.edgeKey, t: 0.5, width: 10, confirm: true, reviewer: "Dev" });
  const f = confirmed.floors[0], record = f.access.records.findLast(r => r.doorId === a.door.id);
  assert.equal(record.evidence.method, "manual");
  assert.equal(record.review.status, "human-reviewed");
  assert.equal(spaceAccessState(f, f.geometry.spaces.find(s => s.id === "fx:b")).status, "verified");
  assert.equal(assumedDoors(f).length, 0);
  const removed = removeAssumedDoor(moved, "fx", a.door.id);
  assert.ok(!removed.floors[0].geometry.doors.some(d => d.id === a.door.id));
  assert.ok(!ready(removed, "fx:b"));
});

test("a room with no hallway edge opens onto a neighbouring room; isolated or non-walkable-labelled rooms are reported, not forced", () => {
  const b = clone(base), g = b.floors[0].geometry;
  // Pull room fx:b 7 px away from the corridor, as when an outline stops short.
  g.spaces.find(s => s.id === "fx:b").polygon = [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 93 }, { x: 100, y: 93 }];
  const gap = placeAssumedDoorways(b, "fx", { spaceIds: ["fx:b"] });
  // It no longer touches the corridor, so it opens onto a neighbouring room instead.
  assert.equal(gap.placed.length, 1);
  assert.ok(["fx:a", "fx:c"].includes(gap.building.floors[0].geometry.doors.find(d => d.id === gap.placed[0].doorId).spaceIds[1]));
  assert.ok(ready(gap.building, "fx:b"));
  // Shrunk away from every neighbour, nothing is forced and the gap is reported.
  const alone = clone(base);
  alone.floors[0].geometry.spaces.find(s => s.id === "fx:b").polygon = [{ x: 105, y: 5 }, { x: 195, y: 5 }, { x: 195, y: 93 }, { x: 100, y: 93 }].map((p, i) => i === 3 ? { x: 105, y: 93 } : p);
  const none = placeAssumedDoorways(alone, "fx", { spaceIds: ["fx:b"] });
  assert.equal(none.placed.length, 0);
  assert.equal(none.building, alone);
  assert.match(none.skipped[0].reason, /Does not touch any walkable space .* 5 px away/);
  const duct = clone(base);
  duct.floors[0].geometry.spaces.find(s => s.id === "fx:b").label = "DUCT SPACE";
  const labelled = placeAssumedDoorways(duct, "fx", { spaceIds: ["fx:b"] });
  assert.equal(labelled.placed.length, 0);
  assert.match(labelled.skipped[0].reason, /non-walkable/);
});

test("an unresolved stair or lobby is treated as a room and gets an assumed doorway; no separate stair type remains", () => {
  const b = clone(base), stair = b.floors[0].geometry.spaces.find(s => s.id === "fx:b");
  stair.kind = "lobby"; stair.label = "STAIR B";
  const r = placeAssumedDoorways(b, "fx", { spaceIds: ["fx:b"] });
  assert.deepEqual(r.roomed, ["STAIR B"]);
  const f = r.building.floors[0], space = f.geometry.spaces.find(s => s.id === "fx:b");
  assert.equal(space.kind, "room");
  assert.equal(r.placed.length, 1);
  assert.ok(ready(r.building, "fx:b"));
  assert.equal(f.access.records.findLast(x => x.spaceId === "fx:b" && x.kind === "classification").evidence.method, "assumed");
});

test("Not a room makes a region non-walkable and removes its doors; Make it a room brings it back with a doorway", () => {
  const withDoor = placeAssumedDoorways(base, "fx", { spaceIds: ["fx:b"] }).building;
  const gone = defineNotRoom(withDoor, "fx", "fx:b", "Dev");
  let f = gone.floors[0];
  assert.equal(f.geometry.spaces.find(s => s.id === "fx:b").access, "nonwalkable");
  assert.ok(!f.geometry.doors.some(d => d.spaceIds.includes("fx:b")));
  assert.ok(!roomsNeedingDoors(f).some(s => s.id === "fx:b"));
  assert.equal(f.access.records.findLast(x => x.spaceId === "fx:b" && x.kind === "classification").review.reviewer, "Dev");
  const back = defineAsRoom(gone, "fx", "fx:b", "Dev");
  f = back.building.floors[0];
  assert.equal(f.geometry.spaces.find(s => s.id === "fx:b").kind, "room");
  assert.equal(back.placed.length, 1);
  assert.ok(ready(back.building, "fx:b"));
});

test("a room can have several doorways; routes use whichever is closest", () => {
  // fx:a already has fx:door-a onto the corridor at x 40–50.
  const one = addAssumedDoor(base, "fx", "fx:a", "Dev");
  let f = one.building.floors[0];
  const doorsOfA = f.geometry.doors.filter(d => d.spaceIds.includes("fx:a"));
  assert.equal(doorsOfA.length, 2);
  const added = f.geometry.doors.find(d => d.id === one.doorId);
  assert.equal(added.spaceIds[1], "fx:corridor");
  assert.ok(!(Math.max(added.a.x, added.b.x) > 40 && Math.min(added.a.x, added.b.x) < 50), "does not overlap the existing door");
  const two = addAssumedDoor(one.building, "fx", "fx:a", "Dev");
  f = two.building.floors[0];
  assert.equal(f.geometry.doors.filter(d => d.spaceIds.includes("fx:a")).length, 3);
  assert.notEqual(two.doorId, one.doorId);
  assert.equal(assumedDoors(f).filter(a => a.room.id === "fx:a").length, 2);
  assert.ok(ready(two.building, "fx:a"));
  assert.equal(validateBuilding(two.building).filter(i => i.severity === "error").length, 0);
  // Toward fx:c (east), the route leaves fx:a by the added door nearer to it, not fx:door-a.
  const route = routeBuilding(one.building, "fx:a", "fx:c"),
    startDoor = one.building.nodes.find(n => n.id === route.startNode)?.doorId;
  assert.equal(startDoor, one.doorId);
  assert.ok(routeBuilding(one.building, "fx:a", "fx:c").cost < routeBuilding(base, "fx:a", "fx:c").cost);
});

test("one edge can hold several doorways when the developer picks it", () => {
  const f = base.floors[0],
    corridorEdge = doorEdgeOptions(f, "fx:a").find(c => c.adjacentId === "fx:corridor");
  assert.equal(corridorEdge.doors, 1); // fx:door-a
  const one = addAssumedDoor(base, "fx", "fx:a", "Dev", { edgeKey: corridorEdge.key });
  const two = addAssumedDoor(one.building, "fx", "fx:a", "Dev", { edgeKey: corridorEdge.key });
  const g = two.building.floors[0],
    onEdge = g.geometry.doors.filter(d => d.spaceIds.includes("fx:a") && d.spaceIds.includes("fx:corridor"));
  assert.equal(onEdge.length, 3);
  assert.equal(doorEdgeOptions(g, "fx:a").find(c => c.adjacentId === "fx:corridor").doors, 3);
  // All three sit on y = 100 without overlapping.
  const spans = onEdge.map(d => [Math.min(d.a.x, d.b.x), Math.max(d.a.x, d.b.x)]).sort((x, z) => x[0] - z[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1] - 0.5, JSON.stringify(spans));
  assert.ok(onEdge.every(d => d.a.y === 100 && d.b.y === 100));
  assert.equal(validateBuilding(two.building).filter(i => i.severity === "error").length, 0);
  assert.ok(ready(two.building, "fx:a"));
  // Once the edge is full, the developer is told instead of getting an overlap.
  let b = two.building;
  assert.throws(() => { for (let i = 0; i < 20; i++) b = addAssumedDoor(b, "fx", "fx:a", "Dev", { edgeKey: corridorEdge.key }).building; }, /No free spot left on that edge/);
});

test("Make it a room overrides the non-walkable label check and places a doorway", () => {
  const b = clone(base);
  b.floors[0].geometry.spaces.find(s => s.id === "fx:b").label = "LOW ROOF";
  assert.equal(placeAssumedDoorways(b, "fx", { spaceIds: ["fx:b"] }).placed.length, 0);
  const r = defineAsRoom(b, "fx", "fx:b", "Dev");
  assert.equal(r.placed.length, 1, JSON.stringify(r.skipped));
  assert.ok(ready(r.building, "fx:b"));
});

test("a detected opening the visual check called unclear is assumed only when it joins disconnected parts", () => {
  const b = clone(base), f = b.floors[0], join = f.geometry.doors.find(d => d.id === "fx:join");
  const held = (verdict) => newAccessRecord({ id: `fx:join:check:${verdict}`, kind: "opening", status: "proposed", spaceId: "fx:corridor", doorId: "fx:join",
    openingType: "decomposition-join", adjacentIds: join.spaceIds, segment: { a: join.a, b: join.b }, reason: "Synthetic",
    evidence: { method: "ai-agent", description: "Synthetic", crops: [], verifier: { verdict, observed: `${verdict}: synthetic`, provider: "t", model: "t" } },
    review: { status: "agent-inspected", reviewer: "t", at: null, notes: "" }, geometryRevision: f.revision });
  const wall = clone(b); wall.floors[0].access.records.push(held("not-supported"));
  assert.deepEqual(bridgeComponents(wall, "fx").doors, [], "a wall verdict is never overridden");
  f.access.records.push(held("uncertain"));
  const r = bridgeComponents(b, "fx");
  assert.deepEqual(r.doors, ["fx:join"]);
  const g = r.building.floors[0], rec = g.access.records.findLast(x => x.doorId === "fx:join");
  assert.equal(rec.evidence.method, "assumed");
  assert.equal(rec.status, "accepted");
});
