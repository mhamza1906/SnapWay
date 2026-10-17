import { hasWaterloo, waterlooText, wtest } from "./fixtures/optional.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AnthropicProvider, createProvider } from "../server/provider.js";
import { anthropicSchema, anthropicMessages } from "../server/anthropic.js";
import { investigateRegion, accessJobKey } from "../server/pipelines/doorways.js";
import { suggestDesign } from "../server/pipelines/design.js";
import { accessFixture } from "./fixtures/access-fixture.js";

const fixture = JSON.parse(await readFile("public/sample/original-extraction.json", "utf8"));
const geometry = Object.fromEntries(["floorName", "spaces", "walls", "doors", "pois"].map(k => [k, fixture[k]]));
geometry.issues = [];
const thinking = { type: "thinking", thinking: "", signature: "signed-fixture" };
const text = value => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) });
const tool = (name, input, id) => ({ type: "tool_use", id, name, input });
const reply = (content, stop_reason = "end_turn") => new Response(JSON.stringify({
  id: "msg_fixture", model: "claude-opus-5-5", content, stop_reason,
  usage: { input_tokens: 10, output_tokens: 5 },
}));
const fake = handler => {
  const requests = [];
  const provider = new AnthropicProvider({
    apiKey: "synthetic-anthropic-key", model: "claude-opus-5-5", effort: "high",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body, headers: options.headers, signal: options.signal });
      return handler(body, requests.length);
    },
  });
  return { provider, requests };
};

test("Anthropic vision extraction uses exact Opus/high, native structured JSON and mandatory draft review", async () => {
  const { provider, requests } = fake(() => reply([thinking, text(geometry)]));
  const map = await provider.extract(fixture.source);
  const { body, headers, url } = requests[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["x-api-key"], "synthetic-anthropic-key");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.output_config.effort, "high");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.store, undefined);
  assert.equal(body.reasoning, undefined);
  assert.equal(body.messages[0].content[1].source.data, fixture.source.dataUrl.split(",")[1]);
  assert.equal(map.extraction.provider, "Anthropic");
  assert.equal(map.extraction.model, "claude-opus-5-5");
  assert.equal(map.review.status, "draft");
  assert.ok(map.review.issues.some(i => !i.resolved));
  assert.deepEqual(map.graph, { nodes: [], edges: [] });
  assert.ok(!JSON.stringify(map).includes("synthetic-anthropic-key"));
});

test("inventory uses the same Anthropic high-effort transport", async () => {
  const inventory = { items: [{ label: "102A", kind: "room", position: {x:3,y:4} }], footprints: [], notes: [] };
  const { provider, requests } = fake(() => reply([text(inventory)]));
  assert.deepEqual(await provider.inventory(fixture.source), inventory);
  assert.equal(requests[0].body.output_config.effort, "high");
});

test("Claude schema adaptation preserves local constraints and does not mutate original schemas", async () => {
  const original = { type: "object", properties: {
    minimum: { type: "number", minimum: 0, maximum: 1 },
    ids: { type: "array", minItems: 3, maxItems: 60, items: { type: "string", minLength: 1 } },
  }, required: ["minimum", "ids"], additionalProperties: false };
  const before = JSON.stringify(original), adapted = anthropicSchema(original);
  assert.equal(JSON.stringify(original), before);
  assert.ok(adapted.properties.minimum);
  assert.equal(adapted.properties.minimum.minimum, undefined);
  assert.match(adapted.properties.minimum.description, /maximum: 1/);
  assert.equal(adapted.properties.ids.minItems, 1);
  const invalid = structuredClone(geometry);
  invalid.spaces[0].confidence = 2;
  const { provider } = fake(() => reply([text(invalid)]));
  await assert.rejects(() => provider.extract(fixture.source), /invalid extraction/);
});

test("tool continuations preserve signed/redacted thinking and ordered parallel results", () => {
  const redacted = { type: "redacted_thinking", data: "opaque-fixture" };
  const input = [
    { role: "user", content: [{type:"input_text",text:"Inspect"}] },
    { type: "reasoning", anthropic_block: thinking },
    { type: "reasoning", anthropic_block: redacted },
    { type: "function_call", name: "one", call_id: "c1", arguments: "{}" },
    { type: "function_call", name: "two", call_id: "c2", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: '{"ok":true}' },
    { type: "function_call_output", call_id: "c2", output: '{"ok":false,"error":"Unknown ID"}' },
    { role: "user", content: [{type:"input_image",image_url:fixture.source.dataUrl}] },
  ];
  const messages = anthropicMessages(input);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1].content.slice(0,2), [thinking,redacted]);
  assert.deepEqual(messages[2].content.map(c=>c.type), ["tool_result","tool_result","image"]);
  assert.equal(messages[2].content[1].is_error, true);
  assert.throws(() => anthropicMessages([{type:"reasoning",encrypted_content:"foreign"}]), /Unsupported/);
});

test("the complete doorway loop works with native Claude tools and high-effort second look", async () => {
  const base = await accessFixture(), before = JSON.stringify(base);
  let turn = 0;
  const { provider, requests } = fake(body => {
    if (body.output_config.format) return reply([text({observed:"door",explanation:"Synthetic swing arc"})]);
    turn++;
    if (turn === 1) return reply([thinking,
      tool("inspect_region_boundary", {spaceId:"fx:b"}, "c0"),
      tool("propose_opening", {spaceId:"fx:b",adjacentSpaceId:"fx:corridor",openingType:"door",a:{x:140,y:100},b:{x:150,y:100},confidence:0.8,visualEvidence:"Synthetic swing arc in shared wall."}, "c1"),
    ], "tool_use");
    if (turn === 2) return reply([thinking,tool("check_route_access", {candidateId:"candidate-1"}, "c2")], "tool_use");
    return reply([thinking,text("Opening proposed for source review.")]);
  });
  const result = await investigateRegion(base, "fx", "fx:b", {provider});
  assert.equal(JSON.stringify(base), before);
  assert.equal(result.records[0].status, "proposed");
  assert.equal(result.records[0].validation.routeCheck.passed, true);
  assert.equal(result.records[0].evidence.verifier.verdict, "supported");
  assert.equal(result.records[0].evidence.provider, "Anthropic");
  for (const request of requests) {
    assert.equal(request.body.model, "claude-opus-5-5");
    assert.equal(request.body.output_config.effort, "high");
    if (request.body.tools) {
      assert.equal(request.body.tool_choice.type, "auto");
      assert.ok(request.body.tools.every(t=>t.strict && t.input_schema.additionalProperties===false));
    }
  }
  assert.deepEqual(requests[1].body.messages[1].content[0], thinking);
  assert.equal(requests[0].body.system, requests[1].body.system);
  assert.notEqual(accessJobKey(base,"fx","fx:b",provider), accessJobKey(base,"fx","fx:b",{...provider,effort:"medium"}));
});

wtest("Anthropic design exposes only appearance tools and keeps geometry unchanged", async () => {
  const b = JSON.parse(waterlooText()), before=JSON.stringify(b);
  const layout = {title:"Claude test",padding:5,wallWidth:1,showTitle:true,showLegend:true,showDoors:true};
  const { provider, requests } = fake(() => reply([thinking,tool("set_map_layout",layout,"layout")],"tool_use"));
  const result=await suggestDesign(b,b.floors[3].id,"Use a clean layout",{provider});
  assert.equal(JSON.stringify(b),before);
  assert.equal(result.presentation.title,"Claude test");
  assert.equal(result.presentation.lastAI.provider,"Anthropic");
  assert.equal(result.presentation.lastAI.model,"claude-opus-5-5");
  assert.equal(requests[0].body.tools.length,4);
  assert.equal(requests[0].body.output_config.effort,"high");
});

test("Anthropic errors, refusals and incomplete outputs fail without leaking upstream details or falling back", async () => {
  for (const response of [
    () => new Response('{"error":{"message":"private upstream detail"}}',{status:401}),
    () => reply([text("no")],"refusal"),
    () => reply([text("partial")],"max_tokens"),
    () => reply([text("{")]),
  ]) {
    const {provider,requests}=fake(response);
    await assert.rejects(()=>provider.extract(fixture.source), error=>{
      assert.ok(!error.message.includes("private upstream detail"));
      assert.ok(!error.message.includes("synthetic-anthropic-key"));
      return /HTTP 401|declined|did not complete|invalid extraction/.test(error.message);
    });
    assert.equal(requests.length,1);
  }
  const provider=new AnthropicProvider({apiKey:"",fetchImpl:()=>assert.fail("network")});
  await assert.rejects(()=>provider.extract(fixture.source),/ANTHROPIC_API_KEY/);
});

test("Claude transport preserves cancellation and enforces configured model/effort over caller fields", async () => {
  const controller=new AbortController();
  const {provider,requests}=fake(()=>reply([text("OK")]));
  await provider.respond({input:[{role:"user",content:"Hello"}],model:"other",reasoning:{effort:"low"},output_config:{effort:"low"}},{signal:controller.signal});
  controller.abort();
  assert.equal(requests[0].signal.aborted,true);
  assert.equal(requests[0].body.model,"claude-opus-5-5");
  assert.equal(requests[0].body.output_config.effort,"high");
});

test("provider factory selects Anthropic without substituting another model", () => {
  const names=["AI_PROVIDER","ANTHROPIC_MODEL","ANTHROPIC_EFFORT","ANTHROPIC_API_KEY"];
  const before=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  try {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
      Object.assign(process.env,{AI_PROVIDER:"anthropic",ANTHROPIC_MODEL:model,ANTHROPIC_EFFORT:"high",ANTHROPIC_API_KEY:"fixture"});
      const p=createProvider();
      assert.ok(p instanceof AnthropicProvider);
      assert.equal(p.model,model);
      assert.equal(p.effort,"high");
    }
  } finally {
    for(const k of names) if(before[k]===undefined) delete process.env[k]; else process.env[k]=before[k];
  }
});

test("pipeline extraction omits redundant wall arrays while preserving the geometry schema and configured model", async () => {
  const withoutWalls = { ...geometry }; delete withoutWalls.walls;
  const { provider, requests } = fake(() => reply([text(withoutWalls)]));
  const result = await provider.extract(fixture.source, { deriveWalls: true });
  assert.equal(requests[0].body.output_config.format.schema.properties.walls, undefined);
  assert.equal(requests[0].body.max_tokens, 16000);
  assert.equal(requests[0].body.model, "claude-opus-5-5");
  assert.match(requests[0].body.messages[0].content[0].text, /derived locally/);
  assert.deepEqual(result.walls, []);
  assert.deepEqual(result.spaces, fixture.spaces);
});
