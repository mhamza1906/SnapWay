import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone } from "../shared/map.js";
import { OpenAIProvider, GeminiProvider } from "../server/provider.js";
import {
  investigateRegion,
  runAccessJob,
  accessJobKey,
  doorwayToolDefinitions,
  DOORWAY_PROMPT_VERSION,
} from "../server/pipelines/doorways.js";
import { applyAccessDecisions } from "../shared/building/access.js";
import { routeBuilding } from "../shared/building/routing.js";
import { accessFixture } from "./fixtures/access-fixture.js";

const base = await accessFixture();
const call = (name, args, id = name + Math.random()) => ({
  type: "function_call",
  name,
  call_id: id,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});
const message = (text) => ({
  type: "message",
  content: [{ type: "output_text", text }],
});
const completed = (output) => ({
  status: "completed",
  output,
  usage: { total_tokens: 1000 },
});
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
// Fake Responses endpoint: agent turns come from `turns`; the separate
// verifier request is answered from `verifier`.
function fake(turns, verifier = { observed: "door", explanation: "Swing arc" }) {
  const requests = [];
  let turn = 0;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body, headers: options.headers });
    if (body.text?.format?.name === "segment_check")
      return reply(completed([message(JSON.stringify(verifier))]));
    const next = turns[Math.min(turn++, turns.length - 1)];
    return typeof next === "function" ? next(body) : reply(completed(next));
  };
  return {
    requests,
    provider: new OpenAIProvider({ apiKey: "test-key", model: "gpt-6.1-sol", fetchImpl }),
  };
}
const door = {
  spaceId: "fx:b",
  adjacentSpaceId: "fx:corridor",
  openingType: "door",
  a: { x: 140, y: 100.8 },
  b: { x: 150, y: 100.4 },
  confidence: 0.8,
  visualEvidence: "Door swing arc drawn in the wall between 102 and the corridor.",
};

test("agent proposes, validates, route-checks and second-checks an opening without mutating the project", async () => {
  const before = JSON.stringify(base),
    { provider, requests } = fake([
      [call("propose_opening", door, "c1")],
      [call("check_route_access", { candidateId: "candidate-1" }, "c2")],
      [message("Door verified.")],
    ]);
  const result = await investigateRegion(base, "fx", "fx:b", { provider });
  assert.equal(JSON.stringify(base), before);
  assert.equal(result.stop, "finished");
  const [record] = result.records;
  assert.equal(result.records.length, 1);
  assert.equal(record.kind, "opening");
  assert.equal(record.status, "proposed");
  assert.equal(record.review.status, "unreviewed");
  assert.deepEqual(record.segment, { a: { x: 140, y: 100 }, b: { x: 150, y: 100 } });
  assert.equal(record.validation.passed, true);
  assert.equal(record.validation.routeCheck.passed, true);
  assert.equal(record.evidence.verifier.verdict, "supported");
  assert.equal(record.evidence.model, "gpt-6.1-sol");
  assert.equal(record.evidence.provider, "OpenAI");
  assert.equal(record.evidence.promptVersion, DOORWAY_PROMPT_VERSION);
  assert.ok(record.evidence.crops.length >= 2);
  assert.equal(record.evidence.crops[0].sourceHash, base.floors[0].sources[0].hash);
  for (const r of requests) {
    assert.equal(r.url, "https://api.openai.com/v1/responses");
    assert.equal(r.body.model, "gpt-6.1-sol");
    assert.equal(r.body.store, false);
    assert.equal(r.headers.Authorization, "Bearer test-key");
  }
  const agent = requests.filter((r) => r.body.tools);
  assert.deepEqual(
    agent[0].body.tools.map((t) => t.name).sort(),
    doorwayToolDefinitions().map((t) => t.name).sort(),
  );
  assert.ok(agent[0].body.tools.every((t) => t.strict && t.parameters.additionalProperties === false));
  assert.ok(agent[1].body.input.some((i) => i.type === "function_call_output" && i.call_id === "c1"));
  assert.ok(!JSON.stringify(result).includes("test-key"));
  // The verifier is not shown the proposer's description.
  const verifier = requests.find((r) => r.body.text?.format?.name === "segment_check");
  assert.ok(!JSON.stringify(verifier.body).includes(door.visualEvidence));
  // Human acceptance is a separate transaction.
  const accepted = applyAccessDecisions(
    base,
    "fx",
    [{ op: "opening", record: { ...record, status: "accepted" } }],
    { reviewer: "Reviewer" },
  ).building;
  assert.ok(routeBuilding(accepted, "fx:a", "fx:b"));
  assert.equal(accepted.floors[0].access.records[0].evidence.verifier.verdict, "supported");
});

test("unknown tools, foreign IDs and malformed arguments are rejected as tool errors", async () => {
  const { provider, requests } = fake([
    [
      call("delete_room", { spaceId: "fx:b" }, "x1"),
      call("propose_opening", { ...door, spaceId: "fx:a" }, "x2"),
      call("propose_opening", "{not json", "x3"),
      call("inspect_region_boundary", { spaceId: "fx:nowhere" }, "x4"),
      call("propose_opening", { ...door, extra: true }, "x5"),
    ],
    [message("Nothing established.")],
  ]);
  const result = await investigateRegion(base, "fx", "fx:b", { provider });
  assert.ok(result.transcript.every((t) => !t.ok));
  const outputs = requests[1].body.input
    .filter((i) => i.type === "function_call_output")
    .map((i) => JSON.parse(i.output).error);
  assert.match(outputs[0], /Unsupported tool/);
  assert.match(outputs[1], /Only the target region/);
  assert.match(outputs[2], /Malformed JSON/);
  assert.match(outputs[3], /Unknown or non-adjacent/);
  assert.match(outputs[4], /Invalid arguments/);
  assert.deepEqual(result.records.map((r) => r.kind), ["unresolved"]);
  assert.equal(result.records[0].status, "unresolved");
  // Concluding without inspecting the boundary earns exactly one nudge.
  assert.equal(requests.length, 3);
  assert.match(requests[2].body.input.at(-1).content[0].text, /inspect_region_boundary/);
});

test("validator failures drive a bounded refinement; an unsupported second check keeps the proposal not ready", async () => {
  const { provider, requests } = fake(
    [
      [call("propose_opening", { ...door, a: { x: 140, y: 107 }, b: { x: 150, y: 107 } })],
      [call("propose_opening", door)],
      [call("check_route_access", { candidateId: "candidate-2" })],
      [message("Refined.")],
    ],
    { observed: "wall", explanation: "Continuous line" },
  );
  const result = await investigateRegion(base, "fx", "fx:b", { provider });
  const feedback = JSON.parse(
    requests[1].body.input.find((i) => i.type === "function_call_output").output,
  );
  assert.equal(feedback.validation.passed, false);
  assert.equal(feedback.validation.failures[0].code, "off-boundary");
  const [first, second, unresolved] = result.records;
  assert.equal(first.validation.passed, false);
  assert.equal(second.validation.passed, true);
  assert.equal(second.evidence.verifier.verdict, "not-supported");
  assert.match(second.reason, /^Not ready/);
  assert.equal(unresolved.kind, "unresolved");
});

test("iteration limits stop a model that never finishes", async () => {
  const { provider, requests } = fake([[call("inspect_region_boundary", { spaceId: "fx:b" })]]);
  const result = await investigateRegion(base, "fx", "fx:b", {
    provider,
    limits: { maxTurns: 3 },
  });
  assert.equal(result.stop, "turn limit");
  assert.equal(requests.length, 3);
  assert.match(result.records[0].reason, /turn limit/);
});

test("crop and proposal limits are enforced per region", async () => {
  const { provider } = fake([
    [
      call("inspect_source_region", { spaceId: "fx:b", scale: "context" }),
      call("inspect_source_region", { spaceId: "fx:corridor", scale: "detail" }),
    ],
    [message("Done.")],
  ]);
  const result = await investigateRegion(base, "fx", "fx:b", {
    provider,
    limits: { maxCrops: 3 },
  });
  assert.equal(result.transcript[0].ok, true);
  assert.match(result.transcript[1].error, /Crop limit/);
});

test("transient errors retry within bounds; persistent failure keeps other regions' partial results", async () => {
  let failing = 0;
  const { provider } = fake([
    (body) => {
      if (body.input[0].content[0].text.includes('"id":"fx:b"')) {
        failing++;
        return reply({ error: { message: "private upstream detail" } }, 500);
      }
      if (body.input.some((i) => i.type === "function_call_output"))
        return reply(completed([message("done")]));
      return reply(completed([call("record_unresolved_access", {
        spaceId: "fx:a",
        reason: "Existing door already verified; nothing new to add.",
        attemptedChecks: ["inspect"],
        evidenceLocation: { x: 45, y: 100 },
      })]));
    },
  ]);
  const job = await runAccessJob(base, "fx", ["fx:b", "fx:a"], {
    provider,
    limits: { retries: 2 },
    cacheDir: join(tmpdir(), "access-" + crypto.randomUUID()),
  });
  assert.equal(failing, 3);
  assert.equal(job.results[0].status, "failed");
  assert.match(job.results[0].error, /HTTP 500/);
  assert.ok(!job.results[0].error.includes("private upstream detail"));
  assert.equal(job.results[1].status, "complete");
  assert.equal(job.model, "gpt-6.1-sol");
});

test("job caches reuse identical identities and invalidate on geometry revision or model changes", async () => {
  const dir = join(tmpdir(), "access-" + crypto.randomUUID()),
    { provider, requests } = fake([[call("propose_opening", door)], [message("ok")]]);
  const a = await runAccessJob(base, "fx", ["fx:b"], { provider, cacheDir: dir }),
    calls = requests.length,
    z = await runAccessJob(base, "fx", ["fx:b"], { provider, cacheDir: dir });
  assert.equal(a.results[0].cached, false);
  assert.equal(z.results[0].cached, true);
  assert.equal(requests.length, calls);
  assert.deepEqual(z.results[0].records, a.results[0].records);
  const edited = clone(base);
  edited.floors[0].revision++;
  assert.notEqual(accessJobKey(edited, "fx", "fx:b", provider), a.results[0].cacheKey);
  assert.notEqual(
    accessJobKey(base, "fx", "fx:b", { name: "OpenAI", model: "other-model" }),
    a.results[0].cacheKey,
  );
  await runAccessJob(edited, "fx", ["fx:b"], { provider, cacheDir: dir });
  assert.ok(requests.length > calls);
});

test("cancellation stops work and providers without doorway tools never fall back", async () => {
  const controller = new AbortController();
  controller.abort();
  const { provider, requests } = fake([[message("x")]]);
  const job = await runAccessJob(base, "fx", ["fx:b"], {
    provider,
    signal: controller.signal,
    cacheDir: join(tmpdir(), "access-" + crypto.randomUUID()),
  });
  assert.equal(job.results[0].status, "cancelled");
  assert.equal(requests.length, 0);
  await assert.rejects(
    () => investigateRegion(base, "fx", "fx:b", { provider: new GeminiProvider() }),
    /does not expose doorway investigation tools/,
  );
  await assert.rejects(
    () =>
      runAccessJob(base, "fx", ["fx:b"], {
        provider: new OpenAIProvider({ apiKey: "", fetchImpl: () => assert.fail("network") }),
      }),
    /Configure the server image provider/,
  );
});

test("an exhausted crop allowance preserves candidates with an uncertain second check", async () => {
  const { provider, requests } = fake([[
    ...Array.from({ length: 4 }, () => call("inspect_source_region", { spaceId: "fx:b", scale: "context" })),
    call("propose_opening", door), call("check_route_access", { candidateId: "candidate-1" }),
  ]]);
  const result = await investigateRegion(base, "fx", "fx:b", { provider, limits: { maxTurns: 1, maxCrops: 6 } });
  const opening = result.records.find(r => r.kind === "opening");
  assert.ok(opening.validation.passed && opening.validation.routeCheck.passed);
  assert.equal(opening.evidence.verifier.verdict, "uncertain");
  assert.match(opening.evidence.verifier.observed, /Crop limit/);
  assert.equal(requests.length, 1);
});

test("region deadline and reported token budget cover the independent verifier", async () => {
  for (const limited of ["time", "tokens"]) {
    let calls = 0, requestOptions;
    const provider = { configured: true, name: "Synthetic", model: "fixture", async respond(body, options) {
      calls++; requestOptions = options;
      if (limited === "time") await new Promise(r => setTimeout(r, 1100));
      return { ...completed([call("propose_opening", door), call("check_route_access", { candidateId: "candidate-1" })]), usage: { total_tokens: 11 } };
    } };
    const result = await investigateRegion(base, "fx", "fx:b", { provider,
      limits: { maxTurns: 1, maxTokens: limited === "tokens" ? 10 : 1000, regionDeadlineMs: limited === "time" ? 1000 : 10000 } });
    assert.equal(calls, 1);
    assert.equal(result.records.find(r => r.kind === "opening").evidence.verifier.verdict, "uncertain");
    assert.match(result.stop, limited === "time" ? /time limit/ : /token budget/);
    assert.ok(requestOptions.timeout <= (limited === "time" ? 1000 : 10000));
    assert.ok(requestOptions.signal);
  }
});
