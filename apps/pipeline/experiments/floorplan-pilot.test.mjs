import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { compileSchema,convertPoint,validateTrace,renderSvg } from './floorplan-pilot.mjs';

function trace() {return {request_id:'request',frame_id:'frame',coordinate_space:'crop_n1000_xy',spaces:[{local_id:'r1',role:'room',polygon:[{x:100,y:100},{x:800,y:100},{x:800,y:800},{x:100,y:800}],label_refs:['brainstorm'],observation:'visible'}],opening_candidates:[],unresolved:[]};}
test('normalized coordinates preserve a nonsquare image and reject invalid numbers',()=>{
  assert.deepEqual(convertPoint({x:500,y:500},1405,625),{x:702.5,y:312.5});
  for(const x of [NaN,Infinity,-1,1001])assert.throws(()=>convertPoint({x,y:1},100,100));
});
test('native schema projection resolves nested refs without mutating the local contract',()=>{
  const schema={$defs:{point:{type:'number',maximum:1000}},type:'object',properties:{x:{$ref:'#/$defs/point'}}};
  assert.deepEqual(compileSchema(schema),{type:'object',properties:{x:{type:'number',maximum:1000}}});
  assert.equal(schema.properties.x.$ref,'#/$defs/point');
});
test('frame, duplicate identifiers, labels, self-crossings and unknown opening adjacency fail closed',()=>{
  assert.equal(validateTrace(trace(),'request','frame'),true);
  assert.throws(()=>validateTrace(trace(),'old-request','frame'));
  let t=trace();t.spaces.push(structuredClone(t.spaces[0]));assert.throws(()=>validateTrace(t,'request','frame'));
  t=trace();t.spaces[0].label_refs=['untrusted'];assert.throws(()=>validateTrace(t,'request','frame'));
  t=trace();t.spaces[0].polygon=[{x:0,y:0},{x:900,y:900},{x:0,y:900},{x:900,y:0}];assert.throws(()=>validateTrace(t,'request','frame'));
  t=trace();t.opening_candidates=[{local_id:'d1',a:{x:100,y:100},b:{x:200,y:100},adjacent_local_ids:['missing']}];assert.throws(()=>validateTrace(t,'request','frame'));
});
test('renderer puts interactive labels inside the only map SVG and emits no executable content',()=>{
  const s={footprint:trace().spaces[0].polygon,walls:[],stairs:[],seating:[],door_symbols:[]};
  const svg=renderSvg(trace(),s,1405,625);
  assert.equal((svg.match(/<svg\b/g)||[]).length,1);
  assert.ok(svg.indexOf('id="map-labels"')>svg.indexOf('id="floorMap"'));
  assert.match(svg,/data-target="label-r1"/);assert.match(svg,/role="button" tabindex="0"/);
  assert.doesNotMatch(svg,/<script|<image|foreignObject|https?:\/\/(?!www.w3.org)/);
});
test('recorded Stair C response fails polygon validation even though the provider completed',async()=>{
  const t=JSON.parse(await readFile(new URL('../../../docs/audits/assets/2026-10-17-gemini-vector-pilot/stair-c-detail/trace.json',import.meta.url),'utf8'));
  assert.throws(()=>validateTrace(t,'candidate-d1542c73969761c5-trace','candidate-d1542c73969761c5'),/Self-intersecting polygon: stair_c_landing/);
});
test('recorded door-detail response passes basic polygon checks without implying route acceptance',async()=>{
  const t=JSON.parse(await readFile(new URL('../../../docs/audits/assets/2026-10-17-gemini-vector-pilot/door-detail/trace.json',import.meta.url),'utf8'));
  assert.equal(validateTrace(t,'candidate-71a4013b353db9b2-trace','candidate-71a4013b353db9b2'),true);
});
test('dynamic original-photo label registry supports new IDs without relaxing unknown-label checks',()=>{
  const t=trace();t.spaces[0].label_refs=['source-room-1'];
  const registry=[{id:'source-room-1',text:'Read from original'}];
  assert.equal(validateTrace(t,'request','frame',registry),true);
  assert.throws(()=>validateTrace(t,'request','frame'));
  const s={footprint:t.spaces[0].polygon,walls:[],stairs:[],seating:[],door_symbols:[]};
  assert.match(renderSvg(t,s,1405,625,registry),/Read from original/);
});
