import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { LIGHT_IMAGE, MapSchema } from "../shared/map.js";
import { BuildingSchema, FloorSchema, geometryChanged, parseBuilding } from "../shared/building/schema.js";
import { renameSpace } from "../shared/building/region-edits.js";
import { doorEdgeOptions } from "../shared/building/assumed-doors.js";
import { authoringRouter, buildingSummary } from "../server/authoring-routes.js";
import { accessFixture } from "./fixtures/access-fixture.js";

// Light payloads: floor history keeps geometry without the floor image, and the
// authoring endpoints give the same answers for a "light" building (every
// asset image and floor source image replaced by LIGHT_IMAGE) as for the full
// one, and hand the placeholders back for the client to restore.
//
// The real-building case uses .local/live-all/building.json (not committed;
// skipped when absent). It is read only, never written. Each edit there takes
// about 5 s, so by default it runs the read-only endpoints and one edit;
// LIGHT_PAYLOAD_ALL=1 runs every endpoint (about 2.5 minutes).
const REAL = ".local/live-all/building.json",
  REAL_ALL = process.env.LIGHT_PAYLOAD_ALL === "1";

// Date is frozen so the same edit on the full and the light building stamps
// identical times and record IDs.
let server, base;
before(async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-17T12:00:00.000Z") });
  const app = express();
  app.use(express.json({ limit: "150mb" }));
  app.use("/api/authoring", authoringRouter());
  app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/authoring`;
});
after(() => { server.close(); mock.timers.reset(); });
const post = async (path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));

// What the editor sends: the same building with its images swapped out.
function lighten(building) {
  const b = structuredClone(building);
  for (const a of Object.values(b.assets)) a.dataUrl = LIGHT_IMAGE;
  for (const f of b.floors) f.geometry.source.dataUrl = LIGHT_IMAGE;
  return b;
}
const images = (b) => [
  ...Object.values(b.assets).map((a) => a.dataUrl),
  ...b.floors.map((f) => f.geometry.source.dataUrl),
];
// The access fixture with its plan image as the floor image, as an upload has.
async function fixture() {
  const b = await accessFixture();
  for (const f of b.floors) f.geometry.source.dataUrl = b.assets[f.sources[0].assetId].dataUrl;
  return parseBuilding(b);
}
const historyImages = (b) => b.floors.flatMap((f) => f.history.map((h) => h.geometry.source.dataUrl));

// Sends `make(building)` for the full and the light building and checks that
// the answers match. A returned building must keep exactly the images it was
// sent (real ones for the full request, placeholders for the light one), carry
// no other image bytes, and keep its history image-free.
async function sameForLight(path, full, make) {
  const light = lighten(full),
    a = await post(path, make(full)),
    b = await post(path, make(light));
  assert.equal(a.status, 200, `${path} (full): ${JSON.stringify(a.data).slice(0, 300)}`);
  assert.equal(b.status, 200, `${path} (light): ${JSON.stringify(b.data).slice(0, 300)}`);
  if (!a.data.building) {
    assert.deepEqual(b.data, a.data, `${path}: light and full answers differ`);
    return { full: a.data, light: b.data };
  }
  assert.deepEqual(images(a.data.building), images(full), `${path}: full images must come back unchanged`);
  assert.ok(images(b.data.building).every((u) => u === LIGHT_IMAGE), `${path}: placeholders must come back unchanged`);
  for (const r of [a, b]) {
    assert.ok(historyImages(r.data.building).every((u) => u === LIGHT_IMAGE), `${path}: history must not carry images`);
    assert.ok(r.data.building.floors.every((f) => f.history.length <= 10));
  }
  // Every image in the light answer is a placeholder: nothing was fetched or added.
  const text = JSON.stringify(b.data);
  assert.equal(text.split("data:").length, text.split(LIGHT_IMAGE).length, `${path}: light answer carries image bytes`);
  // An edit adds at most one image-free history entry (about one floor geometry) plus its records.
  const geometry = Math.max(...light.floors.map((f) => bytes(f.geometry)));
  assert.ok(bytes(b.data.building) <= bytes(light) + geometry + 64_000, `${path}: light answer grew by more than one history entry`);
  // Restoring the images gives exactly the full answer.
  assert.deepEqual(b.data, { ...a.data, building: lighten(a.data.building) }, `${path}: light and full answers differ`);
  return { full: a.data, light: b.data };
}

// Every authoring endpoint the editor sends a light building to, in an order
// where each edit has something to act on. Returns per-endpoint sizes and
// times. `allEdits: false` runs the read-only endpoints and one edit (rename).
async function exerciseEndpoints(full, floorId, { room, unknown, rename, stairs, merge, kind }, { allEdits = true } = {}) {
  const sizes = {},
    record = (path, r, light) => { sizes[path] = { request: bytes(light), response: bytes(r.light), fullResponse: bytes(r.full) }; },
    run = async (path, building, make) => {
      const started = performance.now(), r = await sameForLight(path, building, make);
      record(path, r, make(lighten(building)));
      sizes[path].ms = Math.round(performance.now() - started);
      return r;
    };
  await run("/summary", full, (b) => ({ building: b }));
  const rendered = await run("/render", full, (b) => ({ building: b, floorId, overlay: { highlight: [room], focus: room } }));
  assert.match(rendered.light.svg, /^<svg[^>]*data-focus=/);
  assert.equal(rendered.light.svg.includes("data:"), false, "the designed SVG embeds no image");
  // Unoverlaid render too: the design must not depend on the image.
  await run("/render", full, (b) => ({ building: b, floorId }));
  const ready = buildingSummary(full).floors.find((f) => f.floorId === floorId).rooms.filter((r) => r.ready);
  assert.ok(ready.length >= 2, "fixture needs two routable rooms");
  const routed = await run("/routes", full, (b) => ({ building: b, from: ready[0].id, to: ready.at(-1).id }));
  assert.ok(routed.light.route, JSON.stringify(routed.light));
  await run("/doorways/edges", full, (b) => ({ building: b, floorId, spaceId: unknown }));
  await run("/spaces/rename", full, (b) => ({ building: b, floorId, spaceId: rename, label: "Renamed for the light test" }));
  if (!allEdits) return sizes;
  const placed = await run("/doorways/place", full, (b) => ({ building: b, floorId, spaceIds: [unknown] }));
  // The door just placed, or (when the room is held for classification) any assumed door.
  const assumed = placed.full.summary.floors.find((f) => f.floorId === floorId).assumed,
    door = assumed.find((a) => a.roomId === unknown) ?? assumed[0];
  assert.ok(door, "the floor has an assumed door to move and remove");
  // Later edits continue from the full answer; sameForLight lightens it for the light request.
  const moved = await run("/doorways/edit", placed.full.building, (b) => ({ building: b, floorId, doorId: door.doorId, edgeKey: door.edgeKey, t: 0.3, width: door.width * 0.9 }));
  await run("/doorways/remove", moved.full.building, (b) => ({ building: b, floorId, doorId: door.doorId }));
  await run("/doorways/define-room", full, (b) => ({ building: b, floorId, spaceId: unknown }));
  await run("/doorways/not-room", full, (b) => ({ building: b, floorId, spaceId: unknown }));
  await run("/doorways/add", full, (b) => ({ building: b, floorId, spaceId: room }));
  await run("/spaces/stair", full, (b) => ({ building: b, floorId, spaceId: stairs, stair: true }));
  await run("/spaces/kind", full, (b) => ({ building: b, floorId, spaceId: kind, kind: "closed" }));
  await run("/spaces/merge", full, (b) => ({ building: b, floorId, spaceIds: merge }));
  return sizes;
}

test("LIGHT_IMAGE passes the map image schema and the building asset schema", () => {
  assert.equal(MapSchema.shape.source.shape.dataUrl.parse(LIGHT_IMAGE), LIGHT_IMAGE);
  const asset = { id: "a", name: "a", mime: "image/png", dataUrl: LIGHT_IMAGE, hash: "h", provenance: "test" };
  assert.deepEqual(BuildingSchema.shape.assets.parse({ a: asset }), { a: asset });
});

test("an edit stores history geometry without the floor image, keeping everything else and the 10-entry cap", async () => {
  const b = await fixture(), image = b.floors[0].geometry.source.dataUrl;
  assert.notEqual(image, LIGHT_IMAGE);
  const before = b.floors[0].geometry,
    edited = geometryChanged(b, "fx", before, "Test edit"),
    f = edited.floors[0], entry = f.history.at(-1);
  assert.equal(entry.reason, "Test edit");
  assert.equal(entry.revision, b.floors[0].revision);
  assert.equal(entry.geometry.source.dataUrl, LIGHT_IMAGE);
  assert.deepEqual({ ...entry.geometry, source: { ...entry.geometry.source, dataUrl: image } }, before);
  assert.equal(f.geometry.source.dataUrl, image, "the current geometry keeps its image");
  assert.equal(b.floors[0].geometry.source.dataUrl, image, "the input building is not changed");
  // Through the access transaction too.
  const renamed = renameSpace(b, "fx", "fx:a", "Room A");
  assert.ok(renamed.floors[0].history.length > 0);
  assert.ok(historyImages(renamed).every((u) => u === LIGHT_IMAGE));
  let many = b;
  for (let i = 0; i < 12; i++) many = geometryChanged(many, "fx", many.floors[0].geometry, `Edit ${i}`);
  assert.equal(many.floors[0].history.length, 10);
  assert.deepEqual(many.floors[0].history.map((h) => h.reason), Array.from({ length: 10 }, (_, i) => `Edit ${i + 2}`));
  assert.ok(historyImages(many).every((u) => u === LIGHT_IMAGE));
});

test("parsing slims an already-saved bloated history without changing the input", async () => {
  const b = await fixture(), f = b.floors[0], image = f.geometry.source.dataUrl;
  // As saved before this change: every history entry carries the full image.
  f.history = Array.from({ length: 3 }, (_, i) => ({ revision: i, at: "2026-01-01T00:00:00.000Z", reason: `Old ${i}`, geometry: structuredClone(f.geometry) }));
  const text = JSON.stringify(b), input = JSON.parse(text);
  for (const parsed of [parseBuilding(text), parseBuilding(input), BuildingSchema.parse(input)]) {
    assert.equal(parsed.floors[0].history.length, 3);
    assert.ok(historyImages(parsed).every((u) => u === LIGHT_IMAGE));
    assert.deepEqual(parsed.floors[0].history.map((h) => h.reason), ["Old 0", "Old 1", "Old 2"]);
    assert.deepEqual(parsed.floors[0].history[0].geometry.spaces, f.geometry.spaces);
    assert.equal(parsed.floors[0].geometry.source.dataUrl, image, "the current image is kept");
    assert.deepEqual(images(parsed), images(b), "asset images are kept");
    assert.ok(bytes(parsed) < bytes(b) - 2 * image.length, "the parsed building is smaller by the history images");
  }
  assert.equal(input.floors[0].history[0].geometry.source.dataUrl, image, "the input object is not mutated");
  // The single-floor schema (used for source crops) slims history the same way.
  assert.ok(FloorSchema.parse(input.floors[0]).history.every((h) => h.geometry.source.dataUrl === LIGHT_IMAGE));
  // A history entry with a non-image is still rejected only for its real problems.
  const broken = JSON.parse(text);
  broken.floors[0].history[0].geometry.spaces = "nope";
  assert.throws(() => parseBuilding(broken));
});

test("every authoring endpoint answers the same for a light building as for the full one (fixture)", async () => {
  const full = await fixture();
  const sizes = await exerciseEndpoints(full, "fx", {
    room: "fx:a", unknown: "fx:b", rename: "fx:a", stairs: "fx:c", kind: "fx:d", merge: ["fx:c", "fx:d"],
  });
  assert.equal(Object.keys(sizes).length, 14);
});

// Level B of the real building on its own (stair/elevator links to other
// floors are left out), loaded in memory from the read-only file.
function realLevelB() {
  const real = JSON.parse(readFileSync(REAL, "utf8")),
    f = real.floors.find((x) => x.label === "Level B") || real.floors[0],
    keep = new Set(f.sources.flatMap((s) => [s.assetId, s.originalAssetId])),
    nodes = real.nodes.filter((n) => n.floorId === f.id),
    ids = new Set(nodes.map((n) => n.id));
  return parseBuilding({
    ...real,
    floors: [f],
    assets: Object.fromEntries(Object.entries(real.assets).filter(([id]) => keep.has(id))),
    nodes: nodes.map((n) => ({ ...n, connectorId: null })),
    edges: real.edges.filter((e) => e.floorId === f.id && ids.has(e.from) && ids.has(e.to)),
    connectors: [],
    photos: real.photos.filter((p) => p.floorId === f.id),
  });
}

test(`light and full answers match on a copy of the real Level B floor (${REAL_ALL ? "every endpoint" : "read-only endpoints and a rename"})`, { skip: existsSync(REAL) ? false : `needs ${REAL}` }, async () => {
  const full = realLevelB(), f = full.floors[0],
    summary = buildingSummary(full).floors[0],
    ready = summary.rooms.filter((r) => r.ready && r.kind === "room").map((r) => r.id),
    unknown = summary.rooms.find((r) => !r.ready)?.id;
  assert.ok(unknown, "Level B needs a room without a verified doorway for the doorway tools");
  assert.ok(images(full).every((u) => u.length > 100_000), "the real floor carries its real images");
  // Two ready rooms that share an edge, for the merge; three others for the single-region edits.
  const pair = ready.map((id) => [id, doorEdgeOptions(f, id).find((o) => !o.hallway && ready.includes(o.adjacentId))?.adjacentId])
    .find(([, other]) => other);
  assert.ok(pair, "Level B needs two neighbouring rooms");
  const [rename, stairs, kind] = ready.filter((id) => !pair.includes(id));
  const sizes = await exerciseEndpoints(full, f.id, { room: rename, unknown, rename, stairs, kind, merge: pair }, { allEdits: REAL_ALL });
  assert.equal(Object.keys(sizes).length, REAL_ALL ? 14 : 5);
  console.log(`Level B (${f.geometry.spaces.length} regions): full request ${(bytes(full) / 1e6).toFixed(2)} MB, light request ${(bytes(lighten(full)) / 1e6).toFixed(2)} MB`);
  for (const [path, s] of Object.entries(sizes))
    console.log(`  ${path}: light ${(s.request / 1e3).toFixed(0)} kB -> ${(s.response / 1e3).toFixed(0)} kB; full answer ${(s.fullResponse / 1e3).toFixed(0)} kB; ${s.ms} ms for both`);
});
