#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExperiment, summarize, floors, inventory, reviewQuestions } from './model.mjs';
import { createReviewGraph } from './review-graph.mjs';
import { routePipelineArtifact } from './pipeline-adapter.mjs';
import { verifySvgEvidence, renderComparison, renderSourceEvidenceSvg, collectSourceShapeIds } from './svg-tools.mjs';
import { renderNavigationSvg } from './render-navigation.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
const help=`Offline Sam Ibrahim hardcoded SVG experiment

node cli.mjs build [--out DIRECTORY]
node cli.mjs check
node cli.mjs route FROM_REGION TO_REGION [--draft] [--stairs-free] [--accessible]
node cli.mjs inspect REGION_OR_PORTAL_ID
node cli.mjs compare [--out DIRECTORY] [--report-images DIRECTORY]

Build writes separate draft building/bundle, geometry vertices, navigation graph,
review graph, coverage, capture suggestions and source evidence audit files.
Build and compare write L*-navigation.draft.svg with actual graph nodes and paths,
alongside source-comparison and all-cited-source-shapes SVGs for each floor.
No server, UI, environment file, model or network request is used. Existing project
data is not modified; pure functions from the checked-out pipeline are reused.
Route defaults to strict rejection. --draft enables unverified same-floor experiments;
it never enables candidate stair/elevator links. Source metrics remain uncalibrated.
`;

function options(args) {
  const result={positionals:[]};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(['--out','--report-images'].includes(arg)) {
      if(!args[i+1] || args[i+1].startsWith('--')) throw new Error(`${arg} requires a path`);
      result[arg.slice(2)]=args[++i];
    } else if(['--draft','--stairs-free','--accessible'].includes(arg)) result[arg.slice(2)]=true;
    else if(arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else result.positionals.push(arg);
  }
  return result;
}
const print=x=>process.stdout.write(`${JSON.stringify(x,null,2)}\n`);
const writeJson=(out,name,value)=>writeFile(join(out,name),`${JSON.stringify(value,null,2)}\n`);
const routeSummary = route => route ? {found:true,...route} : {found:false};

async function compare(out, reportImages, reviewGraph, building) {
  await mkdir(out,{recursive:true});
  for(const floor of floors) {
    const originalSvg=await readFile(join(directory,floor.sourceFile),'utf8');
    const page=inventory.floors.find(f=>f.id===floor.id).overviewPage;
    let reportImage;
    if(reportImages) reportImage=`data:image/png;base64,${(await readFile(join(resolve(reportImages),`page-${String(page).padStart(2,'0')}.png`))).toString('base64')}`;
    const evidenceFloor={...floor,reviewGraphLandings:reviewGraph.landings.filter(landing=>(landing.floorId || landing.depictedOnFloorId)===floor.id)};
    await writeFile(join(out,`${floor.id}-source-comparison.svg`),renderComparison(evidenceFloor,{originalSvg,reportImage}));
    const ids=collectSourceShapeIds(evidenceFloor);
    await writeFile(join(out,`${floor.id}-selected-source-shapes.svg`),renderSourceEvidenceSvg(originalSvg,ids,{title:`${floor.label} — all cited original SVG evidence (draft)` }));
    await writeFile(join(out,`${floor.id}-navigation.draft.svg`),renderNavigationSvg(floor,building,originalSvg));
  }
}

async function main(args) {
  const [command,...rest]=args;
  if(!command || ['help','--help','-h'].includes(command)){process.stdout.write(help);return;}
  const opts=options(rest), out=resolve(opts.out || join(directory,'output'));
  if(command==='inspect') {
    const [id]=opts.positionals;
    const region=inventory.floors.flatMap(f=>f.regions).find(r=>r.id===id);
    const portal=inventory.portals.find(p=>p.id===id);
    if(!region&&!portal) throw new Error(`Unknown inventory ID: ${id || '(missing)'}`);
    const trace=floors.flatMap(f=>f.regions).find(r=>r.id===id);
    const threshold=floors.flatMap(f=>f.doors).find(d=>d.id===id);
    print({inventory:region || portal,svgTrace:trace || threshold || null});return;
  }
  const reviewGraph=createReviewGraph(inventory,floors,reviewQuestions);
  const audit=verifySvgEvidence(floors,{reviewGraph});
  if(!audit.ok) throw new Error(`SVG evidence audit failed: ${JSON.stringify(audit.issues)}`);
  if(!['build','check','route','compare'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const experiment=buildExperiment();
  if(command==='compare'){await compare(out,opts['report-images'],experiment.reviewGraph,experiment.building);print({outputDirectory:out,floors:floors.length,navigationGraphs:floors.length,pdfPanels:Boolean(opts['report-images']),auditPassed:true});return;}
  if(command==='route') {
    const [from,to]=opts.positionals;
    if(!from||!to) throw new Error('route requires FROM_REGION and TO_REGION');
    const ids=new Set(inventory.floors.flatMap(f=>f.regions.map(r=>r.id)));
    if(!ids.has(from)||!ids.has(to)) throw new Error('Route endpoints must be printed region IDs; door/centroid IDs are not room endpoints.');
    const route=routePipelineArtifact(experiment,from,to,{allowDraft:Boolean(opts.draft),excludeStairs:Boolean(opts['stairs-free']),verifiedAccessible:Boolean(opts.accessible)});
    print({...routeSummary(route),mode:opts.draft?'draft':'strict',from,to,
      ...(!route?{reason:!opts.draft?'All geometry is unverified; strict routing is unavailable.':'No accepted draft route: endpoint may be unresolved, in a different component/floor, or lack verified accessibility.'}:{})});return;
  }
  const summary=summarize(experiment);
  if(command==='check'){print({ok:true,sourceAudit:audit,summary});return;}
  await mkdir(out,{recursive:true});
  const documents={
    'building.draft.json':experiment.building,
    'navigation-bundle.draft.json':experiment.navigationBundle,
    'navigation-graph.draft.json':{nodes:experiment.building.nodes,edges:experiment.building.edges,connectors:[],status:'draft-assumed'},
    'geometry-vertices.json':experiment.geometryVertices,
    'review-graph.json':experiment.reviewGraph,
    'coverage.json':experiment.coverage,
    'capture-plans.draft.json':experiment.capturePlans,
    'pipeline-report.json':experiment.report,
    'source-audit.json':audit,
    'summary.json':summary,
  };
  for(const [name,value] of Object.entries(documents)) await writeJson(out,name,value);
  await compare(out,opts['report-images'],experiment.reviewGraph,experiment.building);
  print({outputDirectory:out,...summary});
}

main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
