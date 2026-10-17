import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import sharp from "sharp";
import { openAssetStore, sha256, inspectSvg, DISCLOSURE, MAX_BYTES } from "../server/vectorization/assets.js";
import { vectorizeImage, VECTORIZER_ENDPOINT } from "../server/vectorization/provider.js";
import { vectorizationRouter } from "../server/vectorization/routes.js";

// Synthetic geometry verifies transport only; never imported as the actual IA-4 demo.
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0H20V20H0Z" fill="#eee"/></svg>');
const source = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
const liveEnv = { VECTORIZER_LIVE_ENABLED: "true", VECTORIZER_API_ID: "fake-id", VECTORIZER_API_SECRET: "fake-secret" };
const input = (floorId) => ({ floorId, label: `Test ${floorId}`, source, svg });

async function api(t, options = {}) {
  const store = openAssetStore(":memory:");
  const app = express();
  app.use(express.json());
  app.use("/api/vectorization", vectorizationRouter({ store, env: {}, ...options }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/vectorization`;
  return { store, get: path => fetch(base + path), post: (path, body) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), base };
}

test("prebuilt SVG persists byte-for-byte; import is idempotent and replacement is explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapway-vector-"));
  let store = openAssetStore(join(dir, "assets.sqlite"));
  try {
    const first = await store.importFigma(input("ia-1"));
    assert.equal(first.sha256, sha256(svg));
    assert.equal(first.sourceSha256, sha256(source));
    assert.equal(first.navigationReady, false);
    assert.deepEqual(await store.importFigma(input("ia-1")), first);
    await assert.rejects(store.importFigma({ ...input("ia-1"), label: "Changed" }), { code: "ASSET_EXISTS" });
    store.close();
    store = openAssetStore(join(dir, "assets.sqlite"));
    assert.equal(store.get("ia-1").svg, svg.toString());
    assert.equal(store.list()[0].provenance.method, "manual-figma-export");
    await store.importFigma({ ...input("ia-1"), label: "Changed", replace: true });
    assert.equal(store.get("ia-1").label, "Changed");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("IA-1 prebuild cannot satisfy or replace the pending IA-4 mock", async t => {
  const a = await api(t);
  await a.store.importFigma(input("ia-1"));
  const status = await (await a.get("/status")).json();
  assert.equal(status.mockFloorId, "ia-4");
  assert.equal(status.mockStatus, "pending-asset");
  assert.equal(status.liveEnabled, false);
  const pending = await a.post("/mock", { floorId: "ia-4" });
  assert.equal(pending.status, 503);
  assert.equal((await pending.json()).error.code, "DEMO_ASSET_PENDING");
  assert.equal((await a.post("/mock", { floorId: "ia-1" })).status, 422);
  assert.equal((await a.post("/mock", {})).status, 422);
  assert.equal((await (await a.get("/prebuilt/ia-1")).json()).prebuilt, true);
  assert.equal((await a.get("/prebuilt/ia-4")).status, 404);
});

test("IA-4 replay discloses fixture origin, costs no calls and rejects source mismatch", async t => {
  const a = await api(t, { fetchImpl: () => { throw new Error("Network must not be called"); } });
  await a.store.importFigma(input("ia-4"));
  const response = await a.post("/mock", { floorId: "ia-4", sourceSha256: sha256(source) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.svg, svg.toString());
  assert.equal(result.mock, true);
  assert.equal(result.provider, "prebuilt-figma");
  assert.equal(result.disclosure, DISCLOSURE);
  assert.equal(result.navigationReady, false);
  assert.equal(result.metrics.upstreamRequests, 0);
  assert.equal(result.metrics.usd, 0);
  assert.ok(result.metrics.elapsedMs >= 0);
  assert.equal((await a.post("/mock", { floorId: "ia-4", sourceSha256: "wrong" })).status, 409);
  assert.equal((await (await a.get("/status")).json()).mockStatus, "asset-ready");
});

test("live gates refuse before HTTP and never silently use the fixture", async t => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("unexpected"); };
  await assert.rejects(vectorizeImage(source, { env: {}, fetchImpl }), { code: "VECTORIZER_DISABLED" });
  await assert.rejects(vectorizeImage(source, { env: { VECTORIZER_LIVE_ENABLED: "true" }, fetchImpl }), { code: "VECTORIZER_NOT_CONFIGURED" });
  const a = await api(t, { fetchImpl });
  await a.store.importFigma(input("ia-4"));
  const r = await a.post("/live", { floorId: "ia-4" });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "VECTORIZER_DISABLED");
  assert.equal(calls, 0);
});

test("official adapter sends Basic/multipart, preserves SVG and records actual credit header", async () => {
  let calls = 0;
  const result = await vectorizeImage(source, { env: liveEnv, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, VECTORIZER_ENDPOINT);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from("fake-id:fake-secret").toString("base64")}`);
    assert.equal(init.body.get("output.file_format"), "svg");
    assert.equal(init.body.get("policy.retention_days"), "0");
    assert.equal(init.body.get("mode"), "production");
    assert.deepEqual(Buffer.from(await init.body.get("image").arrayBuffer()), source);
    return new Response(svg, { headers: { "X-Credits-Charged": "1" } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.mock, false);
  assert.equal(result.svg, svg.toString());
  assert.equal(result.metrics.creditsCharged, 1);
  assert.equal(result.metrics.usd, null);
  assert.ok(!JSON.stringify(result).includes("fake-secret"));
});

test("upstream errors are redacted; 429 is not retried; invalid/oversized output rejected", async () => {
  let calls = 0;
  await assert.rejects(vectorizeImage(source, { env: liveEnv, fetchImpl: async () => {
    calls++; return new Response("fake-secret", { status: 429 });
  } }), e => e.status === 502 && e.code === "VECTORIZER_UPSTREAM_ERROR" && !e.message.includes("fake-secret"));
  assert.equal(calls, 1);
  await assert.rejects(vectorizeImage(source, { env: liveEnv, fetchImpl: async () => new Response("not SVG") }), { code: "VECTORIZER_INVALID_OUTPUT" });
  await assert.rejects(vectorizeImage(source, { env: liveEnv, fetchImpl: async () => new Response(Buffer.alloc(MAX_BYTES + 1)) }), { code: "VECTORIZER_OUTPUT_TOO_LARGE" });
  const noHeader = await vectorizeImage(source, { env: liveEnv, fetchImpl: async () => new Response(svg) });
  assert.equal(noHeader.metrics.creditsCharged, null);
});

test("request timeout is bounded and a failed call is never auto-retried", async () => {
  let calls = 0;
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(vectorizeImage(source, { env: liveEnv, timeoutMs: 10, fetchImpl: async (_, { signal }) => {
      calls++;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } }), { code: "VECTORIZER_TIMEOUT", status: 504 });
    assert.equal(calls, 1);
  } finally { clearInterval(keepAlive); }
});

test("bad raster and active SVG cannot enter the provider or prebuilt database", async () => {
  let calls = 0;
  await assert.rejects(vectorizeImage(Buffer.from("fake"), { env: liveEnv, fetchImpl: () => { calls++; } }), { code: "INVALID_IMAGE" });
  assert.equal(calls, 0);
  for (const unsafe of ["<script>alert(1)</script>", '<image href="https://example.com/a.png"/>', '<path onclick="alert(1)"/>']) {
    await assert.rejects(inspectSvg(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${unsafe}</svg>`)), { code: "INVALID_SVG" });
  }
});

test("live HTTP route accepts multipart and matches the mock result envelope", async t => {
  const a = await api(t, { env: liveEnv, fetchImpl: async () => new Response(svg) });
  const form = new FormData();
  form.append("floorId", "ia-4");
  form.append("image", new Blob([source], { type: "image/png" }), "floor.png");
  const response = await fetch(a.base + "/live", { method: "POST", body: form });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.floorId, "ia-4");
  assert.equal(result.provider, "vectorizer.ai");
  assert.equal(result.sha256, sha256(svg));
});
