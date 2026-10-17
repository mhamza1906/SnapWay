import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessFixture } from "./fixtures/access-fixture.js";
import { clone, emptyMap } from "../shared/map.js";
import { roomLabels, consolidateCoverage, canonicalizeDoorways } from "../shared/building/coverage.js";
import { sourceGeometry } from "../shared/building/preparation.js";
import { applyAccessDecisions, validateOpening, openingWidthLimit } from "../shared/building/access.js";
import { roomAvailability } from "../shared/building/routing.js";
import { semanticCandidates, verifyRegionSemantics } from "../server/pipelines/region-semantics.js";
import { budgetProvider, openingCheckKey } from "../server/pipelines/smart-map.js";
import { regionNeedsSemanticReview } from "../shared/building/access-state.js";
const base = await accessFixture();
const f = base.floors[0], source = f.sources[0];
source.geometryIds = ["spaces", "walls", "doors", "pois"].flatMap(k => f.geometry[k].map(x => x.id));
const message = data => ({ status: "completed", usage: { total_tokens: 100 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(data) }] }] });

test("numeric room aliases retain short numbers and letter suffixes across overlapping details", () => {
  assert.deepEqual(roomLabels("164 / 164A / 174J; 271 LOWER"), ["164", "164A", "174J", "271"]);
  const first = clone(f.geometry), second = clone(f.geometry);
  first.spaces = first.spaces.filter(s => s.id === "fx:a"); first.doors = []; first.pois = [];
  second.spaces = second.spaces.filter(s => s.id === "fx:a"); second.spaces[0].polygon[1].x = 65; second.spaces[0].polygon[2].x = 65;
  second.doors = []; second.pois = [];
  const result = consolidateCoverage(first.source, [{ map: first }, { map: second }], { inventory: [{ label: "101", position: { x: 40, y: 50 } }] });
  assert.equal(result.map.spaces.filter(s => s.label === "101").length, 1);
  assert.ok(result.coverage.items.find(i => i.label === "101").spaceId);
});

test("door-width sanity checks scale with uploaded source resolution and alignment, without changing legacy limits", () => {
  const b = clone(base), floor = b.floors[0], s = floor.sources[0];
  const candidate = { spaceId: "fx:b", adjacentId: "fx:corridor", openingType: "door", a: { x: 140, y: 100 }, b: { x: 160, y: 100 } };
  s.width = 1280;
  assert.equal(openingWidthLimit(floor, "fx:b", "door"), 14);
  assert.ok(validateOpening(floor, candidate).failures.some(x => x.code === "width"));
  s.width = 2560;
  assert.equal(openingWidthLimit(floor, "fx:b", "door"), 28);
  assert.ok(validateOpening(floor, candidate).passed);
  s.transform = [2,0,0,2,0,0];
  assert.equal(openingWidthLimit(floor, "fx:b", "door"), 56);
});

test("sensitive labels select source inspection; supported voids become nonwalkable through the access transaction", async () => {
  const b = clone(base), floor = b.floors[0], s = floor.sources[0];
  const map = sourceGeometry(floor, s), voidRegion = map.spaces.find(x => x.id === "fx:f");
  voidRegion.label = "177 OPEN TO BELOW"; delete voidRegion.access;
  const selected = semanticCandidates(map, { items: [] });
  assert.ok(selected.some(x => x.id === voidRegion.id));
  const provider = { name: "Fixture", model: "Synthetic", async respond(body) {
    assert.equal(body.text.format.name, "region_semantics");
    assert.equal(body.input[0].content.filter(x => x.type === "input_image").length, 2);
    return message({ checks: [{ spaceId: voidRegion.id, role: "void", explanation: "Synthetic drawing identifies an open-to-below void" }] });
  } };
  const classifications = await verifyRegionSemantics(b, floor, s, map, [voidRegion], provider);
  assert.equal(classifications[0].evidence.verifier.verdict, "supported");
  assert.equal(classifications[0].evidence.crops[0].sourceHash, s.hash);
  const result = applyAccessDecisions(b, floor.id, [{ op: "replace-source", sourceId: s.id, map, classifications }], { reviewer: "Pipeline" });
  const region = result.building.floors[0].geometry.spaces.find(x => x.id === voidRegion.id);
  assert.equal(region.access, "nonwalkable");
  assert.ok(!roomAvailability(result.building).some(x => x.id === region.id));
  const record = result.records.find(x => x.kind === "classification");
  assert.equal(record.review.status, "agent-inspected");
  assert.equal(record.status, "accepted");
  assert.equal(b.floors[0].geometry.spaces.find(x => x.id === region.id).label, "Void");
});

test("uncertain, missing or duplicate semantic checks never enable a classification", async () => {
  const map = sourceGeometry(f, source), s = map.spaces.find(s => s.id === "fx:b");
  for (const checks of [[], [{ spaceId: s.id, role: "unclear", explanation: "Mixed landing and flight" }],
    [{ spaceId: s.id, role: "room", explanation: "one" }, { spaceId: s.id, role: "void", explanation: "two" }]]) {
    const provider = { name: "Fixture", model: "Synthetic", async respond() { return message({ checks }); } };
    const classes = await verifyRegionSemantics(base, f, source, map, [s], provider);
    assert.equal(classes[0].evidence.verifier.verdict, "uncertain");
    assert.deepEqual(classes[0].to, {});
  }
});

test("local-wall extraction can reuse a compatible completed full-wall response", async () => {
  const stats = { calls: 0, tokens: 0, cacheHits: 0 };
  const provider = { name: "Fixture", model: "Synthetic", async respond() { return message({ spaces: [], walls: [] }); } };
  const wrapped = budgetProvider(provider, { deadlineMs: 10000, maxCalls: 4, maxTokens: 1000 }, { stats, cacheDir: join(tmpdir(), `wall-cache-${crypto.randomUUID()}`) });
  const legacy = { input: "same source", max_output_tokens: 24000 };
  await wrapped.respond(legacy);
  await wrapped.respond({ ...legacy, max_output_tokens: 16000 }, { cacheAlternatives: [legacy] });
  assert.equal(stats.calls, 1); assert.equal(stats.cacheHits, 1);
});

test("inventory suffix descriptions map to numeric rooms while stair references remain distinct regions", () => {
  assert.deepEqual(roomLabels("North exit stair at 175B"), []);
  assert.deepEqual(roomLabels("Stair 177A landing"), []);
  const map = clone(f.geometry); map.spaces = map.spaces.filter(s => s.id === "fx:a");
  map.spaces[0].label = "161"; map.doors = []; map.pois = [];
  const result = consolidateCoverage(map.source, [{ map }], { inventory: [{ label: "161 M", kind: "restroom", position: { x: 40, y: 50 } }] });
  assert.ok(result.coverage.items.find(i => i.label === "161 M").spaceId);
});

test("overlapping pipeline transports share an identical request through the disk lease", async () => {
  let nativeCalls = 0;
  const provider = { name: "Fixture", model: "Synthetic", async respond() { nativeCalls++; await new Promise(r => setTimeout(r,80)); return message({ ok: true }); } },
    dir = join(tmpdir(), `pipeline-lease-${crypto.randomUUID()}`),
    statsA = { calls:0, tokens:0, cacheHits:0 }, statsB = { calls:0, tokens:0, cacheHits:0 },
    options = { deadlineMs:10000, maxCalls:4, maxTokens:1000 },
    a = budgetProvider(provider, options, { stats:statsA, cacheDir:dir }), b = budgetProvider(provider, options, { stats:statsB, cacheDir:dir });
  await Promise.all([a.respond({ input:"same source" }), b.respond({ input:"same source" })]);
  assert.equal(nativeCalls,1); assert.equal(statsA.calls+statsB.calls,1); assert.equal(statsA.cacheHits+statsB.cacheHits,1);
});

test("overlapping doorway observations keep physical openings and preserve distinct nearby doors", () => {
  const door = (id, x, z) => ({ id, a:{x,y:100}, b:{x:z,y:100}, spaceIds:["room","hall"], confidence:0.8 });
  const list = canonicalizeDoorways([
    door("coverage-open-0-1",0,100), door("physical",20,30),
    door("duplicate",22,31), door("second",50,60),
  ]);
  assert.deepEqual(list.map(d=>d.id),["physical","second"]);
  assert.deepEqual(canonicalizeDoorways([door("new",20,30),door("existing",20,30)],new Set(["existing"])).map(d=>d.id),["existing"]);
});

test("opening observation cache follows source geometry rather than generated IDs", () => {
  const d = f.geometry.doors[0], provider={name:"Fixture",model:"Synthetic",effort:"high"};
  const key=openingCheckKey(base,source,d,provider);
  assert.equal(openingCheckKey(base,source,{...d,id:"renamed"},provider),key);
  assert.notEqual(openingCheckKey(base,source,{...d,a:{...d.a,x:d.a.x+1}},provider),key);
  assert.notEqual(openingCheckKey(base,source,d,{...provider,model:"Other"}),key);
});

test("mixed stair classification remains blocked when existing source geometry is re-imported", async () => {
  const b=clone(base),floor=b.floors[0],s=floor.sources[0],map=sourceGeometry(floor,s),space=map.spaces.find(x=>x.id==="fx:a");
  const provider={name:"Fixture",model:"Synthetic",async respond(){return message({checks:[{spaceId:space.id,role:"unclear",explanation:"Mixed flight and landing requires splitting"}]});}};
  const classifications=await verifyRegionSemantics(b,floor,s,map,[space],provider);
  const first=applyAccessDecisions(b,floor.id,[{op:"replace-source",sourceId:s.id,map,classifications}],{reviewer:"Pipeline"}).building;
  assert.ok(regionNeedsSemanticReview(first.floors[0],space.id));
  const again=applyAccessDecisions(first,floor.id,[{op:"replace-source",sourceId:s.id,map:sourceGeometry(first.floors[0],s)}],{reviewer:"Pipeline"}).building;
  assert.ok(regionNeedsSemanticReview(again.floors[0],space.id));
});

test("an enclosing observation of the same stair takes the outline without overlap; an enclosed numbered room is never merged away", () => {
  const sq = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const section = spaces => { const m = clone(f.geometry); m.spaces = spaces; m.doors = []; m.pois = []; m.walls = []; return { map: m }; };
  const treads = { id: "s1", label: "Stair near 3008", kind: "lobby", confidence: 1, polygon: sq(130, 20, 170, 60) },
    enclosure = { id: "s2", label: "Stair with landing 3008", kind: "lobby", confidence: 1, polygon: sq(110, 10, 200, 80) };
  const stairs = consolidateCoverage(f.geometry.source, [section([treads]), section([enclosure])],
    { inventory: [{ label: "Stair near 3008", kind: "stair", position: { x: 150, y: 40 } }] });
  const lobbies = stairs.map.spaces.filter(s => s.kind === "lobby");
  assert.equal(lobbies.length, 1);
  assert.equal(lobbies[0].label, "Stair near 3008");
  assert.deepEqual(lobbies[0].polygon.map(p => [p.x, p.y]).sort(), enclosure.polygon.map(p => [p.x, p.y]).sort());
  assert.equal(stairs.coverage.items.find(i => i.label === "Stair near 3008").spaceId, lobbies[0].id);
  assert.ok(stairs.coverage.diagnostics.some(d => d.code === "nested-duplicate"));
  assert.ok(!stairs.coverage.geometryIssues.some(i => /overlap/i.test(i.message)), JSON.stringify(stairs.coverage.geometryIssues));
  const office = { id: "r1", label: "101", kind: "room", confidence: 1, polygon: sq(130, 20, 170, 60) },
    lab = { id: "r2", label: "100", kind: "room", confidence: 1, polygon: sq(110, 10, 200, 80) };
  const nested = consolidateCoverage(f.geometry.source, [section([office]), section([lab])], { inventory: [] });
  assert.ok(nested.map.spaces.some(s => s.label === "101"));
  assert.ok(nested.coverage.diagnostics.some(d => d.code === "overlap" && d.label === "100"));
  assert.ok(!nested.coverage.geometryIssues.some(i => /overlap/i.test(i.message)));
});
