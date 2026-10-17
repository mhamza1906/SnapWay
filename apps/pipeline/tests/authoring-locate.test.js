import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { buildGraph } from "../shared/building/graph.js";
import { traceBoundaryWalls } from "../shared/building/coverage.js";
import { SPACE_KINDS, newAccessRecord, spaceRole } from "../shared/building/access.js";
import { regionNeedsSemanticReview } from "../shared/building/access-state.js";
import { circulationClusters } from "../shared/building/nav-network.js";
import { roomAvailability, routeBuilding } from "../shared/building/routing.js";
import {
  addAssumedDoor, doorEdgeOptions, editAssumedDoor, minDoorStretch, neighbourEdges, placeAssumedDoorways,
} from "../shared/building/assumed-doors.js";
import { setSpaceKind, setSpaceStair } from "../shared/building/region-edits.js";
import { authoringRouter, floorSummary, renderFloor } from "../server/authoring-routes.js";

// Synthetic layouts (not real buildings).
const rect = (x, y, r, b) => [{ x, y }, { x: r, y }, { x: r, y: b }, { x, y: b }];
const space = (id, label, kind, polygon, extra = {}) => ({ id, label, kind, polygon, confidence: 1, ...extra });
const door = (id, a, b, spaceIds) => ({ id, label: id, a, b, spaceIds, confidence: 1 });
function floorBuilding(id, width, height, spaces, doors) {
  const b = newBuilding(), f = newFloor(id, `Floor ${id}`, 1);
  b.id = `fixture-${id}`;
  b.name = `Synthetic fixture ${id}`;
  f.width = f.geometry.source.width = width;
  f.height = f.geometry.source.height = height;
  f.geometry.spaces = spaces;
  f.geometry.doors = doors;
  f.geometry.walls = traceBoundaryWalls(f.geometry);
  f.geometryStatus = "reviewed";
  f.reviewer = "Fixture";
  f.geometry.review.status = "reviewed";
  b.floors = [f];
  return buildGraph(parseBuilding(b), id);
}
const floorOf = (b) => b.floors[0];
const spaceOf = (b, id) => floorOf(b).geometry.spaces.find((s) => s.id === id);
const ready = (b, id) => roomAvailability(b).find((r) => r.id === id)?.ready;

// Lab's boundary with the hallway is a raster-style polyline: flat stretches of
// 54, 8, 30, 60 and 40 px joined by 2 px diagonal steps. Store shares Lab's
// whole 100 px east edge; Closet touches Lab along only 8 px.
const jagged = [{ x: 104, y: 100 }, { x: 106, y: 102 }, { x: 114, y: 102 }, { x: 116, y: 100 }, { x: 146, y: 100 }, { x: 148, y: 102 }, { x: 208, y: 102 }, { x: 210, y: 100 }];
const frag = floorBuilding("g", 400, 200, [
  space("g:hall", "Hallway", "corridor", [{ x: 50, y: 100 }, ...jagged, { x: 350, y: 100 }, { x: 350, y: 140 }, { x: 50, y: 140 }]),
  space("g:lab", "Lab", "room", [{ x: 50, y: 0 }, { x: 250, y: 0 }, { x: 250, y: 100 }, ...[...jagged].reverse(), { x: 50, y: 100 }], { access: "unknown" }),
  space("g:store", "Store", "room", rect(250, 0, 350, 100)),
  space("g:closet", "Closet", "room", rect(0, 0, 50, 8), { access: "unknown" }),
], [door("g:d-store", { x: 290, y: 100 }, { x: 300, y: 100 }, ["g:store", "g:hall"])]);
const keysOf = (options) => options.map((c) => c.key);

test("a fragmented shared boundary gives one doorway option per neighbour; short stretches are dropped", () => {
  const f = floorOf(frag), all = doorEdgeOptions(f, "g:lab", { all: true });
  assert.equal(minDoorStretch(f, "g:lab"), 10);
  assert.deepEqual(all.map((c) => [c.key, c.adjacentId, Math.round(c.length)]), [
    [0, "g:hall", 60], [1, "g:hall", 54], [2, "g:hall", 40], [3, "g:hall", 30], [4, "g:hall", 8], [5, "g:store", 100], [6, "g:closet", 8],
  ]);
  const options = doorEdgeOptions(f, "g:lab");
  assert.deepEqual(options.map((c) => [c.key, c.adjacentId, c.hallway, Math.round(c.length), c.doors]), [[0, "g:hall", true, 60, 0], [5, "g:store", false, 100, 0]]);
  // A stretch with room for a doorway is preferred to a longer one a door already fills.
  const filled = (spans) => ({ ...f, geometry: { ...f.geometry, doors: [...f.geometry.doors, ...spans.map(([x0, x1, y], i) => door(`fill-${i}`, { x: x0, y }, { x: x1, y }, ["g:lab", "g:hall"]))] } });
  const one = doorEdgeOptions(filled([[149, 207, 102]]), "g:lab");
  assert.deepEqual(one.map((c) => [c.key, c.doors]), [[1, 0], [5, 0]]);
  // When every long-enough stretch is full, the longest is still listed with its door count.
  const full = doorEdgeOptions(filled([[149, 207, 102], [51, 103, 100], [211, 249, 100], [117, 145, 100]]), "g:lab");
  assert.deepEqual(full.map((c) => [c.key, c.doors]), [[0, 1], [5, 0]]);
  // Placement still considers every stretch.
  assert.equal(neighbourEdges(f, "g:lab").candidates.length, 7);
});

test("the summary lists the stretch an assumed door sits on even when short; edits and adds accept every listed key", () => {
  const placed = placeAssumedDoorways(frag, "g", { spaceIds: ["g:lab"] });
  assert.deepEqual(placed.placed.map((p) => p.opensOnto), ["Hallway"]);
  let a = floorSummary(placed.building, "g").assumed[0];
  assert.equal(a.edgeKey, 0);
  assert.deepEqual(keysOf(a.candidates), [0, 5]);
  assert.deepEqual(Object.keys(a.candidates[0]), ["key", "adjacentId", "adjacentLabel", "adjacentKind", "hallway", "length", "doors", "a", "b"]);
  assert.deepEqual(a.candidates.map((c) => c.doors), [0, 0], "the door itself is not counted");
  // Moved onto the 8 px stretch (a valid key from the full list), that stretch stays listed.
  // It lies on the same line (y 102) as the 60 px stretch; validateOpening snaps onto the one it is on.
  const short = editAssumedDoor(placed.building, "g", a.doorId, { edgeKey: 4, t: 0.5, width: 6 });
  a = floorSummary(short, "g").assumed[0];
  assert.equal(a.edgeKey, 4);
  assert.deepEqual(keysOf(a.candidates), [0, 4, 5]);
  assert.equal(a.candidates.find((c) => c.key === 4).length, 8);
  assert.ok(ready(short, "g:lab"));
  // The Store option's key moves the door onto the Store edge.
  const store = a.candidates.find((c) => c.adjacentId === "g:store");
  const moved = editAssumedDoor(short, "g", a.doorId, { edgeKey: store.key, t: 0.5, width: 10 });
  const d = floorOf(moved).geometry.doors.find((x) => x.id === a.doorId);
  assert.deepEqual(d.spaceIds, ["g:lab", "g:store"]);
  assert.ok(d.a.x === 250 && d.b.x === 250 && Math.abs((d.a.y + d.b.y) / 2 - 50) < 0.01, JSON.stringify(d));
  assert.equal(floorSummary(moved, "g").assumed[0].edgeKey, store.key);
  assert.ok(ready(moved, "g:lab"));
  // Adding a doorway on a listed key.
  const key = doorEdgeOptions(floorOf(placed.building), "g:lab").find((c) => c.adjacentId === "g:store").key,
    added = addAssumedDoor(placed.building, "g", "g:lab", "", { edgeKey: key });
  assert.equal(added.opensOnto, "Store");
});

// Kinds fixture: Annex and Lab open onto the hallway; Office touches Annex
// (40 px) and Lab (200 px) but not the hallway and has no doorway yet.
const kinds = floorBuilding("k", 400, 300, [
  space("k:hall", "Hallway", "corridor", rect(0, 100, 300, 140)),
  space("k:annex", "Annex", "room", rect(0, 0, 100, 100)),
  space("k:lab", "Lab C", "room", rect(100, 40, 300, 100)),
  space("k:office", "Office B", "room", rect(100, 0, 300, 40), { access: "unknown" }),
  space("k:store", "Store", "room", rect(0, 140, 100, 240)),
], [
  door("k:d-annex", { x: 40, y: 100 }, { x: 50, y: 100 }, ["k:annex", "k:hall"]),
  door("k:d-lab", { x: 240, y: 100 }, { x: 250, y: 100 }, ["k:lab", "k:hall"]),
  door("k:d-store", { x: 40, y: 140 }, { x: 50, y: 140 }, ["k:store", "k:hall"]),
]);
// The region row without its wall neighbours (checked in region-edits.test.js).
const summarySpace = (b, id) => {
  const { neighbours, ...row } = floorSummary(b, "k").spaces.find((s) => s.id === id) ?? {};
  return neighbours ? row : undefined;
};
const inCluster = (b, ...ids) => circulationClusters(floorOf(b)).some((c) => ids.every((id) => c.some((s) => s.id === id)));
const throughAnnex = (route) => route.steps.some((s) => s.from === "k:d-annex:nav" || s.to === "k:d-annex:nav");

test("a room made a corridor becomes a hallway for a neighbour's assumed door and part of the circulation network", () => {
  const before = placeAssumedDoorways(kinds, "k", { spaceIds: ["k:office"] }).placed[0];
  assert.deepEqual([before.opensOnto, before.viaRoom], ["Lab C", true]);
  assert.ok(!inCluster(kinds, "k:annex"));
  const corridor = setSpaceKind(kinds, "k", "k:annex", "corridor", "Dev");
  assert.deepEqual([spaceOf(corridor, "k:annex").kind, "use" in spaceOf(corridor, "k:annex")], ["corridor", false]);
  assert.ok(!floorSummary(corridor, "k").rooms.some((r) => r.id === "k:annex"), "a corridor is not a destination");
  assert.deepEqual(summarySpace(corridor, "k:annex"), { id: "k:annex", label: "Annex", kind: "corridor", use: null, role: "corridor", stair: false, closed: false, doors: 1 });
  assert.ok(inCluster(corridor, "k:annex", "k:hall"));
  assert.ok(corridor.nodes.some((n) => n.type === "junction" && n.spaceIds.includes("k:annex")), "the graph rebuild adds a centreline in Annex");
  const [first] = neighbourEdges(floorOf(corridor), "k:office").candidates;
  assert.deepEqual([first.adjacentId, first.hallway], ["k:annex", true]);
  const out = placeAssumedDoorways(corridor, "k", { spaceIds: ["k:office"] });
  assert.deepEqual(out.placed.map((p) => [p.opensOnto, p.viaRoom]), [["Annex", false]]);
  const route = routeBuilding(out.building, "k:office", "k:store");
  assert.ok(route && throughAnnex(route), "Office reaches Store through the Annex corridor");
  const record = floorOf(corridor).access.records.at(-1);
  assert.deepEqual([record.kind, record.evidence.method, record.review.status, record.change.from.kind, record.change.to.kind], ["classification", "manual", "human-reviewed", "room", "corridor"]);
});

test("a hall-room stays a destination, is a hallway for neighbours' doors and joins the circulation cluster", () => {
  const hall = setSpaceKind(kinds, "k", "k:annex", "hall-room");
  assert.deepEqual([spaceOf(hall, "k:annex").kind, spaceOf(hall, "k:annex").use], ["room", "hall"]);
  assert.deepEqual(summarySpace(hall, "k:annex"), { id: "k:annex", label: "Annex", kind: "room", use: "hall", role: "hall-room", stair: false, closed: false, doors: 1 });
  assert.ok(floorSummary(hall, "k").rooms.some((r) => r.id === "k:annex" && r.ready), "still a ready destination");
  assert.ok(inCluster(hall, "k:annex", "k:hall"));
  const [first] = neighbourEdges(floorOf(hall), "k:office").candidates;
  assert.deepEqual([first.adjacentId, first.adjacentKind, first.hallway], ["k:annex", "room", true]);
  const out = placeAssumedDoorways(hall, "k", { spaceIds: ["k:office"] });
  assert.deepEqual(out.placed.map((p) => [p.opensOnto, p.viaRoom]), [["Annex", false]]);
  assert.ok(throughAnnex(routeBuilding(out.building, "k:office", "k:store")));
  assert.ok(routeBuilding(out.building, "k:store", "k:annex"), "routes still end in the hall-room");
  assert.equal(floorOf(hall).access.records.at(-1).review.status, "agent-inspected", "an unnamed edit is agent-inspected");
});

test("a closed room is drawn but never routed through or given doorways; re-opening restores it with its doors", () => {
  const closed = setSpaceKind(kinds, "k", "k:lab", "closed", "Dev"), lab = spaceOf(closed, "k:lab");
  assert.deepEqual([lab.kind, lab.use, lab.access], ["room", "closed", "nonwalkable"]);
  assert.ok(floorOf(closed).geometry.doors.some((d) => d.id === "k:d-lab"), "its doorway is kept");
  assert.ok(!closed.nodes.some((n) => n.doorId === "k:d-lab"), "but not used for routing");
  const summary = floorSummary(closed, "k");
  assert.ok(!summary.rooms.some((r) => r.id === "k:lab"));
  assert.ok(!summary.needsAttention.some((q) => q.spaceId === "k:lab"));
  assert.deepEqual(summarySpace(closed, "k:lab"), { id: "k:lab", label: "Lab C", kind: "room", use: "closed", role: "closed", stair: false, closed: true, doors: 1 });
  assert.equal(routeBuilding(closed, "k:annex", "k:lab"), null);
  assert.ok(routeBuilding(closed, "k:annex", "k:store"));
  // No assumed doorway for it or onto it.
  assert.ok(!neighbourEdges(floorOf(closed), "k:office").candidates.some((c) => c.adjacentId === "k:lab"));
  assert.deepEqual(placeAssumedDoorways(closed, "k", { spaceIds: ["k:lab"] }).placed, []);
  assert.deepEqual(placeAssumedDoorways(closed, "k", { spaceIds: ["k:office"] }).placed.map((p) => p.opensOnto), ["Annex"]);
  const svg = renderFloor(closed, "k");
  assert.match(svg, /<title>Lab C · Closed<\/title>/);
  assert.match(svg, />Lab C \(closed\)<\/text>/);
  // Re-opened as a room: walkable, its doorway routes again.
  const open = setSpaceKind(closed, "k", "k:lab", "room");
  assert.deepEqual([spaceOf(open, "k:lab").access, "use" in spaceOf(open, "k:lab")], [undefined, false]);
  assert.ok(open.nodes.some((n) => n.doorId === "k:d-lab"));
  assert.ok(ready(open, "k:lab") && routeBuilding(open, "k:annex", "k:lab"));
  assert.equal(summarySpace(open, "k:lab").closed, false);
  // Re-opening restores the access a region had before: Office was unknown.
  const office = setSpaceKind(setSpaceKind(kinds, "k", "k:office", "closed"), "k", "k:office", "room");
  assert.equal(spaceOf(office, "k:office").access, "unknown");
});

test("every kind round-trips through parseBuilding and the summary; the current kind is a no-op", () => {
  const expected = {
    room: { kind: "room", use: null, closed: false, stair: false },
    "hall-room": { kind: "room", use: "hall", closed: false, stair: false },
    corridor: { kind: "corridor", use: null, closed: false, stair: false },
    lobby: { kind: "lobby", use: null, closed: false, stair: false },
    stair: { kind: "lobby", use: "stair", closed: false, stair: true },
    closed: { kind: null, use: "closed", closed: true, stair: false }, // closing keeps the kind
  };
  assert.deepEqual(SPACE_KINDS, Object.keys(expected));
  let b = kinds;
  for (const kind of [...SPACE_KINDS.slice(1), "room", "stair", "closed", "stair", "room", "corridor", "closed", "room"]) {
    const was = spaceOf(b, "k:annex").kind,
      next = setSpaceKind(b, "k", "k:annex", kind);
    assert.notEqual(next, b, kind);
    b = parseBuilding(JSON.parse(JSON.stringify(next)));
    const s = spaceOf(b, "k:annex"), row = summarySpace(b, "k:annex");
    assert.equal(spaceRole(s), kind);
    assert.deepEqual({ kind: row.kind, use: row.use, closed: row.closed, stair: row.stair }, { ...expected[kind], kind: expected[kind].kind ?? was }, kind);
    assert.equal(row.role, kind);
    assert.equal(s.access === "nonwalkable", kind === "closed", kind);
    assert.deepEqual(floorOf(b).geometry.doors.filter((d) => d.spaceIds.includes("k:annex")).map((d) => d.id), ["k:d-annex"], `${kind}: doors kept`);
    assert.equal(floorSummary(b, "k").rooms.some((r) => r.id === "k:annex"), ["room", "hall-room"].includes(kind), kind);
    assert.deepEqual(floorSummary(b, "k").stairs.map((x) => x.id), kind === "stair" ? ["k:annex"] : []);
    assert.equal(setSpaceKind(b, "k", "k:annex", kind), b, `${kind} again is a no-op`);
  }
  assert.ok(ready(b, "k:annex"));
  // A stair made a lobby (or anything else) is no longer a stair; the stair route agrees.
  const stair = setSpaceStair(kinds, "k", "k:annex", true);
  assert.equal(spaceRole(spaceOf(stair, "k:annex")), "stair");
  assert.equal(setSpaceKind(stair, "k", "k:annex", "stair"), stair);
  assert.equal("use" in spaceOf(setSpaceKind(stair, "k", "k:annex", "lobby"), "k:annex"), false);
  assert.throws(() => setSpaceKind(kinds, "k", "k:annex", "restroom"), /Choose a region kind: room, hall-room, corridor, lobby, stair or closed\./);
  assert.throws(() => setSpaceKind(kinds, "k", "k:nope", "room"), /Unknown region/);
});

test("a kind decision supersedes a pending classification hold", () => {
  const b = parseBuilding(JSON.parse(JSON.stringify(kinds)));
  floorOf(b).access.records.push(newAccessRecord({
    id: "k:annex:held", kind: "classification", status: "proposed", spaceId: "k:annex", reason: "Unclear region", geometryRevision: floorOf(b).revision,
    evidence: { method: "ai-agent", description: "Synthetic hold", crops: [], verifier: { verdict: "uncertain", observed: "", provider: "test", model: "test" } },
    review: { status: "agent-inspected", reviewer: "Fixture", at: null, notes: "" },
  }));
  const held = buildGraph(b, "k");
  assert.ok(regionNeedsSemanticReview(floorOf(held), "k:annex"));
  assert.ok(!neighbourEdges(floorOf(held), "k:office").candidates.some((c) => c.adjacentId === "k:annex"));
  const corridor = setSpaceKind(held, "k", "k:annex", "corridor");
  assert.equal(regionNeedsSemanticReview(floorOf(corridor), "k:annex"), false);
  assert.equal(floorOf(corridor).access.records.find((r) => r.id === "k:annex:held").status, "rejected");
  assert.equal(neighbourEdges(floorOf(corridor), "k:office").candidates[0].adjacentId, "k:annex");
});

test("a lobby the developer chose stays a lobby when assumed doorways are placed", () => {
  const lobby = setSpaceKind(kinds, "k", "k:office", "lobby"),
    out = placeAssumedDoorways(lobby, "k", { spaceIds: ["k:office"] });
  assert.deepEqual(out.roomed, []);
  assert.equal(spaceOf(out.building, "k:office").kind, "lobby");
  assert.equal(out.placed.length, 1);
});

// Locate: a small room on a big floor. The designed SVG's own box is the
// spaces' extent (2000 × 1000) with 5% padding (100) plus title and legend
// bands (3 units of 40 each): x -100, y -220, 2200 × 1440.
const big = floorBuilding("z", 2000, 1000, [
  space("z:hall", "Great hall", "corridor", rect(0, 0, 2000, 900)),
  space("z:closet", "Closet", "room", rect(1000, 900, 1040, 940)),
  space("z:long", "Long room", "room", rect(0, 900, 600, 1000)),
  space("z:corner", "Corner", "room", rect(1980, 980, 2000, 1000), { access: "unknown" }),
], [
  door("z:d1", { x: 1015, y: 900 }, { x: 1025, y: 900 }, ["z:closet", "z:hall"]),
  door("z:d2", { x: 300, y: 900 }, { x: 310, y: 900 }, ["z:long", "z:hall"]),
]);
const rootTag = (svg) => svg.match(/^<svg[^>]*>/)[0];
const viewBox = (svg) => rootTag(svg).match(/viewBox="([^"]+)"/)[1];

test("overlay.focus crops the view to a region with padding and a minimum size, inside the floor", () => {
  assert.equal(viewBox(renderFloor(big, "z")), "-100 -220 2200 1440");
  // 40 × 40 closet: grown to the 250 px minimum around its centre (1020, 920).
  const closet = renderFloor(big, "z", { focus: "z:closet" });
  assert.equal(viewBox(closet), "895 795 250 250");
  assert.match(rootTag(closet), / width="250" height="250" /);
  assert.match(rootTag(closet), /data-focus="z:closet"/);
  // 600 × 100 room: 25% padding each way across (900 wide), moved right to stay inside x ≥ -100.
  assert.equal(viewBox(renderFloor(big, "z", { focus: "z:long" })), "-100 825 900 250");
  // A 20 px room at the bottom-right corner: moved left to stay inside x ≤ 2100.
  assert.equal(viewBox(renderFloor(big, "z", { focus: "z:corner" })), "1850 865 250 250");
  // The 2000 × 900 hall: padded size clipped to the floor box, kept inside its top-left.
  assert.equal(viewBox(renderFloor(big, "z", { focus: "z:hall" })), "-100 -220 2200 1350");
  // Combined with a highlight, overlay shapes still take no pointer events; the floor is drawn in full.
  const both = renderFloor(big, "z", { focus: "z:closet", highlight: ["z:closet"], segments: [{ a: { x: 1015, y: 900 }, b: { x: 1025, y: 900 } }] });
  assert.equal(viewBox(both), "895 795 250 250");
  assert.match(both, /<g data-overlay="true" pointer-events="none"><polygon data-highlight="z:closet"[^>]*pointer-events="none"\/><line /);
  assert.match(both, /data-room-id="z:long"/);
  // Unknown or non-string IDs are ignored.
  for (const focus of ["z:nope", 7, null]) {
    const svg = renderFloor(big, "z", { focus });
    assert.equal(viewBox(svg), "-100 -220 2200 1440");
    assert.doesNotMatch(svg, /data-focus/);
  }
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

test("HTTP: doorways/edges lists one option per neighbour; edit takes a key from the summary", async () => {
  const edges = await post("/doorways/edges", { building: frag, floorId: "g", spaceId: "g:lab" });
  assert.equal(edges.status, 200, JSON.stringify(edges.data));
  assert.deepEqual(edges.data.edges.map((e) => [e.key, e.adjacentLabel, e.length, e.doors]), [[0, "Hallway", 60, 0], [5, "Store", 100, 0]]);
  const placed = await post("/doorways/place", { building: frag, floorId: "g", spaceIds: ["g:lab"] });
  const a = placed.data.summary.floors[0].assumed[0], store = a.candidates.find((c) => c.adjacentId === "g:store");
  const moved = await post("/doorways/edit", { building: placed.data.building, floorId: "g", doorId: a.doorId, edgeKey: store.key, t: 0.5, width: 10 });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.summary.floors[0].assumed[0].edgeKey, store.key);
});

test("HTTP: spaces/kind returns {building, summary}; an invalid kind is a 400", async () => {
  const ok = await post("/spaces/kind", { building: kinds, floorId: "k", spaceId: "k:annex", kind: "hall-room", reviewer: "Dev" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(Object.keys(ok.data), ["building", "summary"]);
  assert.equal(ok.data.building.floors[0].geometry.spaces.find((s) => s.id === "k:annex").use, "hall");
  const row = ok.data.summary.floors[0].spaces.find((s) => s.id === "k:annex");
  assert.deepEqual([row.kind, row.use, row.role, row.stair, row.closed], ["room", "hall", "hall-room", false, false]);
  const closed = await post("/spaces/kind", { building: ok.data.building, floorId: "k", spaceId: "k:lab", kind: "closed", reviewer: "" });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.summary.floors[0].spaces.find((s) => s.id === "k:lab").closed, true);
  const bad = await post("/spaces/kind", { building: kinds, floorId: "k", spaceId: "k:annex", kind: "hall" });
  assert.deepEqual([bad.status, bad.data.error], [400, "Choose a region kind: room, hall-room, corridor, lobby, stair or closed."]);
  const missing = await post("/spaces/kind", { building: kinds, floorId: "k", spaceId: "k:annex" });
  assert.equal(missing.status, 400);
  const unknown = await post("/spaces/kind", { building: kinds, floorId: "k", spaceId: "k:nope", kind: "room" });
  assert.deepEqual([unknown.status, unknown.data.error], [400, "Unknown region."]);
});

test("HTTP: render with overlay.focus", async () => {
  const { status, data } = await post("/render", { building: big, floorId: "z", overlay: { focus: "z:closet", highlight: ["z:closet"] } });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(viewBox(data.svg), "895 795 250 250");
});
