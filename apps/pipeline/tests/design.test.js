import { hasWaterloo, waterlooText, wtest } from "./fixtures/optional.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import JSZip from "jszip";
import { parseBuilding } from "../shared/building/schema.js";
import {
  presentation,
  presetPresentation,
  buildingBounds,
  designedSVG,
  applyDesignTools,
  labelPoint,
  navigationSignature,
} from "../shared/building/design.js";
import {
  renderDesign,
  suggestDesign,
  designToolDefinitions,
} from "../server/pipelines/design.js";
import { exportPackage, importPackage } from "../shared/building/export.js";
import { inside } from "../shared/map.js";
const b = hasWaterloo ? parseBuilding(waterlooText()) : null,
  f = b?.floors[3];
const palette = presetPresentation("sandstone").colors;
const calls = [
  { name: "set_map_palette", arguments: palette },
  {
    name: "set_map_layout",
    arguments: {
      title: "Level Four",
      padding: 4,
      wallWidth: 1,
      showTitle: true,
      showLegend: true,
      showDoors: true,
    },
  },
];
wtest("clean framing fits the actual Floor 4 building and excludes the unused PDF page", () => {
  const box = buildingBounds(f);
  assert.ok(box.w < 400);
  assert.ok(box.h < 200);
  for (const p of f.geometry.spaces.flatMap((s) => s.polygon))
    assert.ok(
      p.x >= box.x &&
        p.x <= box.x + box.w &&
        p.y >= box.y &&
        p.y <= box.y + box.h,
    );
  const svg = designedSVG(b, f.id);
  assert.ok(!svg.includes("<image"));
  assert.ok(!svg.includes("data:image"));
  assert.ok(!svg.includes("ENGINEERING 3"));
  assert.match(svg, /Original mapped coordinates/);
});
wtest("design tools are transactional, reject geometry edits and leave every source and route coordinate intact", () => {
  const original = structuredClone(b),
    style = applyDesignTools(f, calls);
  assert.equal(style.colors.background, palette.background);
  assert.equal(style.title, "Level Four");
  assert.deepEqual(b, original);
  assert.throws(
    () => applyDesignTools(f, [...calls, { name: "move_room", arguments: {} }]),
    /Unsupported/,
  );
  assert.throws(() =>
    applyDesignTools(f, [
      { name: "set_map_palette", arguments: { ...palette, geometry: {} } },
    ]),
  );
  assert.throws(
    () =>
      applyDesignTools(f, [
        {
          name: "style_map_rooms",
          arguments: {
            roomIds: ["missing-room"],
            fill: "#ffffff",
            label: null,
          },
        },
      ]),
    /unknown room/,
  );
});
wtest("custom labels are escaped, room identity stays stable and SVG renders without raster assets", async () => {
  const style = applyDesignTools(f, [
    {
      name: "style_map_rooms",
      arguments: {
        roomIds: [f.geometry.spaces[0].id],
        fill: "#ffdddd",
        label: "<script>alert(1)</script>",
      },
    },
  ]);
  const svg = designedSVG(b, f.id, style);
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;script&gt;"));
  assert.ok(svg.includes(f.geometry.spaces[0].id));
  assert.equal(f.geometry.spaces[0].label, "4404");
  const png = await renderDesign(b, f.id, style),
    m = await sharp(
      Buffer.from(png.dataUrl.split(",")[1], "base64"),
    ).metadata();
  assert.equal(m.format, "png");
  assert.ok(m.width <= 1800 && m.height <= 1800);
  assert.ok(m.width / m.height > 1.5);
});
wtest("concave room labels remain inside their own region", () => {
  const p = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 20 },
    { x: 20, y: 20 },
    { x: 20, y: 100 },
    { x: 0, y: 100 },
  ];
  assert.ok(inside(labelPoint(p), p));
});
wtest("portable exports retain per-floor designs, add clean SVGs, and preserve geometry", async () => {
  const sample = structuredClone(b);
  sample.floors = [sample.floors[3]];
  sample.nodes = [];
  sample.edges = [];
  sample.connectors = [];
  sample.floors[0].presentation = applyDesignTools(f, calls);
  const bytes = await exportPackage(sample),
    zip = await JSZip.loadAsync(bytes);
  assert.ok(zip.file("designs/" + f.id + ".svg"));
  assert.ok(zip.file("floors/" + f.id + ".svg"));
  assert.deepEqual(await importPackage(bytes), sample);
});
wtest("OpenAI receives the exact configured model and a clean preview; only strict local design tools are exposed", async () => {
  let request;
  const result = await suggestDesign(b, f.id, "Make a warm minimal map", {
    provider: {
      name: "OpenAI",
      model: "gpt-6.1-sol",
      configured: true,
      apiKey: "fixture-key",
    },
    fetchImpl: async (url, opts) => {
      request = { url, ...opts };
      return new Response(
        JSON.stringify({
          status: "completed",
          output: calls.map((c) => ({
            type: "function_call",
            name: c.name,
            arguments: JSON.stringify(c.arguments),
          })),
        }),
      );
    },
  });
  const body = JSON.parse(request.body);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.store, false);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.tools.length, 4);
  assert.ok(
    body.tools.every(
      (t) =>
        t.strict &&
        t.parameters.additionalProperties === false &&
        t.parameters.required.length ===
          Object.keys(t.parameters.properties).length,
    ),
  );
  assert.ok(body.input[0].content[1].image_url.startsWith("data:image/png"));
  assert.equal(result.presentation.title, "Level Four");
  assert.equal(result.presentation.lastAI.model, "gpt-6.1-sol");
  assert.ok(!JSON.stringify(result).includes("fixture-key"));
});
wtest("Gemini uses the same bounded map tools and errors never fall back to another provider", async () => {
  let body;
  const result = await suggestDesign(b, f.id, "Warm cream design", {
    provider: { name: "Gemini", model: "fixture-model", configured: true },
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: calls.map((c) => ({
                  functionCall: { name: c.name, args: c.arguments },
                })),
              },
            },
          ],
        }),
      );
    },
  });
  assert.equal(body.toolConfig.functionCallingConfig.mode, "ANY");
  assert.equal(body.tools[0].functionDeclarations.length, 4);
  assert.equal(result.presentation.title, "Level Four");
  let attempts = 0;
  await assert.rejects(
    () =>
      suggestDesign(b, f.id, "Warm cream design", {
        provider: {
          name: "OpenAI",
          model: "gpt-6.1-sol",
          configured: true,
          apiKey: "fixture",
        },
        fetchImpl: async () => {
          attempts++;
          return new Response("{}", { status: 401 });
        },
      }),
    /HTTP 401/,
  );
  assert.equal(attempts, 1);
});

wtest("appearance changes reuse validation state while geometry and routing changes invalidate it", () => {
  const value = structuredClone(b),
    key = navigationSignature(value);
  value.floors[0].presentation = presetPresentation("blueprint");
  assert.equal(navigationSignature(value), key);
  value.floors[0].geometry.spaces[0].polygon[0].x++;
  assert.notEqual(navigationSignature(value), key);
  const svg = designedSVG(b, f.id);
  assert.ok(svg.includes("data-room-id"));
});
