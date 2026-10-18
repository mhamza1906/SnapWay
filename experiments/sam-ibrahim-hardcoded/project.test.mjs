import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSamIbrahimProject, routeSamIbrahimProject } from './project.mjs';
import { buildExperiment } from './model.mjs';
import { parseBuilding } from '../../apps/pipeline/shared/building/schema.js';
import { validateBuilding, edgeIssue } from '../../apps/pipeline/shared/building/validation.js';
import { roomAvailability } from '../../apps/pipeline/shared/building/routing.js';

let project;
test.before(()=>{project=buildSamIbrahimProject();});
test('six named cores have one allocated landing per floor and adjacent assumed links only',()=>{
  const b=project.building;
  assert.equal(b.connectors.length,6);assert.equal(project.report.landings.length,36);
  assert.equal(b.edges.filter(e=>e.floorId===null).length,30);
  const order=['LB','L1','L2','L3','L4','L5'];
  for(const c of b.connectors) {
    assert.equal(c.landingIds.length,6);assert.match(c.evidence,/ASSUMED/);
    assert.match(c.evidence,/not field verified/);
    for(const e of b.edges.filter(e=>e.connectorId===c.id)) {
      const a=b.nodes.find(n=>n.id===e.from),z=b.nodes.find(n=>n.id===e.to);
      assert.equal(Math.abs(order.indexOf(a.floorId)-order.indexOf(z.floorId)),1);
      assert.equal(e.accessible,'unknown');
    }
  }
});
test('all six floors route in both directions with stairs and stairs-free elevator options',()=>{
  const rooms=['LB-R02','L1-R01','L2-R03','L3-R01','L4-R31','L5-R22'];
  for(const a of rooms)for(const b of rooms)if(a!==b) {
    const stairs=routeSamIbrahimProject(project,a,b,{elevatorPenalty:1000});
    const elevator=routeSamIbrahimProject(project,a,b,{excludeStairs:true});
    assert(stairs,`${a} -> ${b} stairs`);assert(elevator,`${a} -> ${b} elevator`);
    assert(stairs.steps.some(s=>s.traversal==='stairs'));
    assert(stairs.steps.every(s=>s.traversal!=='elevator'));
    assert(elevator.steps.some(s=>s.traversal==='elevator'));
    assert(elevator.steps.every(s=>s.traversal!=='stairs'));
    assert.equal(elevator.accessible,false);
  }
  assert(routeSamIbrahimProject(project,'L5-R22','L5-R68'));
  assert(routeSamIbrahimProject(project,'L4-R31','L4-R65'));
});
test('all available traced rooms reach the basement; unknown access and projection stay unavailable',()=>{
  for(const r of roomAvailability(project.building).filter(r=>r.ready&&r.id!=='LB-R02'))assert(routeSamIbrahimProject(project,r.id,'LB-R02'),r.id);
  assert.equal(routeSamIbrahimProject(project,'L3-R07','L5-R22'),null);
  assert.equal(routeSamIbrahimProject(project,'LB-R02','L5-R22',{verifiedAccessible:true}),null);
});
test('source-corrected Level 2 openings enable four rooms through distinct terminal doorways',()=>{
  const b=project.building,f=b.floors.find(f=>f.id==='L2');
  assert.equal(roomAvailability(b).filter(r=>r.ready).length,50);
  for(const id of ['L2-R01','L2-R02','L2-R06','L2-R07']) {
    for(const options of [{elevatorPenalty:1000},{excludeStairs:true}]) {
      assert(routeSamIbrahimProject(project,id,'L5-R22',options),id);
      assert(routeSamIbrahimProject(project,'LB-R02',id,options),id);
    }
    assert(routeSamIbrahimProject(project,id,'L2-R11'),id);
  }
  for(const id of ['L2:P01','L2:P02','L2:P06','L2:P07','L2:P08','L2:P09']) {
    const door=f.geometry.doors.find(d=>d.id===id);
    assert(door,id);
    const record=f.access.records.find(r=>r.doorId===id);
    assert.equal(record.review.status,'agent-inspected');
    assert.equal(record.evidence.method,'assumed');
    assert(record.evidence.description.includes('SVG'));
  }
  const spot=f.geometry.doors.find(d=>d.id==='L2:P02');
  assert(Math.abs(spot.a.y-79)<0.01&&Math.abs(spot.b.y-79)<0.01);
  const keystone=f.geometry.doors.find(d=>d.id==='L2:P09');
  assert(keystone.a.x>=307-0.01&&keystone.b.x<=317+0.01);
  // No automatic edge through tiered seating between these two entrances.
  for(const pair of [['L2:P06','L2:P07'],['L2:P08','L2:P09']]) {
    const ids=b.nodes.filter(n=>pair.includes(n.doorId)).map(n=>n.id);
    assert.equal(ids.length,2);
    assert(!b.edges.some(e=>ids.includes(e.from)&&ids.includes(e.to)));
  }
});
test('project export passes unchanged schema/geometry checks and strict experiment stays separate',()=>{
  const b=parseBuilding(JSON.parse(JSON.stringify(project.building)));
  assert.deepEqual(validateBuilding(b).filter(i=>i.severity==='error'),[]);
  const contexts=new Map();for(const e of b.edges)assert.equal(edgeIssue(b,e,{contexts}),null,e.id);
  assert(b.floors.every(f=>f.geometry.scale===null));assert.equal(b.photos.length,0);
  assert(b.floors.flatMap(f=>f.access.records).every(r=>r.review.status==='agent-inspected'));
  assert.equal(buildExperiment().building.connectors.length,0);
  assert(project.report.sourceAudit.ok);
});
test('project builds reproduce the same building and connector report',()=>{
  const again=buildSamIbrahimProject();
  assert.deepEqual(again.building,project.building);
  assert.deepEqual(again.report,project.report);
});
