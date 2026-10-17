import { hasWaterloo, waterlooText, wtest } from "./fixtures/optional.js";
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { clone, distance, pointSegment } from "../shared/map.js";
import { parseBuilding } from "../shared/building/schema.js";
import {
  validateOpening,
  applyAccessDecisions,
  accessInventory,
  regionBoundary,
  cutWallGap,
  newAccessRecord,
} from "../shared/building/access.js";
import {
  spaceAccessState,
  doorAccessState,
  reconcileAccessFlags,
} from "../shared/building/access-state.js";
import { roomDoorNodes } from "../shared/building/endpoints.js";
import { routeBuilding, roomAvailability } from "../shared/building/routing.js";
import { edgeIssue, nodeProblem } from "../shared/building/validation.js";
import { buildGraph, revalidateGraph } from "../shared/building/graph.js";
import { exportPackage, importPackage } from "../shared/building/export.js";
import { renderSourceCrop } from "../server/pipelines/source-crops.js";
import { accessFixture, rect } from "./fixtures/access-fixture.js";

const base = await accessFixture();
const floor = (b) => b.floors[0];
const evidence = {
  method: "manual",
  description: "Synthetic fixture: door arc drawn in the shared wall.",
  crops: [],
};
const opening = (fields) => ({
  op: "opening",
  record: {
    id: `fx:record:${fields.doorId}`,
    kind: "opening",
    status: "accepted",
    openingType: "door",
    label: "Fixture door",
    reason: "Visible door arc",
    evidence,
    ...fields,
  },
});
const accept = (b, decisions) =>
  applyAccessDecisions(b, "fx", decisions, {
    reviewer: "Test reviewer",
    notes: "Synthetic",
  }).building;

test("valid door on a shared boundary passes; model coordinates snap only within tolerance (tile seams)", () => {
  const f = floor(base);
  const ok = validateOpening(f, {
    spaceId: "fx:b",
    adjacentId: "fx:corridor",
    openingType: "door",
    a: { x: 140, y: 101.5 },
    b: { x: 150, y: 98.8 },
  });
  assert.equal(ok.passed, true, JSON.stringify(ok.failures));
  assert.deepEqual(ok.segment, { a: { x: 140, y: 100 }, b: { x: 150, y: 100 } });
  const seam = validateOpening(f, {
    spaceId: "fx:b",
    adjacentId: "fx:corridor",
    openingType: "door",
    a: { x: 140, y: 104 },
    b: { x: 150, y: 104 },
  });
  assert.equal(seam.passed, false);
  assert.ok(seam.failures.some((x) => x.code === "off-boundary"));
});

test("negative evidence cases are rejected with structured failures", () => {
  const f = floor(base),
    codes = (c) =>
      validateOpening(f, { openingType: "door", ...c }).failures.map((x) => x.code);
  // A wall between B and A is not a boundary with the corridor.
  assert.ok(
    codes({ spaceId: "fx:b", adjacentId: "fx:corridor", a: { x: 100, y: 40 }, b: { x: 100, y: 50 } }).includes("off-boundary"),
  );
  assert.ok(codes({ spaceId: "fx:b", adjacentId: "fx:nope", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }).includes("reference"));
  assert.ok(codes({ spaceId: "fx:b", adjacentId: "fx:b", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }).includes("reference"));
  assert.ok(codes({ spaceId: "fx:b", adjacentId: "fx:corridor", a: { x: 110, y: 100 }, b: { x: 190, y: 100 } }).includes("width"));
  assert.ok(codes({ spaceId: "fx:b", adjacentId: "fx:corridor", a: { x: 140, y: 100 }, b: { x: 140.5, y: 100 } }).includes("degenerate"));
  assert.ok(codes({ spaceId: "fx:b", adjacentId: "fx:corridor", a: { x: 195, y: 100 }, b: { x: 205, y: 100 } }).includes("outside-boundary"));
  assert.ok(codes({ spaceId: "fx:f", adjacentId: "fx:corridor", a: { x: 160, y: 140 }, b: { x: 170, y: 140 } }).includes("nonwalkable"));
  assert.ok(codes({ spaceId: "fx:a", adjacentId: "fx:corridor", a: { x: 42, y: 100 }, b: { x: 52, y: 100 } }).includes("overlaps-door"));
  assert.ok(codes({ spaceId: "fx:b", adjacentId: null, a: { x: 140, y: 100 }, b: { x: 150, y: 100 } }).includes("type"));
  assert.ok(
    validateOpening(f, { spaceId: "fx:b", adjacentId: null, openingType: "exterior-door", a: { x: 140, y: 100 }, b: { x: 150, y: 100 } })
      .failures.some((x) => x.code === "not-exterior"),
  );
  assert.equal(
    validateOpening(f, { spaceId: "fx:b", adjacentId: null, openingType: "exterior-door", a: { x: 140, y: 0 }, b: { x: 150, y: 0 } }).passed,
    true,
  );
  assert.equal(
    validateOpening(f, { spaceId: "fx:b", openingType: "door", a: { x: NaN, y: 0 }, b: { x: 1, y: 1 } }).failures[0].code,
    "coordinates",
  );
});

test("a wall without a door stays blocked even when connectivity would improve", () => {
  assert.equal(spaceAccessState(floor(base), floor(base).geometry.spaces[2]).status, "unknown");
  assert.equal(roomDoorNodes(base, "fx:b").length, 0);
  assert.equal(routeBuilding(base, "fx:a", "fx:b"), null);
  const rooms = roomAvailability(base);
  assert.equal(rooms.find((r) => r.id === "fx:b").ready, false);
  assert.match(rooms.find((r) => r.id === "fx:b").reason, /Doorway not verified/);
  // A hand-added door without accepted evidence does not clear unknown access.
  const b = clone(base);
  floor(b).geometry.doors.push({
    id: "fx:hand",
    label: "Hand-drawn",
    a: { x: 140, y: 100 },
    b: { x: 150, y: 100 },
    spaceIds: ["fx:b", "fx:corridor"],
    confidence: 1,
  });
  assert.equal(reconcileAccessFlags(floor(b).geometry, floor(b)).length, 0);
  assert.equal(floor(b).geometry.spaces.find((s) => s.id === "fx:b").access, "unknown");
});

test("accepting a validated opening cuts the wall gap, clears unknown access, rebuilds paths and routes", () => {
  const b = accept(base, [
    opening({
      spaceId: "fx:b",
      doorId: "fx:door-b",
      adjacentIds: ["fx:b", "fx:corridor"],
      segment: { a: { x: 140, y: 100 }, b: { x: 150, y: 100 } },
    }),
  ]);
  const f = floor(b),
    door = f.geometry.doors.find((d) => d.id === "fx:door-b");
  assert.ok(door);
  assert.equal(f.geometry.spaces.find((s) => s.id === "fx:b").access, undefined);
  assert.equal(doorAccessState(f, door).state, "verified");
  // No wall remains across the opening; neighbouring wall pieces remain.
  const mid = { x: 145, y: 100 };
  assert.ok(!f.geometry.walls.some((w) => pointSegment(mid, w.points[0], w.points.at(-1)) < 0.1));
  assert.ok(f.geometry.walls.some((w) => pointSegment({ x: 120, y: 100 }, w.points[0], w.points.at(-1)) < 0.1));
  const r = routeBuilding(b, "fx:a", "fx:b");
  assert.ok(r);
  assert.equal(b.nodes.find((n) => n.id === r.endNode).doorId, "fx:door-b");
  assert.ok(r.steps.every((s) => !edgeIssue(b, b.edges.find((e) => e.id === s.edgeId))));
  assert.equal(f.revision, floor(base).revision + 1);
  assert.equal(f.access.records[0].review.reviewer, "Test reviewer");
  assert.equal(f.access.records[0].validation.routeCheck.passed, true);
});

test("evidence records survive schema parsing, JSON and ZIP roundtrips", async () => {
  const b = accept(base, [
    opening({
      spaceId: "fx:b",
      doorId: "fx:door-b",
      adjacentIds: ["fx:b", "fx:corridor"],
      segment: { a: { x: 140, y: 100 }, b: { x: 150, y: 100 } },
      evidence: {
        ...evidence,
        method: "ai-agent",
        provider: "OpenAI",
        model: "gpt-6.1-sol",
        promptVersion: "p",
        schemaVersion: "s",
        confidence: 0.8,
        crops: [
          {
            scale: "detail",
            sourceId: "fx-source",
            sourceHash: "h",
            assetHash: "h",
            originalAssetHash: "h",
            renderer: "normalized-raster",
            page: null,
            rotation: 0,
            sourceRect: { x: 1, y: 2, width: 3, height: 4 },
            floorRect: { x: 1, y: 2, width: 3, height: 4 },
            transform: [1, 0, 0, 1, 0, 0],
            pixelsPerSourcePixel: 8,
          },
        ],
        verifier: { verdict: "supported", observed: "door: arc", provider: "OpenAI", model: "gpt-6.1-sol" },
      },
    }),
  ]);
  const json = parseBuilding(JSON.parse(JSON.stringify(b)));
  assert.deepEqual(json.floors[0].access, b.floors[0].access);
  const zip = await importPackage(await exportPackage(b));
  const record = zip.floors[0].access.records[0];
  assert.equal(record.evidence.model, "gpt-6.1-sol");
  assert.equal(record.evidence.crops[0].pixelsPerSourcePixel, 8);
  assert.equal(record.evidence.verifier.verdict, "supported");
  assert.equal(record.validation.passed, true);
});

test("stale verified doors and rejected doors are blocked in both directions", () => {
  const b = accept(base, [
    opening({
      spaceId: "fx:b",
      doorId: "fx:door-b",
      adjacentIds: ["fx:b", "fx:corridor"],
      segment: { a: { x: 140, y: 100 }, b: { x: 150, y: 100 } },
    }),
  ]);
  // Door edited after its evidence: stale, not routable, and reconciled back to unknown.
  const moved = clone(b),
    f = floor(moved),
    d = f.geometry.doors.find((d) => d.id === "fx:door-b");
  d.a = { x: 120, y: 100 };
  d.b = { x: 130, y: 100 };
  assert.equal(doorAccessState(f, d).state, "stale");
  const node = moved.nodes.find((n) => n.doorId === "fx:door-b");
  assert.ok(nodeProblem(moved, node));
  assert.equal(roomDoorNodes(moved, "fx:b").length, 0);
  assert.equal(routeBuilding(moved, "fx:a", "fx:b"), null);
  assert.equal(routeBuilding(moved, "fx:b", "fx:a"), null);
  assert.deepEqual(reconcileAccessFlags(f.geometry, f), [
    { spaceId: "fx:b", from: "known", to: "unknown" },
  ]);
  // Rejecting a legacy door removes access rather than leaving a normal-looking room.
  const rejected = clone(base);
  floor(rejected).access.records.push(
    newAccessRecord({
      id: "fx:reject-a",
      kind: "rejected-door",
      status: "accepted",
      spaceId: "fx:a",
      doorId: "fx:door-a",
      reason: "Conflicts with source",
      evidence,
      geometryRevision: 1,
    }),
  );
  assert.equal(roomDoorNodes(rejected, "fx:a").length, 0);
  assert.equal(spaceAccessState(floor(rejected), floor(rejected).geometry.spaces[1]).status, "missing");
  const removed = accept(base, [
    {
      op: "reject-door",
      doorId: "fx:door-c",
      record: { id: "fx:reject-c", kind: "rejected-door", status: "accepted", spaceId: "fx:c", reason: "Not in source", evidence },
    },
    opening({
      spaceId: "fx:c",
      doorId: "fx:door-c2",
      adjacentIds: ["fx:c", "fx:corridor"],
      segment: { a: { x: 270, y: 100 }, b: { x: 280, y: 100 } },
    }),
  ]);
  assert.ok(!floor(removed).geometry.doors.some((d) => d.id === "fx:door-c"));
  assert.ok(floor(removed).geometry.walls.some((w) => pointSegment({ x: 245, y: 100 }, w.points[0], w.points.at(-1)) < 0.1));
  assert.equal(routeBuilding(removed, "fx:a", "fx:c").endNode, "fx:door-c2:nav");
});

test("internal suite doors, multiple entrances and an open corridor join route room-to-room", () => {
  const b = accept(base, [
    {
      op: "carve",
      space: { id: "fx:d1", label: "104A", kind: "room", polygon: rect(370, 0, 400, 40), confidence: 1 },
      record: { id: "fx:carve-d1", kind: "classification", status: "accepted", spaceId: "fx:d1", reason: "Inner office", evidence },
    },
    opening({
      spaceId: "fx:d1",
      doorId: "fx:door-d1",
      adjacentIds: ["fx:d1", "fx:d"],
      segment: { a: { x: 370, y: 20 }, b: { x: 370, y: 28 } },
    }),
    opening({
      spaceId: "fx:d",
      doorId: "fx:door-d-second",
      adjacentIds: ["fx:d", "fx:corridor"],
      segment: { a: { x: 310, y: 100 }, b: { x: 320, y: 100 } },
    }),
  ]);
  const d = floor(b).geometry.spaces.find((s) => s.id === "fx:d");
  assert.equal(d.label, "104 / 104X");
  assert.ok(!d.polygon.some((p) => p.x > 370 && p.y < 40));
  assert.equal(roomDoorNodes(b, "fx:d").length, 3);
  const r = routeBuilding(b, "fx:a", "fx:d1");
  assert.ok(r);
  assert.equal(b.nodes.find((n) => n.id === r.endNode).doorId, "fx:door-d1");
  assert.ok(r.steps.some((s) => s.edgeId.includes("fx:d:door-link")));
  // Analytical join inside one corridor: no width limit, not a door.
  assert.equal(
    validateOpening(floor(base), {
      spaceId: "fx:corridor-2",
      adjacentId: "fx:corridor",
      openingType: "decomposition-join",
      a: { x: 250, y: 140 },
      b: { x: 400, y: 140 },
    }).failures.some((f) => f.code === "width"),
    false,
  );
  assert.ok(routeBuilding(base, "fx:a", "fx:c"));
});

test("concave regions validate the correct side of each edge", () => {
  const f = floor(base);
  const inner = validateOpening(f, {
    spaceId: "fx:e",
    adjacentId: "fx:f",
    openingType: "door",
    a: { x: 150, y: 150 },
    b: { x: 150, y: 160 },
  });
  assert.ok(inner.failures.some((x) => x.code === "nonwalkable"));
  const boundary = regionBoundary(f, "fx:e");
  assert.equal(boundary.edges.length, 6);
  assert.ok(boundary.edges[0].neighbours.some((n) => n.spaceId === "fx:corridor"));
  const exterior = validateOpening(f, {
    spaceId: "fx:e",
    adjacentId: null,
    openingType: "exterior-door",
    a: { x: 80, y: 220 },
    b: { x: 80, y: 230 },
  });
  assert.equal(exterior.passed, true, JSON.stringify(exterior.failures));
});

test("access inventory separates inventory, geometry, access and routing tiers", () => {
  const inv = accessInventory(base, roomAvailability(base)).floors[0];
  assert.equal(inv.regions, 8);
  assert.equal(inv.nonwalkable, 1);
  assert.equal(inv.unknown, 1);
  assert.equal(inv.queue[0].spaceId, "fx:b");
  assert.ok(inv.ready < inv.destinations);
});

test("wall gaps cut only collinear walls and keep unique IDs", () => {
  const walls = cutWallGap(
    [
      { id: "w", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { id: "v", points: [{ x: 50, y: -10 }, { x: 50, y: -1 }] },
    ],
    { x: 40, y: 0 },
    { x: 60, y: 0 },
  );
  assert.deepEqual(walls.map((w) => w.id), ["w", "w:gap-1", "v"]);
  assert.deepEqual(walls[0].points.at(-1), { x: 40, y: 0 });
  assert.deepEqual(walls[1].points[0], { x: 60, y: 0 });
});

test("source crops keep rotated alignment invertible and evidence coordinates in the floor frame", async () => {
  const rotated = await accessFixture({ transform: [0, 1, -1, 0, 300, 0] });
  const f = floor(rotated),
    r = { x: 120, y: 20, width: 60, height: 50 },
    crop = await renderSourceCrop(rotated, "fx", { rect: r, zoom: 3 });
  assert.equal(crop.metadata.renderer, "normalized-raster");
  for (const p of [{ x: 130, y: 30 }, { x: 170, y: 60 }]) {
    const q = crop.toFloor(crop.toCrop(p));
    assert.ok(distance(p, q) < 1e-6);
  }
  assert.deepEqual(crop.metadata.transform, [0, 1, -1, 0, 300, 0]);
  const meta = await sharp(crop.png).metadata();
  assert.equal(meta.width, crop.metadata.width);
  assert.ok(f.sources[0].transform[1] === 1);
});

wtest("revalidating after edits keeps unknown regions unavailable", () => {
  const b = revalidateGraph(buildGraph(clone(base), "fx"), "fx");
  assert.equal(roomAvailability(b).find((r) => r.id === "fx:b").ready, false);
});

const waterloo = hasWaterloo ? parseBuilding(JSON.parse(waterlooText())) : null;
const handoffRegions = [
  "e2-f1:coverage-space-89", "e2-f1:coverage-space-91", "e2-f1:coverage-space-92",
  "e2-f1:coverage-space-93", "e2-f1:coverage-space-94", "e2-f1:coverage-corridor-1",
  "e2-f2:coverage-space-108", "e2-f2:coverage-space-119", "e2-f2:coverage-space-123",
  "e2-f2:coverage-space-131", "e2-f2:coverage-space-133", "e2-f2:coverage-space-134",
  "e2-f3:coverage-space-80", "e2-f3:coverage-space-94", "e2-f4:stair4412-approach",
];
wtest("every handoff amber region has a recorded, source-backed resolution or explicit unresolved finding", () => {
  for (const id of handoffRegions) {
    const f = waterloo.floors.find((f) => id.startsWith(f.id + ":")),
      s = f.geometry.spaces.find((s) => s.id === id);
    assert.ok(s, `${id} still exists (no silent removal)`);
    const records = f.access.records.filter(
        (r) => r.spaceId === id || r.adjacentIds.includes(id),
      ),
      reviewed = records.filter((r) => r.review.status === "agent-inspected");
    assert.ok(reviewed.length, `${id} has a reviewed record`);
    for (const r of reviewed) {
      assert.equal(r.evidence.method, "direct-visual-inspection");
      assert.ok(r.evidence.crops.some((c) => c.renderer === "pdf-vector" && c.sourceHash === f.sources[0].hash));
      assert.match(r.review.reviewer, /not a human review/);
    }
    const status = spaceAccessState(f, s).status;
    assert.ok(["verified", "nonwalkable", "unresolved"].includes(status), `${id}: ${status}`);
    if (status === "unresolved") assert.equal(s.access, "unknown");
  }
  const unknown = waterloo.floors.flatMap((f) => f.geometry.spaces.filter((s) => s.access === "unknown"));
  assert.deepEqual(unknown.map((s) => s.id).sort(), [
    "e2-f1:coverage-space-92", "e2-f1:coverage-space-94", "e2-f2:coverage-space-119", "e2-f3:coverage-space-94",
  ]);
});

wtest("numbered regions 1822, 2420A, 2336A, 2410A and 3410 have explicit outcomes", () => {
  const f = (id) => waterloo.floors.find((f) => f.id === id),
    space = (fid, id) => f(fid).geometry.spaces.find((s) => s.id === id),
    rooms = roomAvailability(waterloo);
  assert.equal(spaceAccessState(f("e2-f1"), space("e2-f1", "e2-f1:coverage-space-91")).status, "verified");
  assert.equal(spaceAccessState(f("e2-f2"), space("e2-f2", "e2-f2:coverage-space-119")).status, "unresolved");
  assert.match(rooms.find((r) => r.id === "e2-f2:coverage-space-119").reason, /unresolved/);
  assert.equal(space("e2-f2", "e2-f2:coverage-space-134").access, "nonwalkable");
  assert.equal(
    f("e2-f2").sources[0].coverage.items.find((i) => i.label === "2410A").spaceId,
    "e2-f2:coverage-2419-5",
  );
  assert.equal(spaceAccessState(f("e2-f3"), space("e2-f3", "e2-f3:coverage-space-80")).status, "verified");
  // 2336A is an internal suite room entered through 2336B.
  const r = routeBuilding(waterloo, "e2-f2:2340", "e2-f2:coverage-space-131"),
    end = waterloo.nodes.find((n) => n.id === r.endNode);
  assert.deepEqual(end.spaceIds.sort(), ["e2-f2:access-2336B", "e2-f2:coverage-space-131"]);
  assert.ok(rooms.find((r) => r.id === "e2-f2:access-2336B").ready);
  // The misread 3316 ↔ 3411 M door is rejected; 3411 M opens to the corridor alcove.
  assert.ok(!f("e2-f3").geometry.doors.some((d) => d.id === "e2-f3:coverage-door-63"));
  assert.ok(f("e2-f3").access.records.some((r) => r.kind === "rejected-door" && r.doorId === "e2-f3:coverage-door-63"));
  const wc = routeBuilding(waterloo, "e2-f3:3339", "e2-f3:coverage-3411-96");
  assert.ok(waterloo.nodes.find((n) => n.id === wc.endNode).spaceIds.includes("e2-f3:coverage-corridor-0"));
});
