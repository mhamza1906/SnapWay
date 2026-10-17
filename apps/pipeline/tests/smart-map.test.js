import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { vectorLines, tileVectorHints } from "../server/pipelines/local-vectors.js";
import { runSmartMap, budgetProvider, footprintTiles, splitTile } from "../server/pipelines/smart-map.js";
import { OpenAIProvider } from "../server/provider.js";
import { applyAccessDecisions } from "../shared/building/access.js";
import { edgeIssue, segmentProblem } from "../shared/building/validation.js";
import { roomAvailability, routeBuilding } from "../shared/building/routing.js";
import { sourceFeatureId } from "../shared/building/preparation.js";
import { clone } from "../shared/map.js";
import { accessFixture } from "./fixtures/access-fixture.js";
const base = await accessFixture();
base.floors[0].sources[0].geometryIds = ["spaces", "walls", "doors", "pois"].flatMap(k => base.floors[0].geometry[k].map(x => x.id));
const cache = () => join(tmpdir(), `smart-map-${crypto.randomUUID()}`);
const message = body => ({ status: "completed", usage: { total_tokens: 100 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(body) }] }] });
const response = body => new Response(JSON.stringify(body), { status: 200 });
function fake({ misread = false } = {}) {
  let calls = 0, extractions = 0;
  const provider = new OpenAIProvider({ apiKey: "fixture-key", fetchImpl: async (_, { body }) => {
    calls++; const request = JSON.parse(body), name = request.text.format.name;
    if (name === "space_inventory") return response(message({ items: [
      { label: "101", kind: "room", position: { x: 50, y: 50 } }, { label: "103", kind: "room", position: { x: 250, y: 50 } },
    ], footprints: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 140 }, { x: 0, y: 140 }]], notes: [] }));
    if (name === "floor_plan") {
      extractions++;
      if (misread && extractions > 1) return response(message({ floorName: "Synthetic repair", spaces: [{
        ...base.floors[0].geometry.spaces.find(s => s.id === "fx:a"),
        polygon: base.floors[0].geometry.spaces.find(s => s.id === "fx:a").polygon.map(p => ({ x: p.x * 7, y: p.y * 7 })),
      }], doors: [], walls: [], pois: [], issues: [] }));
      // The 400x150 source crop is enlarged 2.5x; put geometry in crop pixels.
      const p = { floorName: "Synthetic", spaces: base.floors[0].geometry.spaces.filter(s => ["fx:a", "fx:c", "fx:corridor"].includes(s.id)).map(s => ({ ...s, polygon: s.polygon.map(p => ({ x: p.x * 2.5, y: p.y * 2.5 })) })),
        doors: base.floors[0].geometry.doors.filter(d => ["fx:door-a", "fx:door-c"].includes(d.id)).map(d => ({ ...d, a: { x: d.a.x * 2.5, y: d.a.y * 2.5 }, b: { x: d.b.x * 2.5, y: d.b.y * 2.5 } })), walls: [], pois: [], issues: [] };
      if (misread) p.spaces.find(s => s.id === "fx:a").label = "107";
      return response(message(p));
    }
    if (name === "opening_batch") return response(message({ checks: request.input[0].content.filter(c => c.type === "input_text" && c.text.startsWith("Candidate ")).map(c => ({ doorId: c.text.split(" ")[1].replace(/\.$/, ""), observed: "door", explanation: "Synthetic source swing arc" })) }));
    assert.fail(name);
  } });
  return { provider, calls: () => calls };
}

test("local vector decoding honors transforms, form saves and curves without treating curves as walls", () => {
  const ops = { fnArray: [OPS.transform, OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath], argsArray: [
    [2, 0, 0, 2, 10, 20], [], [1, 0, 0, 1, 5, 7],
    [OPS.stroke, [new Float32Array([0,0,0,1,10,0,2,12,1,13,2,14,3,1,20,3])]], [],
    [OPS.stroke, [new Float32Array([0,0,0,1,0,10])]],
  ] };
  const result = vectorLines(ops, [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(result.segments[0], { a: { x: 20, y: 34 }, b: { x: 40, y: 34 } });
  assert.deepEqual(result.segments.at(-1), { a: { x: 10, y: 20 }, b: { x: 10, y: 40 } });
  assert.equal(result.curves, 1);
  assert.equal(result.segments.length, 3);
  assert.equal(tileVectorHints(result, { x: 0, y: 0, width: 50, height: 50 }).length, 2);
});

test("cold hybrid job builds a source proposal, verifies doors, imports via access transaction and routes; warm run makes zero calls", async () => {
  const b = clone(base), f = b.floors[0];
  for (const key of ["spaces", "doors", "walls", "pois"]) f.geometry[key] = [];
  b.nodes = []; b.edges = []; f.geometryStatus = "draft";
  const before = JSON.stringify(b), { provider, calls } = fake(), cacheDir = cache();
  const options = { floorIds: ["fx"], rebuild: true, maxCalls: 6, maxDetailTiles: 2 };
  const result = await runSmartMap(b, options, { provider, cacheDir });
  assert.equal(JSON.stringify(b), before);
  assert.equal(result.stats.calls, 3, JSON.stringify(result.queue));
  assert.equal(result.summary.validationErrors, 0);
  assert.equal(result.proposals[0].appliedPreview, true, JSON.stringify(result.queue));
  assert.equal(result.summary.ready, 2, JSON.stringify(result.queue));
  const p = result.proposals[0], applied = applyAccessDecisions(b, "fx", [{ op: "replace-source", ...p }], { reviewer: "Pipeline", reviewStatus: "agent-inspected" }).building;
  const [a, z] = applied.floors[0].geometry.spaces.filter(s => s.kind === "room");
  assert.ok(routeBuilding(applied, a.id, z.id));
  assert.ok(applied.floors[0].access.records.every(r => r.review.status === "agent-inspected"));
  const warm = await runSmartMap(b, options, { provider, cacheDir });
  assert.equal(warm.stats.calls, 0); assert.equal(warm.stats.cacheHits, 2);
  assert.equal(warm.stats.openingCacheHits, 2); assert.equal(calls(), 3);
  assert.equal(warm.summary.ready, 2);
});

test("unverified imported doors cannot acquire legacy access and unsupported checks remain queued", async () => {
  const { provider } = fake(); const b = clone(base);
  const result = await runSmartMap(b, { floorIds: ["fx"], rebuild: true, maxDoorBatches: 0 }, { provider, cacheDir: cache() });
  const p = result.proposals[0];
  assert.ok(p.queue.some(x => x.type === "opening"), JSON.stringify(p.queue));
  const applied = applyAccessDecisions(b, "fx", [{ op: "replace-source", ...p }], { reviewer: "Pipeline" }).building;
  const source = b.floors[0].sources[0];
  assert.ok(applied.floors[0].geometry.doors.filter(d => d.id.startsWith(source.id + ":")).every(d => applied.floors[0].access.records.some(r => r.doorId === d.id && r.status === "proposed")));
  assert.ok(roomAvailability(applied).filter(r => r.id.startsWith(source.id + ":")).every(r => !r.ready));
});

test("global call cap preserves extraction; resume reuses it; cancelled jobs do not call the provider", async () => {
  const { provider } = fake(), cacheDir = cache();
  const limited = await runSmartMap(base, { floorIds: ["fx"], rebuild: true, maxCalls: 2 }, { provider, cacheDir });
  assert.equal(limited.stats.calls, 2); assert.equal(limited.status, "limited", JSON.stringify(limited.queue));
  assert.ok(limited.proposals[0].map.spaces.length);
  const resumed = await runSmartMap(base, { floorIds: ["fx"], rebuild: true, maxCalls: 2 }, { provider, cacheDir });
  assert.equal(resumed.stats.calls, 1); assert.equal(resumed.stats.cacheHits, 2);
  const controller = new AbortController(); controller.abort();
  const cancelled = await runSmartMap(base, { floorIds: ["fx"] }, { provider, cacheDir: cache(), signal: controller.signal });
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.stats.calls, 0);
});

test("global budget includes retries, token overrun and request cancellation", async () => {
  const stats = { calls: 0, tokens: 0, cacheHits: 0 };
  const provider = { name: "Synthetic", model: "m", async respond(_, options) {
    assert.ok(options.timeout <= 1000); assert.ok(options.signal);
    return message({ ok: true });
  } };
  const wrapped = budgetProvider(provider, { deadlineMs: 1000, maxCalls: 4, maxTokens: 50 }, { stats, cacheDir: cache() });
  await wrapped.respond({ input: "one" });
  await assert.rejects(() => wrapped.respond({ input: "two" }), /token budget/);
  assert.equal(stats.calls, 1);
});

test("edited polylines cannot cross rejected or stale doors internally, in either direction or at bends", () => {
  const b = applyAccessDecisions(base, "fx", [140, 180].map((x,i) => ({ op: "opening", record: {
    id: `fx:test-${i}`, kind: "opening", status: "accepted", spaceId: "fx:b", doorId: `fx:test-door-${i}`,
    openingType: "door", adjacentIds: ["fx:b", "fx:corridor"], segment: { a: { x, y: 100 }, b: { x: x + 10, y: 100 } },
    reason: "Synthetic", evidence: { method: "manual", description: "Fixture only", crops: [] },
  } })), { reviewer: "Test" }).building;
  const f = b.floors[0], a = { x: 145, y: 80 }, z = { x: 145, y: 120 };
  assert.equal(segmentProblem(f, a, z), null);
  for (const status of ["rejected", "proposed"]) {
    f.access.records.forEach(r => r.status = status);
    for (const [from, to] of [[a,z], [z,a], [a,{x:145,y:100}], [{x:145,y:100},z]])
      assert.match(segmentProblem(f, from, to), /unusable doorway/);
    assert.equal(segmentProblem(f, {x:10,y:120}, {x:390,y:120}), null);
  }
});


test("a missed inventory label triggers a focused original-source repair without repeating completed tiles", async () => {
  const { provider } = fake({ misread: true });
  const result = await runSmartMap(base, { floorIds: ["fx"], rebuild: true, maxDoorBatches: 0 }, { provider, cacheDir: cache() });
  const p = result.proposals[0];
  assert.equal(result.stats.calls, 3); // inventory, detail, one focused repair
  assert.ok(p.map.spaces.some(s => s.label === "101"));
  assert.ok(!p.map.spaces.some(s => s.label === "107"));
  assert.ok(p.coverage.items.find(i => i.label === "101").spaceId);
  assert.ok(!p.coverage.items.some(i => i.label === "107"));
});

test("durable job recovery and apply detect geometry, access and graph edits while preserving presentation edits", async () => {
  const { atomicJson } = await import("../server/pipelines/smart-map.js"),
    { getMapJob, applyMapJob } = await import("../server/map-jobs.js"),
    { rm } = await import("node:fs/promises"), id = crypto.randomUUID(), dir = `.local/map-jobs/${id}`;
  const { provider } = fake();
  const result = await runSmartMap(base, { floorIds: ["fx"], rebuild: true }, { provider, cacheDir: cache() });
  try {
    await atomicJson(`${dir}/state.json`, { id, status: "running", progress: {} });
    const interrupted = await getMapJob(id);
    assert.equal(interrupted.status, "interrupted");
    assert.match(interrupted.progress.message, /resume/);
    await atomicJson(`${dir}/state.json`, { id, status: result.status, result });
    for (const edit of [b => b.floors[0].revision++, b => b.floors[0].sources[0].transform[4]++, b => b.floors[0].access.records.push({ id: "new-evidence" }), b => b.edges[0].restricted = true]) {
      const changed = clone(base); edit(changed);
      await assert.rejects(() => applyMapJob(id, changed), /changed after this run/);
    }
    const styled = clone(base); styled.floors[0].presentation.title = "My custom title";
    const applied = await applyMapJob(id, styled);
    assert.equal(applied.building.floors[0].presentation.title, "My custom title");
    assert.equal(JSON.stringify(base).includes("fixture-key"), false);
    assert.equal(JSON.stringify(result).includes("fixture-key"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("draft route checks retain blocked proposal evidence instead of treating it as legacy access", async () => {
  const { checkRouteAccess } = await import("../shared/building/access.js");
  const b = applyAccessDecisions(base, "fx", [{ op: "opening", record: {
    id: "fx:route-record", kind: "opening", status: "accepted", spaceId: "fx:b", doorId: "fx:route-door",
    openingType: "door", adjacentIds: ["fx:b", "fx:corridor"], segment: { a: { x: 140, y: 100 }, b: { x: 150, y: 100 } },
    reason: "Synthetic", evidence: { method: "manual", description: "Fixture only", crops: [] },
  } }], { reviewer: "Fixture" }).building;
  b.floors[0].access.records[0].status = "proposed";
  const before = JSON.stringify(b);
  assert.equal(checkRouteAccess(b, "fx", b.floors[0].geometry, ["fx:b"]).passed, false);
  assert.equal(JSON.stringify(b), before);
});

test("analytical corridor joins get their own seam question and become decomposition joins, never width-limited doors", async () => {
  const b = clone(base), f = b.floors[0];
  for (const key of ["spaces", "doors", "walls", "pois"]) f.geometry[key] = [];
  b.nodes = []; b.edges = []; f.geometryStatus = "draft";
  const prompts = [], k = p => ({ x: p.x * 2.5, y: p.y * 2.5 }),
    rect = (id, label, kind, x0, y0, x1, y1) => ({ id, label, kind, confidence: 1, polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map(k) });
  const provider = new OpenAIProvider({ apiKey: "fixture-key", fetchImpl: async (_, { body }) => {
    const request = JSON.parse(body), name = request.text.format.name;
    if (name === "space_inventory") return response(message({ items: [{ label: "101", kind: "room", position: { x: 200, y: 60 } }],
      footprints: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 120 }, { x: 0, y: 120 }]], notes: [] }));
    if (name === "floor_plan") return response(message({ floorName: "Synthetic", walls: [], pois: [], issues: [],
      // A corridor ring around one room: the ring's hole forces decomposition into joined pieces.
      spaces: [rect("r1", "101", "room", 20, 20, 380, 100), rect("c1", "Corridor", "corridor", 0, 0, 400, 20), rect("c2", "Corridor", "corridor", 0, 100, 400, 120),
        rect("c3", "Corridor", "corridor", 0, 20, 20, 100), rect("c4", "Corridor", "corridor", 380, 20, 400, 100)],
      doors: [{ id: "d1", label: "Door", a: k({ x: 190, y: 20 }), b: k({ x: 200, y: 20 }), spaceIds: ["r1", "c1"], confidence: 1 }] }));
    if (name === "opening_batch") {
      const intro = request.input[0].content[0].text, ids = request.input[0].content.filter(c => c.type === "input_text" && c.text.startsWith("Candidate ")).map(c => c.text.split(" ")[1].replace(/\.$/, ""));
      prompts.push({ join: intro.startsWith("Each highlighted segment is an analytical seam"), ids });
      return response(message({ checks: ids.map(doorId => ({ doorId, observed: intro.startsWith("Each") ? "open-passage" : "door", explanation: "Synthetic" })) }));
    }
    if (name === "region_semantics") return response(message({ regions: [], stairs: [], issues: [] }));
    assert.fail(name);
  } });
  const result = await runSmartMap(b, { floorIds: ["fx"], rebuild: true, maxCalls: 8, maxDetailTiles: 1 }, { provider, cacheDir: cache() });
  const joinBatches = prompts.filter(p => p.join);
  assert.ok(joinBatches.length, JSON.stringify(prompts));
  assert.ok(prompts.every(p => p.ids.every(id => id.includes("coverage-open-") === p.join)), JSON.stringify(prompts));
  const joins = result.proposals[0].records.filter(r => r.doorId?.includes("coverage-open-"));
  assert.ok(joins.length && joins.every(r => r.openingType === "decomposition-join"), JSON.stringify(joins.map(r => r.openingType)));
});

test("a transient network failure gets one budgeted retry; a second failure is reported", async () => {
  const stats = { calls: 0, tokens: 0, cacheHits: 0 };
  let n = 0;
  const flaky = { name: "Synthetic", model: "m", async respond() {
    if (n++ === 0) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return message({ ok: true });
  } };
  const wrapped = budgetProvider(flaky, { deadlineMs: 5000, maxCalls: 4, maxTokens: 10000 }, { stats, cacheDir: cache() });
  await wrapped.respond({ input: "retry-me" });
  assert.equal(stats.calls, 2);
  const dead = { name: "Synthetic", model: "m", async respond() { throw new TypeError("fetch failed"); } };
  const stats2 = { calls: 0, tokens: 0, cacheHits: 0 };
  await assert.rejects(() => budgetProvider(dead, { deadlineMs: 5000, maxCalls: 4, maxTokens: 10000 }, { stats: stats2, cacheDir: cache() }).respond({ input: "x" }), /fetch failed/);
  assert.equal(stats2.calls, 2);
});

test("detail tiles are ranked by newly covered labels, so clamped near-duplicates cannot crowd out distinct area", () => {
  // Rows at y=0 and a clamped y=50 both contain the dense west labels; a sparse
  // east area is only in the x=650 column and must be detailed before the duplicate.
  const items = [];
  for (let x = 120; x <= 480; x += 130) for (let y = 120; y <= 480; y += 130) items.push({ label: `${x}-${y}`, kind: "room", position: { x, y } });
  items.push({ label: "east-1", kind: "room", position: { x: 1150, y: 300 } }, { label: "east-2", kind: "room", position: { x: 1180, y: 320 } });
  const tiles = footprintTiles({ width: 1300, height: 700 }, { items, footprints: [[{ x: 10, y: 10 }, { x: 1240, y: 10 }, { x: 1240, y: 640 }, { x: 10, y: 640 }]] }, { segments: [], labels: [] });
  const east = tiles.findIndex(t => t.x + t.width >= 1200), duplicate = tiles.findIndex((t, i) => i > 0 && t.x === tiles[0].x);
  assert.equal(tiles[0].x, 0);
  assert.ok(east < duplicate, JSON.stringify(tiles));
});

test("a detail that runs out of output room is read again as two overlapping halves", async () => {
  const b = clone(base), f = b.floors[0];
  for (const key of ["spaces", "doors", "walls", "pois"]) f.geometry[key] = [];
  b.nodes = []; b.edges = []; f.geometryStatus = "draft";
  const g = base.floors[0].geometry, crops = [];
  let details = 0;
  const provider = new OpenAIProvider({ apiKey: "fixture-key", fetchImpl: async (_, { body }) => {
    const request = JSON.parse(body), name = request.text.format.name;
    if (name === "space_inventory") return response(message({ items: [{ label: "101", kind: "room", position: { x: 50, y: 50 } }],
      footprints: [[{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 140 }, { x: 0, y: 140 }]], notes: [] }));
    if (name === "floor_plan") {
      crops.push(request.input[0].content[0].text.match(/width (\d+), height (\d+)/).slice(1).map(Number));
      if (details++ === 0) return response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { total_tokens: 16000 }, output: [] });
      return response(message({ floorName: "Half", walls: [], pois: [], issues: [], doors: [],
        spaces: g.spaces.filter(s => s.id === "fx:a").map(s => ({ ...s, polygon: s.polygon.map(p => ({ x: p.x * 2.5, y: p.y * 2.5 })) })) }));
    }
    if (name === "opening_batch") return response(message({ checks: [] }));
    if (name === "region_semantics") return response(message({ regions: [], stairs: [], issues: [] }));
    assert.fail(name);
  } });
  const result = await runSmartMap(b, { floorIds: ["fx"], rebuild: true, maxCalls: 8, maxDetailTiles: 1, maxRepairTiles: 0 }, { provider, cacheDir: cache() });
  assert.equal(details, 3, JSON.stringify(result.proposals[0].tileFailures)); // the full tile, then two halves
  assert.ok(crops[1][0] < crops[0][0] && crops[2][0] < crops[0][0], JSON.stringify(crops));
  assert.deepEqual(result.proposals[0].tileFailures, []);
  assert.ok(result.stats.tokens >= 16000, "the incomplete response's usage is counted");
});

test("a tile crowded with labels is split before any request, and edge labels pull the tile outward", () => {
  const items = [];
  for (let x = 1700; x < 2000; x += 40) for (let y = 740; y < 1120; y += 60) items.push({ label: `${x}-${y}`, kind: "room", position: { x, y } });
  items.push({ label: "edge", kind: "room", position: { x: 1760, y: 640 } }); // leader label above a rough footprint
  const footprint = [{ x: 1650, y: 700 }, { x: 2000, y: 700 }, { x: 2000, y: 1130 }, { x: 1650, y: 1130 }];
  const tiles = footprintTiles({ width: 2400, height: 1553 }, { items, footprints: [footprint] }, { segments: [], labels: [] });
  const inside = (t, p) => p.x >= t.x && p.x <= t.x + t.width && p.y >= t.y && p.y <= t.y + t.height;
  assert.ok(tiles.length > 1, JSON.stringify(tiles));
  assert.ok(tiles.every(t => items.filter(i => inside(t, i.position)).length <= 14 || Math.max(t.width, t.height) < 300), JSON.stringify(tiles));
  assert.ok(items.every(i => tiles.some(t => inside(t, i.position))), "every label is in some tile");
  assert.ok(tiles.some(t => t.y <= 640));
  const [a, b] = splitTile({ x: 0, y: 0, width: 600, height: 400 });
  assert.deepEqual([a.x, a.width, b.x, b.width], [0, 360, 240, 360]);
});
