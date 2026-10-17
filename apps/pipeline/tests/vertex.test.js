import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { VertexProvider, createProvider } from "../server/provider.js";
import { vertexContents, vertexSchema } from "../server/vertex.js";

const fixture = JSON.parse(await readFile("public/sample/original-extraction.json", "utf8"));
const geometry = Object.fromEntries(["floorName", "spaces", "walls", "doors", "pois"].map(k => [k, fixture[k]]));
geometry.issues = [];
const reply = (parts, finishReason = "STOP") => new Response(JSON.stringify({
  responseId: "resp_fixture", modelVersion: "gemini-4-argon",
  candidates: [{ content: { role: "model", parts }, finishReason }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 18 },
}));
const fake = handler => {
  const requests = [];
  const provider = new VertexProvider({
    apiKey: "synthetic-vertex-key", project: "fixture-project", location: "global",
    model: "gemini-4-argon", effort: "high",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body, headers: options.headers });
      return handler(body, requests.length);
    },
  });
  return { provider, requests };
};

test("Vertex extraction sends the image, schema and effort to the exact project model", async () => {
  const { provider, requests } = fake(() => reply([{ text: JSON.stringify(geometry) }]));
  const map = await provider.extract(fixture.source);
  const { url, body, headers } = requests[0];
  assert.equal(url, "https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-4-argon:generateContent");
  assert.equal(headers["x-goog-api-key"], "synthetic-vertex-key");
  assert.ok(!url.includes("synthetic-vertex-key"));
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.ok(body.generationConfig.responseJsonSchema.properties.spaces);
  assert.equal(body.generationConfig.maxOutputTokens, 24000);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, "image/png");
  assert.equal(map.extraction.provider, "Vertex AI");
  assert.equal(map.extraction.model, "gemini-4-argon");
  assert.equal(map.review.status, "draft");
  assert.ok(!JSON.stringify(map).includes("synthetic-vertex-key"));
});

test("Vertex tool turns replay signed model parts and name each tool result", async () => {
  const signed = { functionCall: { name: "inspect", args: { id: "r1" } }, thoughtSignature: "sig-fixture" };
  const { provider, requests } = fake((body, n) => n === 1
    ? reply([signed, { functionCall: { name: "classify", args: {} } }])
    : reply([{ text: "done" }]));
  const tools = [{ type: "function", name: "inspect", description: "d", parameters: { type: "object", properties: {} } },
    { type: "function", name: "classify", description: "d", parameters: { type: "object", properties: {} } }];
  const input = [{ role: "user", content: [{ type: "input_text", text: "go" }] }];
  const first = await provider.respond({ input, tools, tool_choice: "required" });
  assert.equal(requests[0].body.toolConfig.functionCallingConfig.mode, "ANY");
  assert.equal(requests[0].body.tools[0].functionDeclarations[0].parametersJsonSchema.type, "object");
  const calls = first.output.filter(o => o.type === "function_call");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].call_id, calls[1].call_id);
  assert.deepEqual(first.usage, { input_tokens: 10, output_tokens: 8, total_tokens: 18 });
  input.push(...first.output, ...calls.map(c => ({ type: "function_call_output", call_id: c.call_id, output: JSON.stringify({ ok: true }) })));
  const second = await provider.respond({ input, tools });
  assert.equal(requests[1].body.toolConfig.functionCallingConfig.mode, "AUTO");
  const [user, model, results] = requests[1].body.contents;
  assert.equal(user.role, "user");
  assert.deepEqual(model.parts[0], signed);
  assert.deepEqual(results.parts.map(p => p.functionResponse.name), ["inspect", "classify"]);
  assert.equal(second.output[0].content[0].text, "done");
});

test("Vertex conversations skip other providers' reasoning and reject orphan tool results", () => {
  assert.deepEqual(vertexContents([{ role: "user", content: "hi" }, { type: "reasoning", anthropic_block: {} }]),
    [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.throws(() => vertexContents([{ role: "user", content: "hi" }, { type: "function_call_output", call_id: "x", output: "{}" }]), /no matching tool call/);
});

test("Vertex schemas drop maxItems, which Vertex rejects, and note it for the model", () => {
  const schema = vertexSchema({ $schema: "x", type: "object", properties: {
    rooms: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", maxLength: 80 } } } });
  assert.deepEqual(schema, { type: "object", properties: { rooms: { type: "array", minItems: 1,
    items: { type: "string", maxLength: 80 }, description: "Locally enforced constraints: maxItems: 500." } } });
});

for (const [name, response, expected] of [
  ["HTTP error", () => new Response(JSON.stringify({ error: { message: "private details" } }), { status: 403 }), /HTTP 403/],
  ["token limit", () => reply([{ text: "{" }], "MAX_TOKENS"), /did not complete/],
  ["safety stop", () => reply([], "SAFETY"), /declined/],
]) test(`Vertex rejects ${name} without a fallback call`, async () => {
  let calls = 0;
  const { provider } = fake(() => { calls++; return response(); });
  await assert.rejects(() => provider.extract(fixture.source), error => {
    assert.match(error.message, expected);
    assert.ok(!error.message.includes("private details"));
    return true;
  });
  assert.equal(calls, 1);
});

test("provider factory uses Vertex in prod and refuses development providers there", () => {
  const names = ["APP_ENV", "AI_PROVIDER", "VERTEX_API_KEY", "VERTEX_PROJECT", "VERTEX_MODEL", "VERTEX_EFFORT"];
  const before = Object.fromEntries(names.map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, { APP_ENV: "prod", AI_PROVIDER: "vertex", VERTEX_API_KEY: "fixture",
      VERTEX_PROJECT: "fixture-project", VERTEX_MODEL: "gemini-4-argon", VERTEX_EFFORT: "high" });
    const provider = createProvider();
    assert.ok(provider instanceof VertexProvider);
    assert.equal(provider.model, "gemini-4-argon");
    assert.equal(provider.effort, "high");
    assert.equal(provider.configured, true);
    process.env.AI_PROVIDER = "anthropic";
    assert.throws(() => createProvider(), /APP_ENV=prod requires AI_PROVIDER=vertex/);
    process.env.APP_ENV = "dev";
    process.env.AI_PROVIDER = "vertex";
    process.env.VERTEX_EFFORT = "max";
    assert.throws(() => createProvider(), /VERTEX_EFFORT must be/);
  } finally {
    for (const k of names) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
  }
});
