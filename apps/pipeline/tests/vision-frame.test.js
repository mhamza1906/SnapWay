import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { AnthropicProvider } from "../server/provider.js";
import { anthropicMessages } from "../server/anthropic.js";
import { fitVisionFrame, pngSize, visionScale, VISION_MAX_EDGE, VISION_MAX_PIXELS } from "../server/pipelines/vision-frame.js";
import { boundedId } from "../shared/building/graph.js";

const png = async (width, height) => "data:image/png;base64," +
  (await sharp({ create: { width, height, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64");
const reply = value => new Response(JSON.stringify({ id: "msg_fixture", model: "claude-sonnet-5-5",
  content: [{ type: "text", text: JSON.stringify(value) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
const fake = handler => {
  const requests = [];
  const provider = new AnthropicProvider({ apiKey: "synthetic-anthropic-key", model: "claude-sonnet-5-5", effort: "high",
    fetchImpl: async (url, options) => { const body = JSON.parse(options.body); requests.push(body); return handler(body); } });
  return { provider, requests };
};

test("a page above the native vision frame is sent downscaled and inventory positions return in source pixels", async () => {
  // 028C2 pages are 2400×1855 (4.45 MP), above the ~3.75 MP native frame.
  const source = { name: "page", width: 2400, height: 1855, dataUrl: await png(2400, 1855) };
  let sent;
  const { provider, requests } = fake(body => {
    sent = pngSize(`data:image/png;base64,${body.messages[0].content[1].source.data}`);
    return reply({ items: [{ label: "1018", kind: "room", position: { x: sent.width / 2, y: sent.height / 4 } }],
      footprints: [[{ x: 0, y: 0 }, { x: sent.width, y: 0 }, { x: sent.width, y: sent.height }]], notes: [] });
  });
  const inventory = await provider.inventory(source);
  assert.ok(sent.width * sent.height <= VISION_MAX_PIXELS && Math.max(sent.width, sent.height) <= VISION_MAX_EDGE);
  assert.match(requests[0].messages[0].content[0].text, new RegExp(`Image is ${sent.width}×${sent.height};`));
  assert.ok(Math.abs(inventory.items[0].position.x - 1200) < 0.01);
  assert.ok(Math.abs(inventory.items[0].position.y - 1855 / 4) < 0.01);
  assert.ok(Math.abs(inventory.footprints[0][2].x - 2400) < 0.01 && Math.abs(inventory.footprints[0][2].y - 1855) < 0.01);
});

test("small images are sent unchanged so existing tile caches stay valid", async () => {
  const source = { width: 1500, height: 1000, dataUrl: await png(1500, 1000) };
  assert.equal(visionScale(1500, 1000), 1);
  const fitted = await fitVisionFrame(source);
  assert.equal(fitted.dataUrl, source.dataUrl);
  assert.equal(fitted.kx, 1);
});

test("full-page extraction geometry is mapped back from the sent frame", async () => {
  const sample = JSON.parse(await readFile("public/sample/original-extraction.json", "utf8"));
  const geometry = Object.fromEntries(["floorName", "spaces", "walls", "doors", "pois"].map(k => [k, sample[k]]));
  const source = { ...sample.source, width: 2400, height: 1855, dataUrl: await png(2400, 1855) };
  const { provider } = fake(body => {
    const s = pngSize(`data:image/png;base64,${body.messages[0].content[1].source.data}`),
      p = q => ({ ...q, x: q.x * s.width / 2400, y: q.y * s.height / 1855 });
    return reply({ ...geometry, issues: [], spaces: geometry.spaces.map(x => ({ ...x, polygon: x.polygon.map(p) })),
      walls: geometry.walls.map(w => ({ ...w, points: w.points.map(p) })), doors: geometry.doors.map(d => ({ ...d, a: p(d.a), b: p(d.b) })),
      pois: geometry.pois.map(o => ({ ...o, position: p(o.position) })) });
  });
  const map = await provider.extract(source);
  const near = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  assert.ok(map.spaces.every((x, i) => x.polygon.every((q, j) => near(q, geometry.spaces[i].polygon[j]))));
  assert.ok(map.doors.every((d, i) => near(d.a, geometry.doors[i].a) && near(d.b, geometry.doors[i].b)));
  assert.ok(map.pois.every((o, i) => near(o.position, geometry.pois[i].position)));
});

test("oversized images fail loudly instead of being silently downscaled by the API", async () => {
  const url = await png(2700, 1000);
  assert.throws(() => anthropicMessages([{ role: "user", content: [{ type: "input_image", image_url: url }] }]), /exceeds the vision frame/);
});

test("graph IDs stay within the schema limit, deterministic and distinct", () => {
  const a = "source-a41dd98df40b:coverage-door-16:nav:source-a41dd98df40b:coverage-corridor-0:junction:via:source-a41dd98df40b:coverage-door-17:nav:source-a41dd98df40b:coverage-corridor-1:junction";
  assert.ok(a.length > 150);
  assert.equal(boundedId(a).length, 150);
  assert.equal(boundedId(a), boundedId(a));
  assert.notEqual(boundedId(a), boundedId(a + "x"));
  assert.equal(boundedId("short-id"), "short-id");
});
