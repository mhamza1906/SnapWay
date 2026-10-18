import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactSvg } from "../server/svg-analysis.js";
import { vectorize } from "../server/vectorizer.js";

test("compactSvg numbers shapes, rounds coordinates and turns arcs into lines", () => {
  const svg = `<svg viewBox="0.00 0.00 100.00 50.00"><g><path stroke="#000" vector-effect="non-scaling-stroke" d="M 1.40 2.60 L 10.51 2.49 A 0.5 0.5 0 0 1 11.2 3.1 Q 20.2 5.7 30.6 9.4 Z"/><path fill="#888" d="M 0 0 L 5 0 L 5 0 L 5 5 Z"/></g></svg>`;
  const c = compactSvg(svg);
  assert.equal(c.width, 100);
  assert.equal(c.height, 50);
  assert.deepEqual(c.shapes.map((s) => s.id), ["p1", "p2"]);
  assert.match(c.svg, /<path id="p1" stroke="#000" d="M1 3L11 2L11 3Q20 6 31 9Z"\/>/);
  assert.match(c.svg, /<path id="p2" fill="#888" d="M0 0L5 0L5 5Z"\/>/, "zero-length steps are dropped");
  assert.doesNotMatch(c.svg, /vector-effect/);
});

test("vectorize is refused in prod and stops at the call limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vec-")), env = { ...process.env };
  try {
    process.env.VECTORIZER_API_ID = "id";
    process.env.VECTORIZER_API_SECRET = "secret";
    process.env.APP_ENV = "prod";
    await assert.rejects(vectorize(Buffer.from("a"), { dir }), /development-only/);
    process.env.APP_ENV = "dev";
    process.env.VECTORIZER_MAX_CALLS = "1";
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response("<svg/>", { status: 200, headers: { "x-credits-charged": "1" } }); };
    const first = await vectorize(Buffer.from("a"), { dir, fetchImpl });
    assert.equal(first.cached, false);
    assert.equal((await vectorize(Buffer.from("a"), { dir, fetchImpl })).cached, true, "the same image is served from the cache");
    await assert.rejects(vectorize(Buffer.from("b"), { dir, fetchImpl }), /limit reached \(1\/1/);
    assert.equal(calls, 1);
  } finally {
    process.env = env;
  }
});
