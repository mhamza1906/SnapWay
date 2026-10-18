import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { authoringRouter, renderFloor } from '../server/authoring-routes.js';
import { libraryEntry } from '../server/building-library.js';
import { BuildingSchema } from '../shared/building/schema.js';

let building,server,base;
before(async()=>{
  building=BuildingSchema.parse(JSON.parse(await readFile(new URL('../public/buildings/sam-ibrahim.json',import.meta.url),'utf8')));
  const app=express();app.use(express.json({limit:'15mb'}));app.use('/api/authoring',authoringRouter());
  app.use((error,_req,res,_next)=>res.status(400).json({error:error.message}));
  await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
  base=`http://127.0.0.1:${server.address().port}/api/authoring`;
});
after(()=>server?.close());
const post=async(path,data)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:response.status,data:await response.json()};};

test('built-in project is available in the normal building library with six original source frames',async()=>{
  const entry=await libraryEntry('sam-ibrahim');
  assert.equal(entry.building.id,'sam-ibrahim-hardcoded');assert.equal(entry.building.floors.length,6);
  assert.equal(entry.building.connectors.length,6);
  assert(entry.building.floors.every(f=>f.geometry.source.dataUrl.length>1000));
});
test('HTTP preview exposes real cross-floor transitions and per-floor overlays for both route choices',async()=>{
  for(const [options,type] of [[{elevatorPenalty:1000},'stairs'],[{excludeStairs:true},'elevator']]) {
    const {status,data}=await post('/routes',{building,from:'LB-R02',to:'L5-R22',options});
    assert.equal(status,200,JSON.stringify(data));assert(data.route);
    assert.deepEqual(data.route.floorIds,['LB','L1','L2','L3','L4','L5']);
    assert.equal(data.route.floors.length,6);assert.equal(data.route.transitions.length,5);
    assert(data.route.transitions.every(t=>t.type===type));
    assert.equal(data.route.instructions.filter(i=>i.targetFloorId).length,5);
    assert.equal(data.route.evidenceStatus,'assumed-project');assert.equal(data.route.accessible,false);
    assert(data.route.floors.every(f=>f.segments.every(s=>s.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))));
  }
});
test('unverified accessibility and unsupported route inputs cannot bypass graph checks',async()=>{
  const a=await post('/routes',{building,from:'LB-R02',to:'L5-R22',options:{verifiedAccessible:true}});
  assert.equal(a.status,200);assert.equal(a.data.route,null);assert.match(a.data.message,/verified accessibility/);
  for(const options of [{excludeStairs:'yes'},{stairsPenalty:-1},{elevatorPenalty:Infinity},{unknown:true}]) {
    const r=await post('/routes',{building,from:'LB-R02',to:'L5-R22',options});assert.equal(r.status,400);
  }
});
test('project renders original SVG geometry and six labelled cores without altering routing',()=>{
  const before=JSON.stringify(building);
  for(const f of building.floors) {
    const svg=renderFloor(building,f.id);
    assert.match(svg,/inferred project routes/);
    assert.equal((svg.match(/data-connector-id=/g)||[]).length,6);
    for(const label of ['Stair A','Stair B','Stair C','Stair D','Elevator B','Elevator C'])assert(svg.includes(label),label);
    assert.match(svg,/data-room-id=/);assert.match(svg,/data-door-id=/);
  }
  assert.equal(JSON.stringify(building),before);
});
