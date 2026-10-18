// The review graph is deliberately distinct from the traversable pipeline graph.
// Coordinates from the PDF describe observations in a crop, not landing nodes.
const FLOOR_ORDER = ['LB','L1','L2','L3','L4','L5'];
const CORE_ORDER = ['stair-A','stair-B','stair-C','stair-D','elevator-B','elevator-C'];
const upperAnchors = {
  L2: [[120,255,['p1082']],[475,247,['p1081']],[356,75,['p855']],[706,72,['p847']],[436,247,['p1206']],[397,70,['p854']]],
  L3: [[106,239,['p638']],[427,234,['p645']],[331,67,['p500']],[660,67,['p485']],[392,237,['p626']],[370,66,['p493']]],
  L4: [[123,261,['p1019']],[460,244,['p991']],[350,89,['p841']],[684,78,['p822']],[422,249,['p994']],[389,85,['p1101']]],
  L5: [[98,231,['p790']],[411,224,['p784']],[315,69,['p651']],[631,62,['p629']],[375,225,['p776']],[353,65,['p649']]],
};
const coreFeature = (floor,key) => {
  const [kind,letter] = key.split('-');
  return floor.regions.find(r => kind === 'stair'
    ? r.featureType === 'stair shaft' && new RegExp(`(?:ST-|S)${letter}$`).test(r.id)
    : r.featureType === 'elevator shaft' && new RegExp(`Stair ${letter}$`, 'i').test(r.name));
};

export function createReviewGraph(inventory, tracedFloors, questions) {
  const observations = inventory.floors.flatMap(f=>f.regions.map(r=>({
    id:`observation:${r.id}`,featureId:r.id,floorId:f.id,label:r.name,type:r.featureType,
    point:r.center,coordinateFrameId:r.coordinateFrameId,walkablePoint:false,
    evidence:r.evidence,reviewStatus:'agent-inspected',traversable:false,
  })));
  const portals = inventory.portals.map(p=>({ ...p, point:null, traversable:false,
    reason:'Inventory identifies a portal candidate; only a separately SVG-traced threshold can enter the draft graph.' }));
  const landings = [], links = [], depictedFeatures = new Set();
  for(const floorId of FLOOR_ORDER) {
    const inv=inventory.floors.find(f=>f.id===floorId), trace=tracedFloors.find(f=>f.id===floorId);
    for(const [index,key] of CORE_ORDER.entries()) {
      const feature=coreFeature(inv,key);
      if(!feature) throw new Error(`Missing named core ${floorId}/${key}`);
      const explicit=trace.candidateLandings?.find(l=>l.featureId===feature.id);
      const anchor=upperAnchors[floorId]?.[index];
      const position=explicit?.point || (anchor ? [anchor[0]/trace.width,anchor[1]/trace.height] : null);
      landings.push({id:`${floorId}:landing:${key}`,floorId,featureId:feature.id,coreId:key,
        kind:key.startsWith('stair')?'stair':'elevator',point:null,elevation:null,
        depictionAnchor:position ? {point:position,coordinateFrameId:trace.sourceFrameId,sourceShapeIds:explicit?.sourceShapeIds || anchor[2]} : null,
        portalIds:feature.portalIds,landingLocationStatus:'unresolved',servedFloorStatus:'unresolved',
        reentryStatus:'unknown',accessibility:'unknown',reviewStatus:'agent-inspected',traversable:false,
        evidence:{...feature.evidence,reason:'Named core identity match only. Depiction anchor is not a verified landing or door centre.'}});
      depictedFeatures.add(feature.id);
    }
  }
  for(const key of CORE_ORDER) {
    for(let i=1;i<FLOOR_ORDER.length;i++) links.push({
      id:`candidate:${key}:${FLOOR_ORDER[i-1]}:${FLOOR_ORDER[i]}`,
      from:`${FLOOR_ORDER[i-1]}:landing:${key}`,to:`${FLOOR_ORDER[i]}:landing:${key}`,
      relation:'adjacent-floor-core-match',status:'candidate',traversable:false,
      requiredEvidence:['actual threshold on each side','landing elevations','served floors','re-entry/operating access'],
      reason:'Repeated named core is an identity clue; neither aligned drawings nor this pair establishes physical access.'});
  }
  for(const floor of inventory.floors) {
    for(const feature of floor.regions.filter(r=>/stair/.test(r.featureType) && !depictedFeatures.has(r.id))) {
      // Extra shaft labels have one unresolved landing on each floor; open
      // flights have two distinct endpoints with no guessed destination floor.
      const suffixes=feature.id.includes('SEXTRA')?['landing']:['endpoint-a','endpoint-b'];
      for(const suffix of suffixes) landings.push({id:`${feature.id}:${suffix}`,featureId:feature.id,
        floorId:suffix==='landing'?floor.id:null,depictedOnFloorId:floor.id,
        kind:feature.featureType,point:null,elevation:null,portalIds:feature.portalIds,
        status:'candidate',traversable:false,reviewStatus:'agent-inspected',evidence:feature.evidence});
      if(suffixes.length===2) links.push({id:`candidate-flight:${feature.id}`,from:`${feature.id}:endpoint-a`,to:`${feature.id}:endpoint-b`,
        relation:'unresolved-stair-flight',status:'candidate',traversable:false,
        reason:'Stair depiction retained, but its endpoints, elevation and destination floors are unknown.'});
    }
  }
  links.push({id:'candidate:extra-core:LB:L1',from:'LB-SEXTRA:landing',to:'L1-SEXTRA:landing',
    relation:'possible-extra-core-match',status:'candidate',traversable:false,reason:'Unclear extra stair label; correspondence and service unresolved (Q07).'});
  const entities = [
    {id:'physical-room:cloud',name:'The Cloud',roomNumbers:['IA2040'],depictions:['L2-R06','L3-R07'],identityStatus:'candidate-correspondence',
      excludedEntranceDepictions:['L3-R07'],note:'L3 continuous east boundary establishes no doorway. No automatic open-void classification.'},
    {id:'physical-room:conveyor',name:'The Conveyor',roomNumbers:['IA2150','IA2150A'],depictions:['L2-R08','L3-R08'],identityStatus:'unresolved-suffix-and-elevations',
      note:'Two L2 and three L3 portal observations are not five verified physical entrances. No internal terrace links.'},
    {id:'physical-room:basement-east-tiered',name:'Unnamed right tiered classroom',roomNumbers:[],depictions:['LB-R04','L1-R03'],identityStatus:'unresolved-correspondence',
      note:'Repeated seating footprint is insufficient to connect floors.'},
  ];
  const regionLinks=portals.flatMap(p=>p.regionIds.map(id=>({id:`observation-link:${id}:${p.id}`,from:`observation:${id}`,to:p.id,
    relation:'printed-related-portal',traversable:false})));
  return {schemaVersion:1,kind:'evidence-review-graph',reviewStatus:'agent-inspected',observations,portals,landings,
    links:[...regionLinks,...links],physicalEntities:entities,reviewQuestions:questions,
    verifiedCrossFloorEdges:0,limitations:['Not a navigation graph. Every link is non-traversable.','Report crop coordinates and original SVG coordinates are separate unregistered frames.']};
}
