import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DEFAULT_IMAGE_MODEL, VertexImageModel, nearestAspect } from "../server/vertex-image.js";
import { cleanPlan, buildingFromClean, splitBuilding } from "../server/pipelines/clean-plan.js";
import { validateBuilding } from "../shared/building/validation.js";

// Synthetic two-floor "board": two framed rectangles side by side. No paid calls.
const cache = () => join(tmpdir(), `clean-plan-${crypto.randomUUID()}`);
async function board() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="#eee"/>
    <rect x="60" y="80" width="480" height="320" fill="#fff" stroke="#000" stroke-width="6"/>
    <rect x="660" y="80" width="480" height="320" fill="#fff" stroke="#000" stroke-width="6"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
// Fake image model: returns a grey copy of its input and records concurrency.
function fakeImageModel() {
  let inFlight = 0;
  const m = { model: "fake-image", imageSize: "2K", configured: true, calls: 0, maxInFlight: 0,
    async generate({ images, aspectRatio }) {
      m.calls++; inFlight++; m.maxInFlight = Math.max(m.maxInFlight, inFlight); m.lastAspect = aspectRatio;
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      const png = await sharp(Buffer.from(images[0].split(",")[1], "base64")).greyscale().png().toBuffer();
      return { dataUrl: `data:image/png;base64,${png.toString("base64")}`, model: "fake-image", usage: { total_tokens: 1200 }, text: "" };
    } };
  return m;
}
const call = (name, args, i) => ({ type: "function_call", call_id: `c${i}`, name, arguments: JSON.stringify(args) });
// Scripted text model: crop both floors, redraw both in one turn, then finish.
function scriptedAgent(turns) {
  let n = 0;
  return { name: "Scripted", model: "s", seen: [], async respond(body) {
    this.seen.push(body);
    const output = turns[n++](body);
    return { output, usage: { total_tokens: 500 } };
  } };
}

test("the image request asks for an image with size and aspect, defaults to Nano Banana 2.1, and Pro stays selectable", async () => {
  let sent;
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#fff" } }).png().toBuffer();
  const model = new VertexImageModel({ apiKey: "k", project: "p", fetchImpl: async (url, init) => {
    sent = { url, body: JSON.parse(init.body), headers: init.headers };
    return new Response(JSON.stringify({ modelVersion: "gemini-nano-banana-2.1", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1120, totalTokenCount: 1130 },
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] }));
  } });
  const out = await model.generate({ prompt: "redraw", images: [`data:image/png;base64,${png.toString("base64")}`], aspectRatio: "4:3" });
  assert.match(sent.url, /publishers\/google\/models\/gemini-nano-banana-2\.1:generateContent$/);
  assert.equal(DEFAULT_IMAGE_MODEL, "gemini-nano-banana-2.1");
  const pro = new VertexImageModel({ apiKey: "k", project: "p", model: "gemini-3-pro-image", fetchImpl: async (url) => { sent.proUrl = url; throw new Error("stop"); } });
  await assert.rejects(pro.generate({ prompt: "x" }), /stop/);
  assert.match(sent.proUrl, /models\/gemini-3-pro-image:generateContent$/);
  assert.deepEqual(sent.body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.deepEqual(sent.body.generationConfig.imageConfig, { imageSize: "2K", aspectRatio: "4:3" });
  assert.equal(sent.headers["x-goog-api-key"], "k");
  assert.match(out.dataUrl, /^data:image\/png;base64,/);
  assert.equal(out.usage.total_tokens, 1130);
  const empty = new VertexImageModel({ apiKey: "k", project: "p", fetchImpl: async () =>
    new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "no" }] } }] })) });
  await assert.rejects(empty.generate({ prompt: "x" }), /no image/);
  assert.equal(nearestAspect(1600, 900), "16:9");
  assert.equal(nearestAspect(1000, 1000), "1:1");
});

test("building plan: the agent crops each floor, redraws them in parallel and finishes with exactly that many floors", async () => {
  const imageModel = fakeImageModel(), cacheDir = cache();
  const agent = scriptedAgent([
    () => [call("crop_region", { label: "Level 1", level: 1, x0: 40, y0: 140, x1: 460, y1: 820 }, 1),
      call("crop_region", { label: "Level 2", level: 2, x0: 540, y0: 140, x1: 960, y1: 820 }, 2)],
    () => [call("generate_clean_floor", { crop_id: "crop-1" }, 3), call("generate_clean_floor", { crop_id: "crop-2" }, 4)],
    () => [call("finish", { floors: [{ crop_id: "crop-1", clean_id: "clean-1", label: "Level 1", level: 1 }] }, 5)],
    () => [call("finish", { floors: [{ crop_id: "crop-1", clean_id: "clean-1", label: "Level 1", level: 1 },
      { crop_id: "crop-2", clean_id: "clean-2", label: "Level 2", level: 2 }] }, 6)],
  ]);
  const out = await splitBuilding({ buffer: await board(), floors: 2, provider: agent, imageModel, cacheDir });
  assert.equal(imageModel.calls, 2);
  assert.equal(imageModel.maxInFlight, 2, "both redraws ran at the same time");
  assert.deepEqual(out.floors.map((f) => f.label), ["Level 1", "Level 2"]);
  assert.ok(out.floors[0].crop.left < 100 && out.floors[1].crop.left > 600, JSON.stringify(out.floors.map((f) => f.crop)));
  // The wrong-count finish was refused and reported back to the model.
  assert.ok(out.transcript.some((t) => t.tool === "finish" && !t.ok && /exactly 2 floors/.test(t.error)));
  // The model saw a gridded overview, then the crops and the previews.
  assert.ok(agent.seen[1].input.some((i) => i.role === "user" && i.content?.filter?.((c) => c.type === "input_image").length === 2));
  // Same crops again: served from the cache, no new image calls.
  const again = fakeImageModel();
  const replay = scriptedAgent([
    () => [call("crop_region", { label: "Level 1", level: 1, x0: 40, y0: 140, x1: 460, y1: 820 }, 1),
      call("crop_region", { label: "Level 2", level: 2, x0: 540, y0: 140, x1: 960, y1: 820 }, 2)],
    () => [call("generate_clean_floor", { crop_id: "crop-1" }, 3), call("generate_clean_floor", { crop_id: "crop-2" }, 4)],
    () => [call("finish", { floors: [{ crop_id: "crop-1", clean_id: "clean-1", label: "Level 1", level: 1 },
      { crop_id: "crop-2", clean_id: "clean-2", label: "Level 2", level: 2 }] }, 5)],
  ]);
  const cached = await splitBuilding({ buffer: await board(), floors: 2, provider: replay, imageModel: again, cacheDir });
  assert.equal(again.calls, 0);
  assert.equal(cached.usage.cachedImages, 2);
  assert.equal(replay.seen.length, 0, "the saved split is reused without asking the planner again");
  assert.deepEqual(cached.floors.map((f) => f.label), ["Level 1", "Level 2"]);
});

test("bad crops and unknown tools are reported to the model, and the job fails if it never finishes", async () => {
  const agent = scriptedAgent(Array.from({ length: 3 }, (_, k) => () => [
    call("crop_region", { label: "Tiny", level: 1, x0: 10, y0: 10, x1: 12, y1: 12 }, `a${k}`), call("teleport", {}, `b${k}`)]));
  await assert.rejects(splitBuilding({ buffer: await board(), floors: 2, provider: agent, imageModel: fakeImageModel(), cacheDir: cache(), maxTurns: 3 }),
    /did not finish within 3 turns/);
});

test("floor plan: one redraw becomes one floor; the original crop is kept beside the clean source", async () => {
  const imageModel = fakeImageModel();
  const clean = await cleanPlan({ buffer: await board(), fileName: "level-2.png", mime: "image/png", mode: "floor", labels: ["Level 2"],
    imageModel, provider: null, cacheDir: cache() });
  assert.equal(clean.floors.length, 1);
  assert.equal(imageModel.lastAspect, "21:9");
  const b = await buildingFromClean(clean, { name: "Test" });
  const [f] = b.floors, [source] = f.sources;
  assert.equal(f.label, "Level 2");
  assert.equal(source.alignment, "reviewed");
  assert.match(b.assets[source.assetId].provenance, /Clean redraw by fake-image/);
  assert.match(b.assets[source.originalAssetId].provenance, /Original crop for Level 2/);
  assert.ok(Object.values(b.assets).some((a) => a.provenance.startsWith("Original user upload")));
  // Not mapped yet is the only issue for a freshly cleaned floor.
  assert.deepEqual(validateBuilding(b).filter((i) => i.severity === "error").map((i) => i.message), ["Level 2: No walkable spaces yet — extract or trace the floor plan."]);
  await assert.rejects(cleanPlan({ buffer: await board(), fileName: "x.png", mime: "image/png", mode: "floor",
    imageModel: { configured: false }, cacheDir: cache() }), /VERTEX_API_KEY/);
});
