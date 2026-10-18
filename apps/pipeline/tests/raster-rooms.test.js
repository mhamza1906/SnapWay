import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { rasterRoomsMap } from "../server/pipelines/raster-rooms.js";
import { runSmartMap } from "../server/pipelines/smart-map.js";
import { preparePlan } from "../server/pipelines/preparation.js";
import { newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { OpenAIProvider } from "../server/provider.js";
import { emptyMap, validateMap, pointSegment, inside, distance, clone } from "../shared/map.js";

// Synthetic plans only (not real buildings): black walls on white, drawn as
// SVG and rasterised with sharp. The building sits 30 px inside the image so
// the white margin around it is the outside.
const W = 800, H = 500;
const cache = () => join(tmpdir(), `raster-rooms-${crypto.randomUUID()}`);

// Wall centre line [a, b] minus door gaps (clear openings) along it.
function pieces(a, b, gaps) {
  let out = [[a, b]];
  for (const [g0, g1] of gaps)
    out = out.flatMap(([p, q]) => (g1 <= p || g0 >= q) ? [[p, q]] : [[p, g0], [g1, q]].filter(([u, v]) => v - u > 0));
  return out;
}
/**
 * h: horizontal walls [y, x0, x1, gaps], v: vertical walls [x, y0, y1, gaps].
 * Walls are T px thick and extend T/2 past their ends so corners close.
 * hollow: each wall is two 2 px lines with a (T - 4) px white core.
 */
function planSvg({ T = 10, hollow = false, h = [], v = [], extra = "" }) {
  const rects = [
    ...h.flatMap(([y, x0, x1, gaps = []]) => pieces(x0 - T / 2, x1 + T / 2, gaps).map(([a, b]) => ({ x: a, y: y - T / 2, w: b - a, h: T }))),
    ...v.flatMap(([x, y0, y1, gaps = []]) => pieces(y0 - T / 2, y1 + T / 2, gaps).map(([a, b]) => ({ x: x - T / 2, y: a, w: T, h: b - a }))),
  ];
  const r = (q, fill, k = 0) => `<rect x="${q.x + k}" y="${q.y + k}" width="${q.w - 2 * k}" height="${q.h - 2 * k}" fill="${fill}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="white"/>` +
    rects.map((q) => r(q, "black")).join("") + (hollow ? rects.map((q) => r(q, "white", 2)).join("") : "") + extra + "</svg>";
}
const plan = (spec) => sharp(Buffer.from(planSvg(spec))).png().toBuffer();
const OUTER = { h: [[30, 30, 770], [470, 30, 770]], v: [[30, 30, 470], [770, 30, 470]] };

// Two rooms (west A, east B) above a corridor; one 40 px door gap each.
const GAP_A = [180, 220], GAP_B = [560, 600], DOOR_Y = 340;
const twoRooms = ({ T, hollow, extra, gaps = [GAP_A, GAP_B] } = {}) => plan({ T, hollow, extra,
  h: [...OUTER.h, [DOOR_Y, 30, 770, gaps]], v: [...OUTER.v, [400, 30, DOOR_Y]] });
// Door-sized gaps at this image scale (validateOpening allows a 14 px 'door' in a source up to 1280 px wide).
const NARROW = [[194, 206], [574, 586]];
const AT = { a: { x: 215, y: 185 }, b: { x: 585, y: 185 }, corridor: { x: 400, y: 405 } };

const regionAt = (r, p) => r.spaces.filter((s) => inside(p, s.polygon));
const one = (r, p, what) => {
  const found = regionAt(r, p);
  assert.equal(found.length, 1, `${what}: expected one region at ${JSON.stringify(p)}, got ${found.map((s) => s.id)}`);
  return found[0];
};
const onBoundary = (p, polygon, tol = 2) =>
  polygon.some((a, i) => pointSegment(p, a, polygon[(i + 1) % polygon.length]) <= tol);
const asMap = (r, png) => Object.assign(emptyMap({ name: "Synthetic raster plan", width: r.width, height: r.height,
  dataUrl: `data:image/png;base64,${png.toString("base64")}`, normalized: true, provenance: "Synthetic test image", fictional: true }),
{ spaces: r.spaces, doors: r.doors, walls: r.walls });
// Polygon validity only; connection, scale and review notices are not under test.
const SHAPE_CODES = ["schema", "polygon", "overlap", "bounds", "duplicate", "reference"];
const shapeIssues = (r, png) => validateMap(asMap(r, png)).filter((i) => SHAPE_CODES.includes(i.code));
const bbox = (polygon) => {
  const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

function assertDoorsOnBoundaries(r) {
  for (const d of r.doors) for (const id of d.spaceIds) {
    const s = r.spaces.find((x) => x.id === id);
    assert.ok(s, `${d.id} references missing ${id}`);
    for (const p of [d.a, d.b])
      assert.ok(onBoundary(p, s.polygon), `${d.id} endpoint ${JSON.stringify(p)} is not on the boundary of ${s.label}`);
  }
}

// Shared structure of the two-room plan, whatever the wall drawing style.
function assertTwoRoomStructure(r, png) {
  assert.equal(r.width, W); assert.equal(r.height, H);
  assert.equal(r.spaces.length, 3, JSON.stringify(r.spaces.map((s) => [s.id, s.label, s.kind])));
  const a = one(r, AT.a, "room A"), b = one(r, AT.b, "room B"), c = one(r, AT.corridor, "corridor");
  assert.equal(new Set([a.id, b.id, c.id]).size, 3, "rooms and corridor are separate regions");
  assert.equal(c.kind, "corridor");
  assert.match(c.label, /^Hallway \d+$/);
  for (const room of [a, b]) {
    assert.equal(room.kind, "room", `${room.label} is a room`);
    assert.match(room.label, /^Unlabelled room \d+$/);
  }
  assert.equal(r.doors.length, 2, JSON.stringify(r.doors));
  for (const d of r.doors) {
    assert.equal(d.spaceIds.length, 2, `${d.id} links two inside regions (no exterior door is drawn)`);
    assert.ok(d.spaceIds.includes(c.id), `${d.id} opens onto the corridor`);
    assert.ok(!d.id.includes("coverage-open-"), `${d.id} is a doorway, not a decomposition join`);
  }
  assert.deepEqual(r.doors.map((d) => d.spaceIds.find((id) => id !== c.id)).sort(), [a.id, b.id].sort(),
    "one door from the corridor into each room");
  assert.deepEqual(shapeIssues(r, png), []);
  assertDoorsOnBoundaries(r);
  assert.equal(r.stats.regions, 3); assert.equal(r.stats.doors, 2); assert.equal(r.stats.corridors, 1);
  return { a, b, c };
}

// Each door sits in its drawn 40 px gap, and no room spreads past its own walls.
function assertDoorsInGaps(r) {
  const a = one(r, AT.a, "room A"), b = one(r, AT.b, "room B"), c = one(r, AT.corridor, "corridor");
  for (const [room, [g0, g1]] of [[a, GAP_A], [b, GAP_B]]) {
    const d = r.doors.find((x) => x.spaceIds.includes(room.id) && x.spaceIds.includes(c.id));
    assert.ok(d, `door into ${room.label}`);
    const len = distance(d.a, d.b), mid = { x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 };
    assert.ok(len >= 30 && len <= 60, `${d.id} (${d.label}) is ${len.toFixed(1)} px long, expected about 40: ${JSON.stringify([d.a, d.b])}`);
    assert.ok(mid.x >= g0 - 5 && mid.x <= g1 + 5 && Math.abs(mid.y - DOOR_Y) <= 8,
      `${d.id} midpoint ${JSON.stringify(mid)} is outside the drawn gap x ${g0}–${g1}, y ${DOOR_Y}`);
  }
  const ba = bbox(a.polygon), bb = bbox(b.polygon), bc = bbox(c.polygon);
  assert.ok(ba.x1 <= 410 && ba.y1 <= DOOR_Y + 10, `room A stays west of x 400 and above the corridor: ${JSON.stringify(ba)}`);
  assert.ok(bb.x0 >= 390 && bb.y1 <= DOOR_Y + 10, `room B stays east of x 400 and above the corridor: ${JSON.stringify(bb)}`);
  assert.ok(bc.y0 >= DOOR_Y - 10, `corridor stays below the corridor wall: ${JSON.stringify(bc)}`);
}

test("two rooms beside a corridor: three regions, a corridor, one door per room, valid shared-edge polygons", async () => {
  const png = await twoRooms();
  assertTwoRoomStructure(await rasterRoomsMap(png), png);
});

test("hollow double-line walls give the same rooms, corridor and doors as solid walls", async () => {
  const png = await twoRooms({ T: 8, hollow: true });
  // The fixture really is hollow: the centre of the dividing wall is white, its faces black.
  const { data } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[200 * W + 400] > 200 && data[200 * W + 396] < 60 && data[200 * W + 403] < 60, "double-line wall with a white core");
  assertTwoRoomStructure(await rasterRoomsMap(png), png);
});

test("solid walls: doors sit in the drawn 40 px gaps and rooms keep to their own walls", async () => {
  assertDoorsInGaps(await rasterRoomsMap(await twoRooms()));
});

test("hollow walls: doors sit in the drawn 40 px gaps and rooms keep to their own walls", async () => {
  assertDoorsInGaps(await rasterRoomsMap(await twoRooms({ T: 8, hollow: true })));
});

test("text, seat rows and a door swing inside a room do not split it", async () => {
  const seats = Array.from({ length: 6 }, (_, i) =>
    `<line x1="70" y1="${110 + i * 30}" x2="350" y2="${110 + i * 30}" stroke="black" stroke-width="${i % 2 ? 1 : 2}"/>`).join("");
  const text = `<text x="120" y="80" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="black">LECTURE 101</text>` +
    `<text x="520" y="180" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="black">ROOM 102</text>`;
  const swing = `<path d="M180 335 A40 40 0 0 1 220 295" stroke="black" stroke-width="1.5" fill="none"/>` +
    `<line x1="180" y1="335" x2="180" y2="295" stroke="black" stroke-width="1.5"/>`;
  const png = await twoRooms({ extra: seats + text + swing }), r = await rasterRoomsMap(png);
  const { a, b } = assertTwoRoomStructure(r, png);
  // The label, every seat row and the room centre are all in room A's one region.
  for (const p of [{ x: 150, y: 75 }, { x: 200, y: 125 }, { x: 200, y: 245 }, { x: 330, y: 270 }])
    assert.equal(one(r, p, "room A clutter").id, a.id);
  assert.equal(one(r, { x: 560, y: 175 }, "room B label").id, b.id);
  // Same partition as the plan without clutter (areas within 2 %).
  const clean = await rasterRoomsMap(await twoRooms()),
    area = (s) => Math.abs(s.polygon.reduce((n, p, i) => { const q = s.polygon[(i + 1) % s.polygon.length]; return n + p.x * q.y - q.x * p.y; }, 0) / 2);
  for (const p of Object.values(AT)) {
    const x = one(r, p, "cluttered"), y = one(clean, p, "clean");
    assert.ok(Math.abs(area(x) - area(y)) <= 0.02 * area(y), `${x.label}: ${area(x)} vs ${area(y)} px²`);
  }
});

test("a corridor ring around an enclosed core is cut into hole-free pieces joined by open circulation joins", async () => {
  const png = await plan({ h: [...OUTER.h, [110, 110, 690], [390, 110, 690]], v: [...OUTER.v, [110, 110, 390], [690, 110, 390]] });
  const r = await rasterRoomsMap(png);
  assert.deepEqual(shapeIssues(r, png), [], "no polygon has a hole, self-intersects or overlaps another");
  const core = one(r, { x: 400, y: 250 }, "core");
  // No ring piece wraps around the core (a polygon cannot carry a hole).
  for (const s of r.spaces.filter((s) => s.id !== core.id)) {
    assert.ok(!inside({ x: 400, y: 250 }, s.polygon), `${s.label} encloses the core`);
    assert.ok(!inside({ x: 200, y: 200 }, s.polygon) && !inside({ x: 600, y: 300 }, s.polygon), `${s.label} covers the core`);
  }
  assert.equal(core.access, "unknown", "the core has no drawn opening");
  assert.ok(!r.doors.some((d) => d.spaceIds.includes(core.id)), "the core is walled off");
  const ring = [{ x: 70, y: 200 }, { x: 400, y: 70 }, { x: 730, y: 300 }, { x: 400, y: 430 }].map((p) => one(r, p, "ring band"));
  const pieces = [...new Map(ring.map((s) => [s.id, s])).values()];
  assert.ok(pieces.length >= 2, `the ring is split into pieces: ${pieces.map((s) => s.label)}`);
  assert.equal(r.spaces.length, pieces.length + 1, JSON.stringify(r.spaces.map((s) => s.label)));
  for (const s of pieces) assert.equal(s.kind, "corridor", `${s.label} is circulation`);
  const joins = r.doors.filter((d) => d.id.includes("coverage-open-"));
  assert.ok(joins.length >= 1, JSON.stringify(r.doors));
  for (const d of joins) {
    assert.equal(d.label, "Open circulation join");
    assert.equal(d.spaceIds.length, 2);
    assert.ok(d.spaceIds.every((id) => pieces.some((s) => s.id === id)), `${d.id} joins two ring pieces`);
  }
  // The joins reconnect every piece of the ring.
  const parent = new Map(pieces.map((s) => [s.id, s.id])), find = (x) => parent.get(x) === x ? x : find(parent.get(x));
  for (const d of joins) parent.set(find(d.spaceIds[0]), find(d.spaceIds[1]));
  assert.equal(new Set(pieces.map((s) => find(s.id))).size, 1, "ring pieces are one connected circulation area");
  assertDoorsOnBoundaries(r);
});

// Three rooms (A, B, C) above a corridor, one door each.
const threeRooms = () => plan({ h: [...OUTER.h, [DOOR_Y, 30, 770, [[140, 180], [390, 430], [640, 680]]]],
  v: [...OUTER.v, [290, 30, DOOR_Y], [530, 30, DOOR_Y]] });
const AT3 = { a: { x: 160, y: 185 }, b: { x: 410, y: 185 }, c: { x: 650, y: 185 }, corridor: { x: 400, y: 405 } };

test("inventory names regions by position; label words and generic names decide kinds as specified", async () => {
  const png = await threeRooms();
  const r = await rasterRoomsMap(png, { inventory: [
    { label: "INNOVATION HALL", kind: "room", position: { x: 160, y: 150 } },
    { label: "THE CAVE", kind: "room", position: { x: 410, y: 120 } },
    { label: "THE CAVE 210 SEATS", kind: "room", position: { x: 410, y: 230 } },
    { label: "STAIR 2", kind: "stair", position: AT3.c },
    { label: "Unlabelled central lobby/atrium", kind: "corridor", position: AT3.corridor },
  ] });
  assert.equal(r.spaces.length, 4, JSON.stringify(r.spaces.map((s) => [s.label, s.kind])));
  const a = one(r, AT3.a, "A"), b = one(r, AT3.b, "B"), c = one(r, AT3.c, "C"), hall = one(r, AT3.corridor, "corridor");
  assert.equal(a.label, "INNOVATION HALL");
  assert.equal(a.kind, "room", "plain 'Hall' is a room name, not circulation");
  assert.equal(b.label, "THE CAVE 210 SEATS", "duplicate names collapse to the fuller one");
  assert.equal(b.kind, "room");
  assert.equal(c.label, "STAIR 2");
  assert.equal(c.kind, "room", "the model only names rooms: stairs are marked by the user");
  assert.equal(hall.kind, "lobby", "a generic name that says lobby/atrium makes circulation a lobby");
  assert.match(hall.label, /lobby/i);
  for (const s of [a, b, c, hall]) assert.ok(s.confidence > 0.8, `${s.label} is named from the inventory`);
  assert.deepEqual(shapeIssues(r, png), []);

  const g = await rasterRoomsMap(png, { inventory: [
    { label: "Unlabelled space", kind: "room", position: AT3.corridor },
    { label: "Unlabelled storage area", kind: "corridor", position: AT3.a },
    { label: "MAIN CORRIDOR", kind: "room", position: AT3.b },
    { label: "Somewhere outside", kind: "room", position: { x: 10, y: 10 } },
    { label: "Off the image", kind: "room", position: { x: 5000, y: -20 } },
  ] });
  assert.equal(g.spaces.length, 4);
  assert.equal(one(g, AT3.corridor, "corridor").kind, "corridor", "a generic room name does not override the corridor shape");
  assert.equal(one(g, AT3.a, "A").kind, "room", "a generic name's kind does not override the room shape");
  assert.equal(one(g, AT3.b, "B").kind, "corridor", "'corridor' in a printed name means circulation");
  assert.equal(one(g, AT3.b, "B").label, "MAIN CORRIDOR");
  const unnamed = one(g, AT3.c, "C");
  assert.equal(unnamed.kind, "room");
  assert.match(unnamed.label, /^Unlabelled room \d+$/);
  assert.ok(!g.spaces.some((s) => /outside|Off the image/.test(s.label)), "items outside the building name nothing");
});

// ---------------------------------------------------------------------------
// runSmartMap: raster segmentation runs locally on the source image; the model
// only names it.

const message = (body) => ({ status: "completed", usage: { total_tokens: 100 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(body) }] }] });
const response = (body) => new Response(JSON.stringify(body), { status: 200 });
const INVENTORY = [
  { label: "101", kind: "room", position: AT.a },
  { label: "102", kind: "room", position: AT.b },
  { label: "Main corridor", kind: "corridor", position: AT.corridor },
];
function fakeProvider() {
  const requests = [];
  const provider = new OpenAIProvider({ apiKey: "fixture-key", model: "fixture-model", fetchImpl: async (_, { body }) => {
    const request = JSON.parse(body), name = request.text.format.name;
    requests.push(name);
    if (name === "space_inventory") return response(message({ items: INVENTORY,
      footprints: [[{ x: 30, y: 30 }, { x: 770, y: 30 }, { x: 770, y: 470 }, { x: 30, y: 470 }]], notes: [] }));
    if (name === "opening_batch") {
      const content = request.input[0].content, join = content[0].text.startsWith("Each highlighted segment is an analytical seam"),
        ids = content.filter((c) => c.type === "input_text" && c.text.startsWith("Candidate ")).map((c) => c.text.split(" ")[1].replace(/\.$/, ""));
      return response(message({ checks: ids.map((doorId) => ({ doorId, observed: join ? "open-passage" : "door", explanation: "Synthetic gap in a synthetic wall" })) }));
    }
    if (name === "region_semantics") {
      const ids = request.input[0].content.filter((c) => c.type === "input_text" && c.text.startsWith("Region ")).map((c) => c.text.split(" ")[1].replace(/\.$/, ""));
      return response(message({ checks: ids.map((spaceId) => ({ spaceId, role: "circulation", explanation: "Synthetic" })) }));
    }
    if (name === "floor_plan") return response(message({ floorName: "Synthetic", spaces: [], doors: [], walls: [], pois: [], issues: [] }));
    throw new Error(`Unexpected request ${name}`);
  } });
  return { provider, requests };
}
// A one-floor building straight from the synthetic upload (as POST
// /api/authoring/plans builds it). legacyClean marks the source like a saved
// building from the removed clean-redraw step, which "auto" still segments locally.
async function planBuilding(png, { legacyClean = false } = {}) {
  const prepared = await preparePlan(png, "synthetic.png", "image/png"), [source] = prepared.sources, b = newBuilding();
  b.id = "plan-synthetic"; b.name = "Synthetic raster plan"; b.assets = prepared.assets;
  if (legacyClean) b.assets[source.assetId] = { ...b.assets[source.assetId],
    provenance: "Clean redraw by synthetic-redraw (clean-plan-v4-2026-10-17); generated, not the original" };
  const floor = newFloor("floor-1", "Level 1", 1);
  floor.width = source.width; floor.height = source.height;
  floor.sources = [{ ...source, geometryIds: [], alignment: "reviewed", notes: "Synthetic test plan; identity alignment." }];
  floor.geometry = emptyMap({ name: source.name, width: source.width, height: source.height,
    dataUrl: b.assets[source.assetId].dataUrl, normalized: true, provenance: "Original source", fictional: false });
  b.floors = [floor];
  return parseBuilding(b);
}

test("runSmartMap segments a saved clean-redraw source locally (auto): no floor_plan request, raster method, named corridor and rooms", async () => {
  const b = await planBuilding(await twoRooms({ gaps: NARROW }), { legacyClean: true }), [floor] = b.floors, [source] = floor.sources;
  assert.match(b.assets[source.assetId].provenance, /^Clean redraw/);
  assert.equal(source.width, W); assert.equal(source.height, H);
  const before = JSON.stringify(b), { provider, requests } = fakeProvider();
  const result = await runSmartMap(b, { floorIds: [floor.id], rebuild: true }, { provider, cacheDir: cache() });
  assert.equal(JSON.stringify(b), before, "the input building is not modified");
  const [p] = result.proposals;
  assert.ok(!requests.includes("floor_plan"), `requests: ${requests}`);
  assert.ok(requests.includes("space_inventory"), "the model still reads the label inventory");
  assert.ok(requests.includes("opening_batch"), "the model still checks the openings");
  assert.equal(p.segmentation?.method, "raster", JSON.stringify(p.queue));
  assert.deepEqual(p.queue.filter((q) => ["failure", "limit", "extraction"].includes(q.type)), [], "the run completed every stage");
  assert.equal(p.plannedTiles, 0);
  assert.ok(p.map.spaces.some((s) => s.kind === "corridor"), JSON.stringify(p.map.spaces.map((s) => [s.label, s.kind])));
  assert.deepEqual(["101", "102"].filter((l) => !p.map.spaces.some((s) => s.label === l && s.kind === "room")), [], "inventory names the rooms");
  assert.equal(p.map.extraction.provider, "Local raster segmentation");
  assert.equal(p.segmentation.regions, 3);
  assert.ok(p.map.doors.length >= 2);
  assert.ok(p.records.length >= p.map.doors.length, "every raster opening was checked");
});

test("runSmartMap: raster segmentation of the uploaded source; doorways the model confirms also pass the local opening check", async () => {
  const b = await planBuilding(await twoRooms({ gaps: NARROW })), [floor] = b.floors, { provider } = fakeProvider();
  const result = await runSmartMap(b, { floorIds: [floor.id], rebuild: true, segmentation: "raster" }, { provider, cacheDir: cache() });
  const [p] = result.proposals;
  assert.ok(p.records.length >= 2);
  assert.deepEqual(p.records.map((r) => [r.doorId, r.evidence.verifier.verdict]).filter(([, v]) => v !== "supported"), [],
    "every door the fake confirms is supported");
  assert.deepEqual(p.queue.filter((q) => q.type === "opening"), []);
});

test("segmentation 'model' (and auto on a non-redraw source) still traces tiles with floor_plan", async () => {
  const b = await planBuilding(await twoRooms({ gaps: NARROW }), { legacyClean: true }), [floor] = b.floors, light = { maxDetailTiles: 1, maxRepairTiles: 0 };
  const model = fakeProvider();
  const forced = await runSmartMap(b, { floorIds: [floor.id], rebuild: true, segmentation: "model", ...light }, { provider: model.provider, cacheDir: cache() });
  assert.ok(model.requests.includes("floor_plan"), `requests: ${model.requests}`);
  assert.equal(forced.proposals[0].segmentation, undefined);
  assert.ok(forced.proposals[0].plannedTiles >= 1);

  const original = clone(b), asset = original.assets[original.floors[0].sources[0].assetId];
  asset.provenance = "Normalized source image; original retained";
  const auto = fakeProvider();
  const traced = await runSmartMap(original, { floorIds: [floor.id], rebuild: true, ...light }, { provider: auto.provider, cacheDir: cache() });
  assert.ok(auto.requests.includes("floor_plan"), `requests: ${auto.requests}`);
  assert.equal(traced.proposals[0].segmentation, undefined);
});

test("a grey-coded redraw: grey regions are circulation and white regions are rooms, whatever their shape", async () => {
  // West half filled with the redraw's circulation grey; east: a long thin white
  // strip (shape alone would call it a corridor) above a white room.
  const svg = planSvg({ h: [...OUTER.h, [120, 400, 770, [[560, 600]]]], v: [...OUTER.v, [400, 30, 470, [[60, 100], [280, 320]]]] })
    .replace('fill="white"/>', 'fill="white"/><rect x="30" y="30" width="370" height="440" fill="#D8D8D8"/>');
  const png = await sharp(Buffer.from(svg)).png().toBuffer(), r = await rasterRoomsMap(png);
  assert.equal(r.stats.greyCoded, true);
  const lobby = one(r, { x: 200, y: 250 }, "grey area"), strip = one(r, { x: 585, y: 75 }, "white strip"), room = one(r, { x: 585, y: 300 }, "white room");
  assert.equal(lobby.kind, "corridor", "a grey area is a corridor");
  assert.match(lobby.label, /^Hallway \d+$/);
  assert.deepEqual([strip.kind, room.kind], ["room", "room"], "white regions are rooms even when long and thin");
  // Without grey the same strip is a hallway by shape.
  const plain = await plan({ h: [...OUTER.h, [120, 400, 770, [[560, 600]]]], v: [...OUTER.v, [400, 30, 470, [[60, 100], [280, 320]]]] });
  const r2 = await rasterRoomsMap(plain);
  assert.equal(r2.stats.greyCoded, false);
  assert.equal(one(r2, { x: 585, y: 75 }, "plain strip").kind, "corridor");
});
