import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { emptyMap, clone, validateMap } from "../shared/map.js";
import {
  planTiles,
  runCoveragePipeline,
} from "../server/pipelines/coverage.js";
import {
  consolidateCoverage,
  tileGeometry,
} from "../shared/building/coverage.js";
import { coverageSummary } from "../shared/building/coverage-status.js";
import {
  sourceGeometry,
  applyTransform,
  sourceSection,
  mergeProposal,
  sourceFeatureId,
} from "../shared/building/preparation.js";
const rect = (x, y, r, b) => [
  { x, y },
  { x: r, y },
  { x: r, y: b },
  { x, y: b },
];
const source = {
  name: "Coverage fixture",
  width: 200,
  height: 140,
  dataUrl:
    "data:image/png;base64," +
    (
      await sharp({
        create: { width: 200, height: 140, channels: 3, background: "#dddddd" },
      })
        .png()
        .toBuffer()
    ).toString("base64"),
  normalized: true,
  provenance: "Synthetic geometry fixture",
  fictional: true,
};
const proposal = (spaces) => ({
  ...emptyMap(source),
  spaces: spaces.map(([id, label, polygon]) => ({
    id,
    label,
    polygon,
    kind: "room",
    confidence: 1,
  })),
});
test("overlapping detail grid covers the image bounds without treating tiles as floors", () => {
  const tiles = planTiles(1280, 1978);
  assert.ok(tiles.length > 1);
  for (const t of tiles)
    assert.ok(
      t.x >= 0 && t.y >= 0 && t.x + t.width <= 1280 && t.y + t.height <= 1978,
    );
  for (let y = 0; y < 1978; y += 37)
    for (let x = 0; x < 1280; x += 41)
      assert.ok(
        tiles.some(
          (t) =>
            x >= t.x && x < t.x + t.width && y >= t.y && y < t.y + t.height,
        ),
      );
  assert.throws(() => planTiles(100, 100, { tileSize: 10 }));
});
test("crop coordinates return to their source frame and adjacent unnamed rooms are preserved", () => {
  const map = proposal([
    ["one", "Unlabelled space", rect(20, 20, 40, 60)],
    ["two", "Unlabelled space", rect(40, 20, 60, 60)],
  ]);
  const transformed = tileGeometry(
    map,
    { x: 100, y: 200, width: 100, height: 70 },
    200,
    140,
  );
  assert.deepEqual(transformed.spaces[0].polygon[0], { x: 110, y: 210 });
  const result = consolidateCoverage(source, [{ map }]);
  assert.equal(result.map.spaces.filter((s) => s.kind === "room").length, 2);
  assert.ok(result.map.spaces.every((s) => s.access === "unknown"));
  assert.ok(
    result.coverage.geometryIssues.every((i) => i.severity !== "error"),
  );
});
test("footprint mask excludes campus and title geometry, and inventory records missing rooms explicitly", () => {
  const map = proposal([
    ["inside", "1001", rect(20, 20, 60, 60)],
    ["outside", "9999", rect(140, 20, 180, 60)],
  ]);
  const result = consolidateCoverage(source, [{ map }], {
    footprints: [rect(0, 0, 100, 100)],
    inventory: [{ label: "1002", kind: "room", position: { x: 80, y: 80 } }],
  });
  assert.ok(!result.map.spaces.some((s) => s.label === "9999"));
  assert.equal(
    result.coverage.items.find((i) => i.label === "1002").spaceId,
    null,
  );
  const summary = coverageSummary(
    { geometry: result.map },
    { coverage: result.coverage },
  );
  assert.equal(summary.missing.length, 1);
  assert.equal(summary.complete, false);
});
test("multi-pass jobs cache detail and independent inventory results, retaining failed-tile accounting", async () => {
  let extracts = 0,
    inventories = 0,
    fail = true;
  const provider = {
    name: "Coverage test",
    model: crypto.randomUUID(),
    configured: true,
    inventory: async () => {
      inventories++;
      return {
        items: [{ label: "1001", kind: "room", position: { x: 30, y: 30 } }],
        footprints: [rect(0, 0, 200, 140)],
        notes: [],
      };
    },
    extract: async (input) => {
      extracts++;
      if (fail && input.name.endsWith("2"))
        throw Error("Synthetic failed detail");
      return {
        ...proposal([["r", "1001", rect(20, 20, 60, 60)]]),
        source: input,
      };
    },
  };
  const options = {
    provider,
    tiles: [
      { x: 0, y: 0, width: 120, height: 140 },
      { x: 80, y: 0, width: 120, height: 140 },
    ],
  };
  const image = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140"><rect width="200" height="140" fill="#ddd"/><rect x="10" y="20" width="30" height="50" fill="black"/></svg>',
      ),
    )
      .png()
      .toBuffer(),
    input = {
      ...source,
      dataUrl: "data:image/png;base64," + image.toString("base64"),
    };
  const a = await runCoveragePipeline(input, options);
  fail = false;
  const recovered = await runCoveragePipeline(input, options),
    b = await runCoveragePipeline(input, options);
  assert.equal(inventories, 1);
  assert.equal(extracts, 3);
  assert.equal(recovered.cached, false);
  assert.equal(recovered.coverage.failures.length, 0);
  assert.equal(b.cached, true);
  assert.equal(a.coverage.failures.length, 1);
  assert.equal(a.coverage.stage, "needs-review");
});
test("source geometry uses inverse alignment and owned IDs establish a source relationship", () => {
  const g = proposal([["manual-room", "1001", rect(110, 220, 150, 260)]]),
    sourceRef = {
      id: "scan",
      geometryIds: ["manual-room"],
      transform: [2, 0, 0, 2, 100, 200],
      sectionId: "section",
    };
  const f = { geometry: g, sources: [sourceRef] };
  const extracted = sourceGeometry(f, sourceRef);
  assert.deepEqual(extracted.spaces[0].polygon[0], { x: 5, y: 10 });
  assert.equal(sourceSection(f, "manual-room"), "section");
});

test("rescanning owned geometry preserves stable IDs and keeps unrelated sources intact", () => {
  const old = proposal([
    ["scan:1001", "1001", rect(20, 20, 60, 60)],
    ["manual-owned", "1002", rect(70, 20, 100, 60)],
    ["other:1003", "1003", rect(130, 20, 170, 60)],
  ]);
  const ref = {
    id: "scan",
    geometryIds: ["scan:1001", "manual-owned"],
    transform: [1, 0, 0, 1, 0, 0],
    alignment: "reviewed",
  };
  const f = { geometry: old, sources: [ref] },
    detail = sourceGeometry(f, ref);
  detail.spaces.push({
    id: "new-room",
    label: "1004",
    kind: "room",
    polygon: rect(20, 80, 60, 120),
    confidence: 1,
  });
  const merged = mergeProposal(f, "scan", detail),
    ids = merged.spaces.map((s) => s.id);
  assert.deepEqual(ids, [
    "other:1003",
    "scan:1001",
    "manual-owned",
    "scan:new-room",
  ]);
  assert.equal(sourceFeatureId(ref, "manual-owned"), "manual-owned");
});

test("coverage avoids paid detail extraction outside the inventoried floor footprint", async () => {
  let calls = 0;
  const provider = {
    name: "Coverage fixture",
    model: crypto.randomUUID(),
    configured: true,
    inventory: async () => ({
      items: [],
      footprints: [rect(0, 0, 60, 140)],
      notes: [],
    }),
    extract: async (input) => {
      calls++;
      return {
        ...proposal([["r", "1001", rect(20, 20, 60, 60)]]),
        source: input,
      };
    },
  };
  const r = await runCoveragePipeline(source, {
    provider,
    tiles: [
      { x: 0, y: 0, width: 100, height: 140 },
      { x: 100, y: 0, width: 100, height: 140 },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(r.coverage.skippedTiles.length, 1);
  assert.equal(r.coverage.skippedTiles[0].reason, "Outside floor footprint");
});
test("partial label proposals cannot erase a reviewed region with multiple room aliases", () => {
  const base = proposal([["reviewed", "4403 / 4401", rect(20, 20, 180, 120)]]),
    detail = proposal([["part", "4401", rect(110, 20, 180, 60)]]);
  const r = consolidateCoverage(source, [{ map: detail }], {
    baseMap: base,
    inventory: [{ label: "4403", kind: "room", position: { x: 50, y: 80 } }],
  });
  assert.deepEqual(r.map.spaces[0].polygon, base.spaces[0].polygon);
  assert.equal(
    r.coverage.items.find((i) => i.label === "4403").spaceId,
    "reviewed",
  );
});

test("boundary reconciliation never collapses a narrow physical region to zero area", () => {
  const base = proposal([["anchor", "1001", rect(108, 105, 130, 135)]]),
    detail = proposal([
      ["narrow", "Unlabelled narrow enclosure", rect(105, 20, 110, 60)],
      ["other", "1002", rect(107, 80, 109, 100)],
    ]);
  const r = consolidateCoverage(source, [{ map: detail }], { baseMap: base });
  assert.ok(
    r.map.spaces.some((s) => s.label === "Unlabelled narrow enclosure"),
  );
});
