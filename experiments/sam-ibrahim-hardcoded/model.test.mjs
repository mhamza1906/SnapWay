import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExperiment, inventory, floors, summarize } from './model.mjs';
import { routePipelineArtifact } from './pipeline-adapter.mjs';
import { parseBuilding } from '../../apps/pipeline/shared/building/schema.js';
import { edgeIssue } from '../../apps/pipeline/shared/building/validation.js';
import { verifySvgEvidence } from './svg-tools.mjs';

let experiment;
test.before(()=>{experiment=buildExperiment();});

test('all printed observations and globally scoped portals survive, without invented coordinates',()=>{
  const rg=experiment.reviewGraph;
  assert.equal(rg.observations.length,366);assert.equal(rg.portals.length,330);
  assert.equal(new Set(rg.observations.map(n=>n.id)).size,366);
  assert.equal(new Set(rg.portals.map(n=>n.id)).size,330);
  assert(rg.portals.every(p=>p.position===null && p.point===null && !p.traversable));
  assert(rg.observations.every(n=>n.coordinateFrameId.endsWith('report-crop-normalized')&&!n.walkablePoint));
  const ids=new Set([...rg.observations,...rg.portals,...rg.landings].map(n=>n.id));
  for(const edge of rg.links){assert(ids.has(edge.from),edge.from);assert(ids.has(edge.to),edge.to);assert.equal(edge.traversable,false);}
});

test('named cores are matched separately from unresolved landing geometry and actual connectors',()=>{
  const rg=experiment.reviewGraph;
  assert.equal(rg.landings.filter(l=>l.coreId).length,36);
  assert.equal(rg.links.filter(l=>l.relation==='adjacent-floor-core-match').length,30);
  assert(rg.landings.every(l=>l.point===null&&l.elevation===null));
  assert.equal(experiment.building.connectors.length,0);
  assert(experiment.building.edges.every(e=>e.floorId && !e.connectorId));
  const portalIds = new Set(rg.portals.map(p=>p.id));
  for (const landing of experiment.report.candidateLandings) {
    for (const id of landing.portalIds) assert(portalIds.has(id), `Unresolved portal reference: ${id}`);
  }
});

test('all six original SVG frames and source references are valid, separate from PDF coordinates',()=>{
  const audit=verifySvgEvidence(floors);assert(audit.ok,JSON.stringify(audit.issues));
  assert.equal(audit.floors.length,6);
  assert.equal(experiment.metadata.crossFrameTransform,null);
  assert(experiment.geometryVertices.every(v=>v.coordinateFrameId.startsWith('svg-original-')));
});

test('pipeline export round-trips and each retained edge passes unchanged geometry validation',()=>{
  for(const b of [experiment.building,experiment.navigationBundle]) {
    const parsed=parseBuilding(JSON.parse(JSON.stringify(b)));
    assert.equal(parsed.nodes.length,b.nodes.length);
    const contexts=new Map();for(const edge of parsed.edges) assert.equal(edgeIssue(parsed,edge,{contexts}),null,edge.id);
    assert(parsed.floors.every(f=>f.geometry.scale===null));
    assert(parsed.floors.flatMap(f=>f.access.records).every(r=>r.review.status==='agent-inspected'));
  }
});

test('representative same-floor SVG routes work in both directions only with draft opt-in',()=>{
  for(const [from,to] of [['LB-R02','LB-R03'],['L1-R01','L1-R02'],['L2-R03','L2-R11'],['L3-R01','L3-R19'],['L4-R31','L4-R65'],['L5-R58','L5-R68']]) {
    assert.equal(routePipelineArtifact(experiment,from,to),null);
    const f=routePipelineArtifact(experiment,from,to,{allowDraft:true}),r=routePipelineArtifact(experiment,to,from,{allowDraft:true});
    assert(f,`${from}->${to}`);assert(r,`${to}->${from}`);
    assert.equal(f.floorIds.length,1);assert.equal(f.evidenceStatus,'draft-assumed');
    assert(Math.abs(f.cost-r.cost)<1e-8);
    assert.equal(routePipelineArtifact(experiment,from,to,{allowDraft:true,verifiedAccessible:true}),null);
  }
});

test('projection, unknown doorway, unconnected components and floor candidates never create a route',()=>{
  for(const [from,to] of [['L3-R07','L3-R01'],['L2-R01','L2-R11'],['L2-R06','L2-R11'],['L2-R02','L2-R11'],['L2-R07','L2-R11'],['L2-R03','L3-R01'],['L5-R22','L5-R68'],['L4-RG-W','L4-R31']])
    assert.equal(routePipelineArtifact(experiment,from,to,{allowDraft:true}),null,`${from}->${to}`);
  assert.equal(experiment.reviewGraph.physicalEntities.find(e=>e.id==='physical-room:cloud').excludedEntranceDepictions[0],'L3-R07');
});

test('coverage never equates preserved annotations with traced geometry or all portal candidates with doors',()=>{
  const s=summarize(experiment);assert.equal(s.complete,false);assert.equal(s.providerCalls,0);
  assert(s.tracedRegions<366);assert(s.draftThresholds<330);
  for(const c of experiment.coverage) {
    assert.equal(c.tracedInventoryRegions+c.remainingRegionIds.length,c.inventoryRegions);
    assert.equal(c.placedDraftPortalCandidates+c.remainingPortalIds.length,c.inventoryPortalCandidates);
  }
  assert(experiment.coverage.find(c=>c.floorId==='L2').positionedButUnresolvedPortalIds.includes('L2:P06'));
});

test('capture suggestions do not claim metric scale, photos or a localized user position',()=>{
  assert(experiment.capturePlans.length>0);
  assert(experiment.capturePlans.every(p=>p.mode==='manual'&&!p.scaleVerified&&p.spacingM===null&&p.photos.length===0));
  assert(experiment.capturePlans.flatMap(p=>p.points).every(p=>p.distanceM===null));
});
