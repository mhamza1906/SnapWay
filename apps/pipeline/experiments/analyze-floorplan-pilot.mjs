import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {validateTrace,convertPoint,renderSvg} from './floorplan-pilot.mjs';
import {inside,pointSegment,emptyMap,validateMap} from '../shared/map.js';
import sharp from 'sharp';

const root=resolve(import.meta.dirname,'../../..');
const out=resolve(root,process.argv.find(a=>a.startsWith('--out='))?.slice(6)||'local/test-results/pipeline-v2-pilot');
if(!relative(root,out) || relative(root,out).startsWith('..') || isAbsolute(relative(root,out)))throw Error('Output must stay within workspace');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const ledger=await json(join(out,'attempt-ledger.json'));
const result={scope:'Gemini-only vector pilot; downloaded raster simulates image-generation stage; no OpenAI/Opus calls or production apply',model:'gemini-4-argon',effort:'medium',requests:ledger.length,attempts:ledger,inputTokens:0,outputTokens:0,totalTokens:0,totalHttpLatencyMs:0,estimatedUndiscountedUsd:0,priceBasis:{currency:'USD',date:'2026-10-17',inputPerMillion:4,outputAndThinkingPerMillion:20,creditsExcluded:true,url:'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing?hl=en'},detailResults:[]};
for(const a of ledger){result.inputTokens+=a.usage?.promptTokenCount??0;result.outputTokens+=(a.usage?.candidatesTokenCount??0)+(a.usage?.thoughtsTokenCount??0);result.totalTokens+=a.usage?.totalTokenCount??0;result.totalHttpLatencyMs+=a.latencyMs??0;result.estimatedUndiscountedUsd+=a.estimatedUndiscountedUsd??0;}
const baseline=await json(join(out,'trace.json'));const validation=await json(join(out,'validation.json'));
const anchors=[{label:'brainstorm',point:{x:985,y:120}},{label:'dark-matter',point:{x:787,y:354}},{label:'the-cave',point:{x:987,y:383}}];
result.labelAnchorCheck=anchors.map(a=>({...a,insideCorrespondingRegion:baseline.spaces.filter(s=>s.label_refs.includes(a.label)).some(s=>inside(a.point,s.polygon.map(p=>convertPoint(p,1405,625))))}));
result.labelAnchorCheckScope='Three manually read text-centre points on the frozen raster, not surveyed geometry or independent OCR evaluation';
result.baseline={spaces:baseline.spaces.length,walls:validation.walls,openingCandidates:baseline.opening_candidates.length,overlaps:validation.currentDomainValidation.filter(i=>i.code==='overlap'),unresolved:baseline.unresolved,openingBoundaryTolerancePixels:2,openingsWithinTolerance:validation.openingBoundaries.filter(o=>o.adjacency.every(a=>a.maxEndpointDistancePixels<=2)).length,maxOpeningBoundaryDistance:Math.max(...validation.openingBoundaries.flatMap(o=>o.adjacency.map(a=>a.maxEndpointDistancePixels))),acceptedDoors:0,acceptedRouteEdges:0};
for(const name of ['stair-c-detail','door-detail']) {
 const dir=join(out,name),trace=await json(join(dir,'trace.json')),meta=await sharp(join(dir,'web-floor.png')).metadata(),frame=await json(join(dir,'parent-frame.json'));
 const expectedFrame='candidate-'+createHash('sha256').update(await readFile(join(dir,'web-floor.png'))).digest('hex').slice(0,16);
 let valid=true,error=null;try{validateTrace(trace,expectedFrame+'-trace',expectedFrame);}catch(e){valid=false;error=e.message;}
 const map=emptyMap({name,normalized:true,width:meta.width,height:meta.height,dataUrl:'data:image/png;base64,'+(await readFile(join(dir,'web-floor.png'))).toString('base64'),provenance:'Local candidate crop',fictional:false});
 map.spaces=trace.spaces.map(s=>({id:s.local_id,label:s.local_id,kind:'room',polygon:s.polygon.map(p=>convertPoint(p,meta.width,meta.height)),confidence:0,access:'unknown'}));
 const issues=validateMap(map).filter(i=>['polygon','overlap','bounds','duplicate'].includes(i.code));
 const openings=trace.opening_candidates.map(o=>({id:o.local_id,adjacency:o.adjacent_local_ids.map(id=>{const s=trace.spaces.find(s=>s.local_id===id);return {id,maxEndpointDistancePixels:Math.max(...[o.a,o.b].map(p=>Math.min(...s.polygon.map((a,i)=>pointSegment(convertPoint(p,meta.width,meta.height),convertPoint(a,meta.width,meta.height),convertPoint(s.polygon[(i+1)%s.polygon.length],meta.width,meta.height))))))};})}));
 const diag={name,parentFrame:frame,schema:'Validated by harness before geometric checks',basicPolygonValid:valid,error,spaces:trace.spaces.length,openingCandidates:openings.length,geometryIssues:issues,openingBoundaries:openings,unresolved:trace.unresolved,appliedToBaseline:false};
 await save(join(dir,'review.json'),diag);
 const footprint=[{x:0,y:0},{x:1000,y:0},{x:1000,y:1000},{x:0,y:1000}];
 const svg=renderSvg(trace,{footprint,walls:[],stairs:[],seating:[],door_symbols:[]},meta.width,meta.height);
 await writeFile(join(dir,'candidate.svg'),svg);await sharp(Buffer.from(svg)).png().toFile(join(dir,'candidate.png'));
 const raster=(await readFile(join(dir,'web-floor.png'))).toString('base64');
 const overlay=svg.replace('<defs>',`<image href="data:image/png;base64,${raster}" width="${meta.width}" height="${meta.height}"/><defs>`).replaceAll('fill="#f8fafc"','fill="none"').replaceAll('fill="#dbeafe"','fill="#60a5fa" fill-opacity=".18"').replaceAll('fill="#f1f5f9"','fill="#cbd5e1" fill-opacity=".15"').replaceAll('fill="#fef3c7"','fill="#fbbf24" fill-opacity=".25"').replaceAll('fill="#fde68a"','fill="#f59e0b" fill-opacity=".25"').replaceAll('fill="#a5f3fc"','fill="#a5f3fc" fill-opacity=".25"');
 await sharp(Buffer.from(overlay)).png().toFile(join(dir,'overlay.png'));result.detailResults.push(diag);
}
await save(join(out,'pilot-summary.json'),result);
console.log(JSON.stringify({requests:result.requests,totalTokens:result.totalTokens,totalHttpLatencyMs:result.totalHttpLatencyMs,estimatedUndiscountedUsd:result.estimatedUndiscountedUsd,baseline:result.baseline,details:result.detailResults.map(d=>({name:d.name,basicPolygonValid:d.basicPolygonValid,geometryIssues:d.geometryIssues,openingCandidates:d.openingCandidates,unresolved:d.unresolved}))},null,2));
