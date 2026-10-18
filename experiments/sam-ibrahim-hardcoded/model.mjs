import { readFileSync } from 'node:fs';
import { upperFloors } from './data/upper-floors.mjs';
import { lowerFloors } from './data/lower-floors.mjs';
import { createReviewGraph } from './review-graph.mjs';
import { buildPipelineArtifact } from './pipeline-adapter.mjs';
import { corridorChains, chainView, planCapturePoints } from '../../apps/pipeline/shared/building/capture-points.js';

const json = name => JSON.parse(readFileSync(new URL(`data/${name}`,import.meta.url),'utf8'));
export const inventory = json('review-inventory.json');
export const sourceManifest = json('source-manifest.json');
export const reviewQuestions = json('review-questions.json');
export const floors = [...lowerFloors,...upperFloors];
export const BASE_COMMIT = '9f5e2ca';

export function buildExperiment() {
  const reviewGraph=createReviewGraph(inventory,floors,reviewQuestions);
  const artifact=buildPipelineArtifact({id:'sam-ibrahim-manual-svg',name:'Sam Ibrahim — manual SVG draft',
    generatedAt:'2026-10-18T00:00:00.000Z',floors,
    provenance:`Hardcoded original-SVG traces compared with Sam Ibrahim review PDF; pipeline base ${BASE_COMMIT}.`,
    connectorCandidates:reviewGraph.links.filter(l=>l.relation.includes('core-match'))});
  const rooms = artifact.report.roomAvailability;
  const geometryVertices = floors.flatMap(f=>f.regions.flatMap(r=>r.polygon.map((p,index)=>({
    id:`${r.id}:vertex:${index}`,floorId:f.id,regionId:r.id,index,
    position:{x:p[0]*f.width,y:p[1]*f.height},coordinateFrameId:f.sourceFrameId,
    sourceShapeIds:r.sourceShapeIds,reviewStatus:'agent-inspected',role:'geometry-only',
  }))));
  const placement=new Map(floors.flatMap(f=>f.doors.map(d=>[d.id,{...d,floorId:f.id}])));
  const enabled=new Set(artifact.building.floors.flatMap(f=>f.geometry.doors.map(d=>d.id)));
  const coverage=inventory.floors.map(f=>{
    const trace=floors.find(t=>t.id===f.id),ids=new Set(trace.regions.map(r=>r.id));
    const portals=inventory.portals.filter(p=>p.floorId===f.id);
    const placed=portals.filter(p=>placement.has(p.id));
    return {floorId:f.id,inventoryRegions:f.regions.length,inventoryPortalCandidates:portals.length,
      tracedInventoryRegions:f.regions.filter(r=>ids.has(r.id)).length,
      extraCirculationPartitions:trace.regions.filter(r=>!f.regions.some(x=>x.id===r.id)).length,
      placedDraftPortalCandidates:placed.filter(p=>enabled.has(p.id)).length,
      positionedButUnresolvedPortalIds:placed.filter(p=>!enabled.has(p.id)).map(p=>p.id),
      remainingRegionIds:f.regions.filter(r=>!ids.has(r.id)).map(r=>r.id),
      remainingPortalIds:portals.filter(p=>!enabled.has(p.id)).map(p=>p.id),
      draftAvailableRooms:rooms.filter(r=>r.floorId===f.id && r.ready).map(r=>r.id),
      disconnectedOrUnavailableRooms:rooms.filter(r=>r.floorId===f.id&&!r.ready).map(r=>({id:r.id,reason:r.reason})),
      complete:false};
  });
  const capturePlans=[];
  for(const floor of floors) for(const chain of corridorChains(artifact.building,floor.id)) {
    capturePlans.push({floorId:floor.id,corridor:chainView(chain),
      ...planCapturePoints(artifact.building,floor.id,chain.id),
      status:'draft-proposal',photos:[],note:'Positions for later reference-photo collection. No photos or localization result exist.'});
  }
  return {...artifact,reviewGraph,geometryVertices,coverage,capturePlans,sourceManifest,
    metadata:{baseBranch:'feature/map-authoring-pipeline',baseCommit:BASE_COMMIT,
      branch:'feature/sam-ibrahim-hardcoded-navigation',providerCalls:0,scale:null,complete:false,
      sourceGeometry:'original SVG viewBox',roomLabels:'review PDF',crossFrameTransform:null}};
}

export function summarize(experiment) {
  const b=experiment.building;
  return {...experiment.metadata,floors:b.floors.length,inventoryRegions:experiment.reviewGraph.observations.length,
    inventoryPortalCandidates:experiment.reviewGraph.portals.length,tracedRegions:b.floors.reduce((n,f)=>n+f.geometry.spaces.length,0),
    draftThresholds:b.floors.reduce((n,f)=>n+f.geometry.doors.length,0),
    geometryVertices:experiment.geometryVertices.length,navigationNodes:b.nodes.length,navigationEdges:b.edges.length,
    candidateLandings:experiment.reviewGraph.landings.length,
    candidateVerticalLinks:experiment.reviewGraph.links.filter(l=>l.relation.includes('core-match')||l.relation==='unresolved-stair-flight').length,
    verifiedCrossFloorEdges:b.connectors.length,capturePlans:experiment.capturePlans.length,
    removedRoomTransitEdges:experiment.report.removedRoomTransitEdgeIds.length,
    coverage:experiment.coverage.map(({remainingRegionIds,remainingPortalIds,...c})=>({...c,
      remainingRegions:remainingRegionIds.length,remainingPortals:remainingPortalIds.length}))};
}
