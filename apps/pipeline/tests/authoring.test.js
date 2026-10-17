import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFile } from "node:fs/promises";
import { authoringRouter, buildingSummary, renderFloor } from "../server/authoring-routes.js";
import { accessFixture } from "./fixtures/access-fixture.js";

// The Angular authoring screen's endpoints, exercised over HTTP. No provider calls.
let server, base;
before(async () => {
  const app = express();
  app.use(express.json({ limit: "150mb" }));
  app.use("/api/authoring", authoringRouter());
  app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/authoring`;
});
after(() => server.close());
const post = async (path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

test("a PDF upload becomes a building with one reviewed-alignment floor per page", async () => {
  const form = new FormData();
  form.append("plan", new Blob([await readFile("tests/fixtures/002E2_04FLR.pdf")], { type: "application/pdf" }), "002E2_04FLR.pdf");
  form.append("name", "E2 test");
  const r = await fetch(base + "/plans", { method: "POST", body: form }), data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  assert.equal(data.building.name, "E2 test");
  assert.equal(data.building.floors.length, 1);
  assert.equal(data.building.floors[0].sources[0].alignment, "reviewed");
  assert.equal(data.summary.floors[0].regions, 0);
});

test("summary lists rooms, regions needing attention and assumed doors without geometry dumps", async () => {
  const b = await accessFixture(), { data } = await post("/summary", { building: b });
  const f = data.floors.find((x) => x.floorId === "fx");
  assert.ok(f.rooms.some((r) => r.id === "fx:b" && !r.ready));
  assert.ok(f.needsAttention.some((q) => q.spaceId === "fx:b"));
  assert.equal(JSON.stringify(data).includes("polygon"), false);
});

test("doorway tools: place, then move, then remove an assumed door through the API", async () => {
  const b = await accessFixture();
  const placed = await post("/doorways/place", { building: b, floorId: "fx", spaceIds: ["fx:b"] });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  const door = placed.data.summary.floors.find((f) => f.floorId === "fx").assumed.find((a) => a.roomId === "fx:b");
  assert.ok(door && door.candidates.every((c) => c.a && c.b));
  const moved = await post("/doorways/edit", { building: placed.data.building, floorId: "fx", doorId: door.doorId, edgeKey: door.edgeKey, t: 0.25, width: 10 });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const after = moved.data.summary.floors.find((f) => f.floorId === "fx").assumed.find((a) => a.doorId === door.doorId);
  assert.ok(Math.abs(after.t - 0.25) < 0.02);
  const removed = await post("/doorways/remove", { building: moved.data.building, floorId: "fx", doorId: door.doorId });
  assert.equal(removed.data.summary.floors.find((f) => f.floorId === "fx").assumed.length, 0);
});

test("render adds highlight overlays to the designed SVG, and routes return plain point lists", async () => {
  const b = await accessFixture();
  const svg = renderFloor(b, "fx", { segments: [{ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }], routes: [[{ x: 0, y: 0 }, { x: 5, y: 5 }]] });
  assert.match(svg, /data-overlay="true"/);
  assert.match(svg, /<polyline points="0,0 5,5"/);
  const rooms = buildingSummary(b).floors.find((f) => f.floorId === "fx").rooms.filter((r) => r.ready);
  const { data } = await post("/routes", { building: b, from: rooms[0].id, to: rooms.at(-1).id });
  assert.ok(data.route, JSON.stringify(data));
  assert.ok(data.route.floors[0].segments[0].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test("bad input is rejected with a readable error", async () => {
  const { status, data } = await post("/doorways/remove", { building: { nope: true }, floorId: "fx", doorId: "x" });
  assert.equal(status, 400);
  assert.ok(data.error);
});
