import { hasWaterloo, waterlooText, wtest } from "./fixtures/optional.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { clone, pointSegment, midpoint } from "../shared/map.js";
import { roomDoorNodes } from "../shared/building/endpoints.js";
import { parseBuilding, geometryChanged } from "../shared/building/schema.js";
import {
  applyTransform,
  similarityTransform,
  mergeProposal,
} from "../shared/building/preparation.js";
import {
  routeBuilding,
  roomAvailability,
  routeFailureReason,
} from "../shared/building/routing.js";
import { edgeIssue, validateBuilding } from "../shared/building/validation.js";
import { splitEdge, deleteEdge } from "../shared/building/references.js";
import {
  revalidateGraph,
  buildGraph,
  connectLandings,
  simplifyPath,
} from "../shared/building/graph.js";
import { exportPackage, importPackage } from "../shared/building/export.js";
import { cachedExtraction } from "../server/pipelines/extraction.js";
import { preparePlan } from "../server/pipelines/preparation.js";
const lab = parseBuilding(
    await readFile("public/buildings/routing-fixture.json", "utf8"),
  ),
  waterloo = hasWaterloo ? parseBuilding(waterlooText()) : null;
test("end-wall corridor doors connect to an interior spine without duplicate or wall-bound nodes", () => {
  const b = clone(lab),
    f = b.floors[0];
  b.floors = [f];
  b.nodes = [];
  b.edges = [];
  b.connectors = [];
  b.photos = [];
  const rect = (x, y, r, z) => [
    { x, y },
    { x: r, y },
    { x: r, y: z },
    { x, y: z },
  ];
  f.geometry.spaces = [
    {
      id: "left",
      label: "Left",
      kind: "room",
      polygon: rect(0, 100, 100, 130),
      confidence: 1,
    },
    {
      id: "hall",
      label: "Hall",
      kind: "corridor",
      polygon: rect(100, 100, 300, 130),
      confidence: 1,
    },
    {
      id: "right",
      label: "Right",
      kind: "room",
      polygon: rect(300, 100, 400, 130),
      confidence: 1,
    },
  ];
  f.geometry.doors = [
    {
      id: "left-door",
      label: "Left door",
      a: { x: 100, y: 110 },
      b: { x: 100, y: 120 },
      spaceIds: ["left", "hall"],
      confidence: 1,
    },
    {
      id: "right-door",
      label: "Right door",
      a: { x: 300, y: 110 },
      b: { x: 300, y: 120 },
      spaceIds: ["hall", "right"],
      confidence: 1,
    },
  ];
  f.geometry.walls = [];
  f.geometry.pois = [];
  const result = buildGraph(b, f.id);
  assert.ok(routeBuilding(result, "left", "right"));
  assert.ok(result.edges.every((e) => !edgeIssue(result, e)));
  assert.ok(
    result.nodes
      .filter((n) => n.type === "junction")
      .every((n) => n.position.x > 100 && n.position.x < 300),
  );
});
wtest("Waterloo setup connects every mapped room, including 1731 to 1733 and Floors 1–4", () => {
  assert.deepEqual(
    validateBuilding(waterloo).filter((i) => i.severity === "error"),
    [],
  );
  assert.ok(roomAvailability(waterloo).filter((r) => r.ready).length >= 300);
  assert.ok(
    waterloo.floors.every((f) =>
      f.sources.every((s) =>
        s.coverage?.items.every(
          (i) =>
            i.excluded || f.geometry.spaces.some((r) => r.id === i.spaceId),
        ),
      ),
    ),
  );
  const from = "e2-source-1:s12";
  const r = routeBuilding(waterloo, from, "e2-source-1:s11");
  assert.ok(r);
  assert.deepEqual(r.floorIds, ["e2-f1"]);
  if (!r.steps.length) {
    assert.equal(r.startNode, r.endNode);
    assert.ok(
      waterloo.nodes
        .find((n) => n.id === r.startNode)
        .spaceIds.includes("e2-source-1:s11"),
    );
  }
  // Nearby doors join at their own corridor projections, without a detour
  // to the middle of the long hallway.
  assert.ok(
    r.steps.reduce(
      (sum, s) =>
        sum +
        s.path
          .slice(1)
          .reduce(
            (n, p, i) => n + Math.hypot(p.x - s.path[i].x, p.y - s.path[i].y),
            0,
          ),
      0,
    ) < 180,
  );
  // Check connectivity once across the complete map rather than recomputing
  // the same segment validations in hundreds of identical Dijkstra calls.
  const usable = waterloo.edges.filter(
      (e) => !edgeIssue(waterloo, e) && !e.restricted,
    ),
    origin = roomDoorNodes(waterloo, from)[0],
    seen = new Set([origin.id]),
    queue = [origin.id];
  for (let i = 0; i < queue.length; i++)
    for (const e of usable) {
      const next =
        e.from === queue[i]
          ? e.to
          : e.to === queue[i] && e.direction === "both"
            ? e.from
            : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  for (const r of roomAvailability(waterloo).filter((r) => r.ready))
    assert.ok(
      roomDoorNodes(waterloo, r.id).some((n) => seen.has(n.id)),
      r.label,
    );
  const top = routeBuilding(waterloo, from, "e2-source-4:s4402a");
  assert.deepEqual(top.floorIds, ["e2-f1", "e2-f2", "e2-f3", "e2-f4"]);
  const lift = routeBuilding(waterloo, from, "e2-f3:3341", {
    excludeStairs: true,
  });
  assert.ok(lift?.stairsFree);
  assert.equal(
    routeBuilding(waterloo, from, "e2-source-4:s4404", { excludeStairs: true }),
    null,
  );
});
wtest("room selectors flag draft, stale and isolated rooms instead of presenting them as ready", () => {
  const draft = clone(waterloo);
  draft.floors[0].geometryStatus = "draft";
  const rooms = roomAvailability(draft);
  assert.equal(rooms.find((r) => r.id === "e2-source-1:s12").ready, false);
  assert.match(
    routeFailureReason(draft, rooms, "e2-source-1:s12", "e2-source-1:s11"),
    /Floor 1 needs geometry review/,
  );
  draft.floors[0].geometryStatus = "reviewed";
  draft.floors[0].revision++;
  assert.match(
    roomAvailability(draft).find((r) => r.id === "e2-source-1:s12").reason,
    /revalidation/,
  );
  assert.equal(
    roomAvailability(lab).find((r) => r.id === "lab-f1:unreachable").ready,
    false,
  );
});
test("source assignment preserves multiple images on one floor and known-landmark transform", () => {
  assert.equal(lab.floors[0].sources.length, 2);
  const t = similarityTransform(
    { image: { x: 0, y: 0 }, floor: { x: 100, y: 100 } },
    { image: { x: 600, y: 400 }, floor: { x: 700, y: 500 } },
  );
  assert.deepEqual(applyTransform({ x: 50, y: 70 }, t), { x: 150, y: 170 });
  assert.throws(() =>
    similarityTransform(
      { image: { x: 0, y: 0 }, floor: { x: 0, y: 0 } },
      { image: { x: 0, y: 0 }, floor: { x: 0, y: 0 } },
    ),
  );
});
test("multi-exit room routing chooses a valid shorter doorway and includes bend geometry", () => {
  const r = routeBuilding(lab, "lab-f1:a", "lab-f1:c");
  assert.ok(r);
  assert.equal(r.startNode, "lab-f1:door-a-east:node");
  assert.equal(r.endNode, "lab-f1:door-c:node");
  assert.ok(r.steps.some((s) => s.edgeId === "lab-f1:access-east"));
  assert.ok(!r.steps.some((s) => s.edgeId === "lab-f1:access-west"));
  assert.ok(r.steps.some((s) => s.path.length > 2));
  assert.ok(r.instructions.some((i) => i.text.includes("Turn right")));
});
wtest("every mapped room endpoint lies in an actual door opening, with no room-centre hub", () => {
  for (const f of waterloo.floors)
    for (const s of f.geometry.spaces.filter(
      (s) =>
        !["corridor", "lobby"].includes(s.kind) &&
        s.access !== "unknown" &&
        s.access !== "nonwalkable",
    )) {
      const endpoints = roomDoorNodes(waterloo, s.id);
      assert.ok(endpoints.length, s.label);
      assert.ok(
        !waterloo.nodes.some(
          (n) =>
            n.type === "destination" && !n.doorId && n.spaceIds.includes(s.id),
        ),
        s.label,
      );
      for (const n of endpoints) {
        const d = f.geometry.doors.find((d) => d.id === n.doorId);
        assert.ok(pointSegment(n.position, d.a, d.b) < 0.01);
      }
    }
  const r = routeBuilding(waterloo, "e2-source-1:s12", "e2-source-1:s11");
  const endpoint = waterloo.nodes.find((n) => n.id === r.startNode),
    door = waterloo.floors[0].geometry.doors.find(
      (d) => d.id === endpoint.doorId,
    );
  assert.ok(door.spaceIds.includes("e2-source-1:s12"));
  assert.ok(pointSegment(endpoint.position, door.a, door.b) < 0.01);
  assert.match(r.instructions[0].text, /Start at 1731 doorway/);
  assert.match(r.instructions.at(-1).text, /Arrive at 1733 doorway/);
});
test("doorway selection can use another opening when the nearest one is restricted", () => {
  const b = clone(lab);
  for (const e of b.edges.filter(
    (e) =>
      e.from === "lab-f1:door-a-east:node" ||
      e.to === "lab-f1:door-a-east:node",
  ))
    e.restricted = true;
  const r = routeBuilding(b, "lab-f1:a", "lab-f1:c");
  assert.equal(r.startNode, "lab-f1:door-a-west:node");
  assert.ok(r.steps.some((s) => s.edgeId === "lab-f1:access-west"));
});
test("held-out room pair routes through the same graph without hardcoded endpoints", () => {
  const r = routeBuilding(lab, "lab-f2:b", "lab-f1:c");
  assert.ok(r);
  assert.deepEqual(r.floorIds, ["lab-f2", "lab-f1"]);
});
test("cross-floor route uses explicit stairs and stairs-free route uses elevator without claiming accessibility", () => {
  const r = routeBuilding(lab, "lab-f1:a", "lab-f2:c");
  assert.ok(r.steps.some((s) => s.traversal === "stairs"));
  assert.ok(
    r.instructions.some((i) => i.text === "Take Staircase B to Lab Floor 2."),
  );
  const lift = routeBuilding(lab, "lab-f1:a", "lab-f2:c", {
    excludeStairs: true,
  });
  assert.ok(lift.steps.some((s) => s.traversal === "elevator"));
  assert.equal(lift.stairsFree, true);
  assert.equal(lift.accessible, false);
  assert.equal(
    routeBuilding(lab, "lab-f1:a", "lab-f2:c", { verifiedAccessible: true }),
    null,
  );
});
test("unreachable destination and restricted connectors return no route", () => {
  assert.equal(routeBuilding(lab, "lab-f1:a", "lab-f1:unreachable"), null);
  const b = clone(lab);
  b.connectors.forEach((c) => (c.status = "draft"));
  assert.equal(routeBuilding(b, "lab-f1:a", "lab-f2:c"), null);
});
test("forward and reverse routes use only corresponding direction cards", () => {
  const f = routeBuilding(lab, "lab-f1:a", "lab-f1:c"),
    r = routeBuilding(lab, "lab-f1:c", "lab-f1:a");
  assert.ok(f.references.some((x) => x.photo?.id === "photo-forward"));
  assert.ok(!f.references.some((x) => x.photo?.id === "photo-reverse"));
  assert.ok(r.references.some((x) => x.photo?.id === "photo-reverse"));
  assert.ok(!r.references.some((x) => x.photo?.id === "photo-forward"));
  assert.ok(f.references.some((x) => x.missing));
});
test("wall-crossing or out-of-corridor polylines are blocked", () => {
  const b = clone(lab),
    e = b.edges.find((e) => e.id === "lab-f1:photographed-bend");
  e.path = [e.path[0], { x: 800, y: 250 }, e.path.at(-1)];
  assert.ok(edgeIssue(b, e));
  assert.equal(routeBuilding(b, "lab-f1:a", "lab-f1:c"), null);
});
test("accidental floor links and inconsistent connector IDs are rejected", () => {
  const b = clone(lab),
    e = b.edges.find((e) => e.floorId === null);
  e.connectorId = "missing";
  assert.match(edgeIssue(b, e), /connector/);
  e.floorId = "lab-f1";
  assert.match(edgeIssue(b, e), /accidental/);
});
test("geometry edits stale only affected floor paths; review and revalidation restore valid routes", () => {
  let b = geometryChanged(lab, "lab-f1", lab.floors[0].geometry, "test edit");
  assert.equal(routeBuilding(b, "lab-f1:a", "lab-f1:c"), null);
  assert.ok(routeBuilding(b, "lab-f2:a", "lab-f2:c"));
  b.floors[0].geometryStatus = "reviewed";
  b = revalidateGraph(b, "lab-f1");
  assert.ok(routeBuilding(b, "lab-f1:a", "lab-f1:c"));
  assert.equal(b.floors[0].history.length, 1);
});
test("splitting photographed polyline migrates association and preserves both route directions", () => {
  const b = splitEdge(lab, "lab-f1:photographed-bend");
  assert.equal(b.photos[0].edgeId, "lab-f1:photographed-bend:a");
  assert.ok(b.photos[0].along > 0);
  assert.ok(
    routeBuilding(b, "lab-f1:a", "lab-f1:c").references.some(
      (r) => r.photo?.id === "photo-forward",
    ),
  );
  assert.ok(
    routeBuilding(b, "lab-f1:c", "lab-f1:a").references.some(
      (r) => r.photo?.id === "photo-reverse",
    ),
  );
  assert.ok(!validateBuilding(b).some((i) => i.code === "photo"));
});
test("deleting a photographed edge retains images with explicit dangling-association errors", () => {
  const b = deleteEdge(lab, "lab-f1:photographed-bend");
  assert.equal(b.photos.length, 2);
  assert.ok(b.photos.every((p) => p.status === "stale" && p.issue));
  assert.ok(validateBuilding(b).some((i) => i.code === "photo"));
});
wtest("portable ZIP package roundtrip preserves original PDFs, all asset bytes, stable IDs and associations", async () => {
  assert.deepEqual(await importPackage(await exportPackage(lab)), lab);
  assert.deepEqual(
    await importPackage(await exportPackage(waterloo)),
    waterloo,
  );
});
wtest("Waterloo reviewed subset routes same-floor and cross-floor; no fabricated photos", () => {
  assert.equal(waterloo.floors.length, 4);
  assert.equal(waterloo.photos.length, 0);
  assert.ok(routeBuilding(waterloo, "e2-f2:2340", "e2-f2:2351"));
  assert.ok(routeBuilding(waterloo, "e2-f2:2413", "e2-f3:3339"));
  assert.ok(
    routeBuilding(waterloo, "e2-f2:2340", "e2-f3:3341", {
      excludeStairs: true,
    }),
  );
});
test("cache keys include image bytes and extraction model; unchanged source is reused", async () => {
  let calls = 0;
  const source = clone(lab.floors[0].geometry.source),
    unique = "test-" + crypto.randomUUID();
  const provider = {
    name: "Test",
    model: unique,
    extract: async (s) => {
      calls++;
      return { ...clone(lab.floors[0].geometry), source: s };
    },
  };
  const a = await cachedExtraction(source, provider),
    z = await cachedExtraction(source, provider);
  assert.equal(a.cached, false);
  assert.equal(z.cached, true);
  assert.equal(calls, 1);
  provider.model += "-changed";
  await cachedExtraction(source, provider);
  assert.equal(calls, 2);
});
test("real PDF import retains original bytes and renders an assigned source", async () => {
  const bytes = await readFile("tests/fixtures/002E2_04FLR.pdf"),
    r = await preparePlan(bytes, "tests/fixtures/002E2_04FLR.pdf", "application/pdf");
  assert.equal(r.sources.length, 1);
  const s = r.sources[0];
  assert.equal(s.page, 1);
  assert.equal(s.alignment, "draft");
  assert.deepEqual(
    Buffer.from(r.assets[s.originalAssetId].dataUrl.split(",")[1], "base64"),
    bytes,
  );
  assert.ok(r.assets[s.assetId].dataUrl.startsWith("data:image/png;base64,"));
});
test("automatic graph building handles an L corridor and preserves explicit landings on repeated builds", () => {
  let b = clone(lab);
  for (let repeat = 0; repeat < 2; repeat++)
    for (const f of b.floors) b = buildGraph(b, f.id);
  assert.ok(routeBuilding(b, "lab-f1:a", "lab-f1:c"));
  assert.ok(routeBuilding(b, "lab-f1:a", "lab-f2:c"));
  assert.equal(new Set(b.nodes.map((n) => n.id)).size, b.nodes.length);
  assert.ok(b.photos.every((p) => p.status === "stale"));
});
test("one-way polyline allows forward travel and blocks its reverse", () => {
  const b = clone(lab);
  b.edges.find((e) => e.id === "lab-f1:photographed-bend").direction =
    "forward";
  assert.ok(routeBuilding(b, "lab-f1:a", "lab-f1:c"));
  assert.equal(routeBuilding(b, "lab-f1:c", "lab-f1:a"), null);
});
test("independent sections cannot connect without an established shared section", () => {
  const b = clone(lab),
    f = b.floors[0];
  const source = f.sources[0];
  source.id = "lab-f1";
  source.sectionId = "one";
  f.sources[1].id = "other";
  f.sources[1].sectionId = "two";
  const node = b.nodes.find((n) => n.type === "junction");
  const s = f.geometry.spaces.find((s) => s.id === "lab-f1:corridor");
  s.id = "other:corridor";
  for (const n of b.nodes)
    n.spaceIds = n.spaceIds.map((id) => (id === "lab-f1:corridor" ? s.id : id));
  for (const d of f.geometry.doors)
    d.spaceIds = d.spaceIds.map((id) => (id === "lab-f1:corridor" ? s.id : id));
  assert.ok(b.edges.some((e) => edgeIssue(b, e)?.includes("source sections")));
});

test("a shared connector can explicitly extend to a third floor", () => {
  const b = clone(lab),
    f = JSON.parse(
      JSON.stringify(b.floors[1])
        .replaceAll("lab-f2", "lab-f3")
        .replaceAll("lab-source-2", "lab-source-3"),
    );
  f.label = "Lab Floor 3";
  f.level = 3;
  b.floors.push(f);
  const node = JSON.parse(
    JSON.stringify(
      b.nodes.find((n) => n.id === "lab-f2:stair:node"),
    ).replaceAll("lab-f2", "lab-f3"),
  );
  node.connectorId = null;
  b.nodes.push(node);
  const next = connectLandings(
    b,
    "lab-f2:stair:node",
    node.id,
    "stairs",
    "Staircase B",
    "Confirmed synthetic third-floor landing.",
  );
  const c = next.connectors.find((c) => c.type === "stairs");
  assert.equal(c.landingIds.length, 3);
  assert.equal(next.edges.filter((e) => e.connectorId === c.id).length, 2);
});
test("collinear path points simplify without cutting corridor bends", () => {
  const f = lab.floors[0];
  assert.equal(
    simplifyPath(f, [
      { x: 400, y: 250 },
      { x: 500, y: 250 },
      { x: 650, y: 250 },
      { x: 650, y: 475 },
    ]).length,
    3,
  );
});
wtest("accepting a source proposal replaces its owned geometry without duplicating review notes", () => {
  const f = clone(waterloo.floors[1]),
    s = f.sources[0],
    proposal = f.snapshots.at(-1).geometry,
    g = mergeProposal(f, s.id, proposal);
  assert.equal(g.spaces.length, proposal.spaces.length);
  assert.equal(g.spaces.filter((r) => r.id === "e2-f2:2340").length, 1);
  f.geometry = g;
  s.geometryIds = g.spaces.map((x) => x.id);
  const second = mergeProposal(f, s.id, proposal);
  assert.equal(second.spaces.length, g.spaces.length);
  assert.equal(second.review.issues.length, g.review.issues.length);
});
