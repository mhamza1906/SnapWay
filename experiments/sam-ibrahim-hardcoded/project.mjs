// Sam Ibrahim only: the user's explicitly requested inferred cross-floor
// project. The original offline experiment remains strict and unchanged.
import { floors, inventory, reviewQuestions } from './model.mjs';
import { createRequire } from 'node:module';
import { projectConnectorFloors } from './data/project-connectors.mjs';
import { buildPipelineArtifact } from './pipeline-adapter.mjs';
import { createReviewGraph } from './review-graph.mjs';
import { verifySvgEvidence } from './svg-tools.mjs';
import { newNode, newEdge, connectLandings, revalidateGraph } from '../../apps/pipeline/shared/building/graph.js';
import { inside, distance, intersection, pointSegment } from '../../apps/pipeline/shared/map.js';
import { segmentProblem, edgeIssue, validateBuilding } from '../../apps/pipeline/shared/building/validation.js';
import { parseBuilding } from '../../apps/pipeline/shared/building/schema.js';
import { routeBuilding } from '../../apps/pipeline/shared/building/routing.js';
import { segmentOverlap } from '../../apps/pipeline/shared/building/access.js';

const polygonClipping=createRequire(new URL('../../apps/pipeline/package.json',import.meta.url))('polygon-clipping');

export const PROJECT_ID = 'sam-ibrahim-hardcoded';
const AT = '2026-10-18T12:00:00.000Z';
const ORDER = ['LB','L1','L2','L3','L4','L5'];
const p = value => Array.isArray(value)?{x:value[0],y:value[1]}:value;
const norm = (value,f) => [value[0]/f.width,value[1]/f.height];
const circulation = region => ['corridor','lobby'].includes(region.kind);
const label = coreId => coreId.replace('stair-','Stair ').replace('elevator-','Elevator ');
const assert = (condition,message) => {if(!condition) throw new Error(`Sam Ibrahim project: ${message}`);};
const ring = polygon => [[...polygon,polygon[0]]];
const area = polygon => Math.abs(polygon.reduce((n,a,i)=>{const b=polygon[(i+1)%polygon.length];return n+a[0]*b[1]-b[0]*a[1];},0)/2);

// Merge only explicitly traced circulation, subtract every terminal room, and
// split holes into simple polygons accepted by the existing map schema. The
// split is an analytical seam with an explicit opening, never a new doorway.
function simpleCirculation(polygons,rooms,doorSegments=[]) {
  const merged=polygonClipping.union(...polygons.map(ring));
  const safe=rooms.length?polygonClipping.difference(merged,...rooms.map(ring)):merged;
  const split=(polygon,depth=0)=>{
    assert(depth<30,'cannot partition circulation holes');
    if(polygon.length===1)return [polygon[0].slice(0,-1)];
    const hole=polygon[1],xs=hole.map(q=>q[0]),lo=Math.min(...xs),hi=Math.max(...xs);
    const x=[0.5,0.33,0.67,0.25,0.75,0.1,0.9].map(t=>lo+(hi-lo)*t).find(candidate=>doorSegments.every(segment=>candidate<Math.min(...segment.map(q=>q[0]))-0.6||candidate>Math.max(...segment.map(q=>q[0]))+0.6));
    assert(x!==undefined,'circulation partition would cut an authored room doorway');
    return [-1,1].flatMap(side=>{
      const cut=side<0?[[-100,-100],[x,-100],[x,11000],[-100,11000]]:[[x,-100],[11000,-100],[11000,11000],[x,11000]];
      return polygonClipping.intersection([polygon],ring(cut)).flatMap(part=>split(part,depth+1));
    });
  };
  return safe.flatMap(polygon=>split(polygon)).filter(poly=>area(poly)>0.5)
    .sort((a,b)=>Math.min(...a.map(q=>q[0]))-Math.min(...b.map(q=>q[0])) || Math.min(...a.map(q=>q[1]))-Math.min(...b.map(q=>q[1])));
}

function projectFloor(original,extra) {
  const f=structuredClone(original),oldCirculation=f.regions.filter(circulation),rooms=f.regions.filter(r=>!circulation(r));
  const units=region=>region.polygon.map(q=>[q[0]*f.width,q[1]*f.height]);
  const overrides=new Map((extra.regionOverrides||[]).map(r=>[r.id,r]));
  const polygons=[...oldCirculation.map(r=>overrides.get(r.id)?.polygon||units(r)),...(extra.corridors||[]).map(r=>r.polygon)];
  for(const landing of extra.landings) {
    if(polygons.some(poly=>inside(p(landing.point),poly.map(p))))continue;
    assert(landing.horizontalStatus==='unresolved',`${landing.id}: assumed landing must lie in explicit corridor geometry`);
    const [x,y]=landing.point;
    polygons.push(landing.polygon||[[x-1,y-1],[x+1,y-1],[x+1,y+1],[x-1,y+1]]);
  }
  const refs=[...new Set([...oldCirculation,...extra.corridors,...extra.landings].flatMap(r=>r.sourceShapeIds))];
  const pieces=simpleCirculation(polygons,rooms.map(units),f.doors.filter(d=>d.status==='draft').map(d=>d.segment.map(q=>[q[0]*f.width,q[1]*f.height])));
  const corridors=pieces.map((polygon,i)=>({id:`${f.id}-project-circulation-${i+1}`,label:`${f.label} circulation ${i+1}`,kind:'corridor',polygon:polygon.map(q=>norm(q,f)),geometryBasis:'svg-traced',sourceFrameId:f.sourceFrameId,sourceShapeIds:refs,reviewPage:extra.reviewPage,evidenceNote:'Union of explicitly authored original-SVG circulation, excluding all terminal rooms. Hole cuts are analytical partitions. Landing/service assumptions are project-specific.'}));
  const corridorIds=new Set(oldCirculation.map(r=>r.id)),doors=[];
  for(const originalDoor of f.doors) {
    if(originalDoor.regionIds.every(id=>corridorIds.has(id)))continue;
    const d=structuredClone(originalDoor),segment=d.segment.map(q=>({x:q[0]*f.width,y:q[1]*f.height})),mid={x:(segment[0].x+segment[1].x)/2,y:(segment[0].y+segment[1].y)/2};
    const ranked=corridors.map(c=>{const poly=units(c).map(p);return {region:c,distance:Math.min(...poly.map((q,i)=>pointSegment(mid,q,poly[(i+1)%poly.length])))};}).sort((a,b)=>a.distance-b.distance);
    const matches=ranked.filter(c=>c.distance<0.1 || d.status==='candidate').map(c=>c.region);
    assert(matches.length,`${d.id}: traced opening lost its circulation boundary`);
    d.regionIds=d.regionIds.map(id=>corridorIds.has(id)?matches[0].id:id);
    doors.push(d);
  }
  for(let i=0;i<corridors.length;i++)for(let j=i+1;j<corridors.length;j++) {
    const a=pieces[i],b=pieces[j];
    for(let x=0;x<a.length;x++)for(let y=0;y<b.length;y++) {
      const overlap=segmentOverlap(p(a[x]),p(a[(x+1)%a.length]),p(b[y]),p(b[(y+1)%b.length]),0.001);
      if(!overlap||overlap.length<1)continue;
      const inset=0.01,point=t=>[overlap.a.x+(overlap.b.x-overlap.a.x)*t,overlap.a.y+(overlap.b.y-overlap.a.y)*t];
      doors.push({id:`${f.id}-project-seam-${doors.length}`,regionIds:[corridors[i].id,corridors[j].id],segment:[norm(point(inset),f),norm(point(1-inset),f)],status:'draft',openingType:'decomposition-join',sourceShapeIds:refs,sourceFrameId:f.sourceFrameId,evidenceNote:'Continuous traced circulation split into simple polygons around excluded core/void regions; analytical seam only.'});
    }
  }
  return {...f,regions:[...rooms,...corridors],doors,projectConnectors:extra};
}

function roomInterior(a,b,polygon) {
  const cuts=[0,1];
  polygon.forEach((q,i)=>{const hit=intersection(a,b,q,polygon[(i+1)%polygon.length]);if(hit)cuts.push(Math.max(0,Math.min(1,hit.t)));});
  cuts.sort((a,b)=>a-b);
  return cuts.slice(1).some((end,i)=>{
    if(end-cuts[i]<1e-8)return false;
    const t=(end+cuts[i])/2, point={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
    return inside(point,polygon)&&polygon.every((q,j)=>pointSegment(point,q,polygon[(j+1)%polygon.length])>1e-6);
  });
}
function validPath(floor,path) {
  return path.every((q,i)=>!i||(!segmentProblem(floor,path[i-1],q)&&!floor.geometry.spaces.some(s=>!circulation(s)&&roomInterior(path[i-1],q,s.polygon))));
}
function containing(floor,point) {
  return floor.geometry.spaces.filter(s=>circulation(s)&&s.access!=='nonwalkable'&&inside(point,s.polygon)).map(s=>s.id);
}
function projectToSegment(point,a,b) {
  const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
  const t=den?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/den)):0;
  return {x:a.x+t*dx,y:a.y+t*dy};
}

// A connector approach is explicitly authored. Only its final short join is
// snapped to a validated existing path, then that edge is split at the join.
// This never invents a wall-crossing line or connects a room centroid.
function attachApproach(building,floor,landing,definition,report) {
  if(definition.horizontalStatus==='unresolved') return;
  let path=(definition.approachPath||[definition.point]).map(p);
  if(distance(path.at(-1),landing.position)<distance(path[0],landing.position))path.reverse();
  if(distance(path[0],landing.position)>1e-6)path.unshift(landing.position);
  assert(validPath(floor,path),`${landing.id}: authored approach leaves corridor geometry`);
  const tail=path.at(-1), choices=[];
  for(const edge of building.edges.filter(e=>e.floorId===floor.id&&!e.connectorId&&!edgeIssue(building,e))) {
    for(let i=1;i<edge.path.length;i++) {
      const at=projectToSegment(tail,edge.path[i-1],edge.path[i]);
      if(!containing(floor,at).length || !validPath(floor,[tail,at]))continue;
      choices.push({edge,index:i,at,distance:distance(tail,at)});
    }
  }
  choices.sort((a,b)=>a.distance-b.distance || a.edge.id.localeCompare(b.edge.id));
  const selected=choices[0];
  assert(selected,`${landing.id}: no validated join to the floor graph`);
  assert(selected.distance<=25,`${landing.id}: approach must explicitly reach the graph (nearest join ${selected.distance.toFixed(1)} SVG units)`);
  const {edge,index,at}=selected;
  let junction=[edge.from,edge.to].map(id=>building.nodes.find(n=>n.id===id)).find(n=>distance(n.position,at)<0.01);
  if(!junction) {
    junction=newNode(`${landing.id}:approach-join`,floor.id,`${landing.label} corridor join`,'junction',at,containing(floor,at),{status:'reviewed'});
    building.nodes.push(junction);
    building.edges=building.edges.filter(e=>e.id!==edge.id);
    const from=building.nodes.find(n=>n.id===edge.from),to=building.nodes.find(n=>n.id===edge.to);
    for(const [id,a,b,points] of [
      [`${edge.id}:before:${landing.id}`,from,junction,[...edge.path.slice(0,index),at]],
      [`${edge.id}:after:${landing.id}`,junction,to,[at,...edge.path.slice(index)]],
    ]) building.edges.push(newEdge(id,floor,a,b,points.filter((q,i,all)=>!i||distance(q,all[i-1])>0.001),{direction:edge.direction,traversal:edge.traversal,status:'reviewed',simplify:false}));
  }
  path=[...path,junction.position].filter((q,i,all)=>!i||distance(q,all[i-1])>0.001);
  if(path.length===1)path=[landing.position,junction.position];
  if(distance(landing.position,junction.position)<0.01) {
    // Distinct semantic nodes may occupy one point; avoid zero-length edges by
    // placing landing points slightly inside their approach in the source data.
    throw new Error(`${landing.id}: landing coincides with a graph junction; refine its authored position`);
  }
  building.edges.push(newEdge(`${landing.id}:approach`,floor,landing,junction,path,{simplify:false,status:'reviewed'}));
  report.approaches.push({landingId:landing.id,floorId:floor.id,sourceShapeIds:definition.sourceShapeIds,joinDistance:selected.distance,path,status:'assumed',note:definition.note});
}

export function buildSamIbrahimProject() {
  const additions=new Map(projectConnectorFloors.map(f=>[f.floorId,f]));
  const specFloors=floors.map(original=>projectFloor(original,additions.get(original.id)));
  const reviewGraph=createReviewGraph(inventory,specFloors,reviewQuestions);
  const audit=verifySvgEvidence(specFloors,{reviewGraph});
  assert(audit.ok,`source audit failed: ${JSON.stringify(audit.issues)}`);
  const artifact=buildPipelineArtifact({id:PROJECT_ID,name:'Sam Ibrahim Building',generatedAt:AT,floors:specFloors,
    provenance:'Sam Ibrahim project-specific hardcoded SVG map. Inferred stairs/elevators enabled at user request; all floor service, elevations and access assumptions require field checking. Agent-inspected; not a verified accessibility map.'});
  let building=artifact.building;
  const report={id:PROJECT_ID,reviewStatus:'agent-inspected',connectionEvidence:'assumed',verifiedConnections:0,approaches:[],unresolvedApproaches:[],sourceAudit:audit,landings:[]};
  for(const floor of building.floors) {
    const extra=additions.get(floor.id);
    for(const definition of extra.landings) {
      const point=p(definition.point),spaces=containing(floor,point);
      assert(spaces.length,`${definition.id}: landing outside corridor/landing geometry`);
      const node=newNode(definition.id,floor.id,`${label(definition.coreId)} · ${floor.label}`,definition.type==='stairs'?'stair':'elevator',point,spaces,{status:'reviewed'});
      building.nodes.push(node);
      report.landings.push({...definition,floorId:floor.id,evidenceStatus:'assumed'});
      if(definition.horizontalStatus==='unresolved')report.unresolvedApproaches.push({floorId:floor.id,coreId:definition.coreId,landingId:node.id,reason:definition.note});
      else attachApproach(building,floor,node,definition,report);
    }
  }
  for(const coreId of ['stair-A','stair-B','stair-C','stair-D','elevator-B','elevator-C']) {
    for(let i=1;i<ORDER.length;i++) {
      const a=report.landings.find(l=>l.floorId===ORDER[i-1]&&l.coreId===coreId),b=report.landings.find(l=>l.floorId===ORDER[i]&&l.coreId===coreId);
      assert(a&&b,`missing adjacent named-core allocation ${coreId}`);
      building=connectLandings(building,a.id,b.id,a.type,label(coreId),`ASSUMED project link: PDF named ${label(coreId)} on ${ORDER[i-1]} and ${ORDER[i]}, compared with original SVGs. Agent-inspected; served floors, landing elevation, operating access and re-entry not field verified. Enabled explicitly for this hardcoded project.`);
    }
  }
  for(const f of building.floors)building=revalidateGraph(building,f.id);
  building.updatedAt=AT;
  building=parseBuilding(building);
  const errors=validateBuilding(building).filter(i=>i.severity==='error');
  assert(!errors.length,JSON.stringify(errors));
  assert(building.edges.every(e=>!edgeIssue(building,e)), 'invalid retained edge');
  assert(building.floors.every(f=>building.edges.filter(e=>e.floorId===f.id).every(e=>validPath(f,e.path))), 'room-interior shortcut');
  return {building,report,specFloors,reviewGraph};
}

export function routeSamIbrahimProject(project,from,to,options={}) {
  const route=routeBuilding(project.building||project,from,to,options);
  return route?{...route,evidenceStatus:'assumed-project',verified:false}:null;
}
