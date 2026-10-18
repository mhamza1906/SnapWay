#!/usr/bin/env node
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildSamIbrahimProject, routeSamIbrahimProject } from './project.mjs';
import { renderNavigationSvg } from './render-navigation.mjs';
import { roomAvailability } from '../../apps/pipeline/shared/building/routing.js';

const directory=dirname(fileURLToPath(import.meta.url));
const print=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
async function main(args) {
  const [command,...rest]=args;
  if(!command||command==='--help') {
    console.log('Sam Ibrahim project only\n  node project-cli.mjs build [--install]\n  node project-cli.mjs route FROM_ROOM TO_ROOM [--stairs-free] [--prefer-stairs]\nBuild writes ignored output/project; --install also updates the built-in project JSON with a backup. All floor connections are explicit project assumptions.');return;
  }
  if(!['build','route'].includes(command))throw new Error('Expected build or route.');
  const project=buildSamIbrahimProject();
  if(command==='route') {
    const [from,to,...flags]=rest;
    if(!from||!to||flags.some(f=>!['--stairs-free','--prefer-stairs'].includes(f)))throw new Error('route requires two room IDs and optional --stairs-free / --prefer-stairs.');
    const route=routeSamIbrahimProject(project,from,to,{excludeStairs:flags.includes('--stairs-free'),...(flags.includes('--prefer-stairs')?{elevatorPenalty:1000}:{})});
    print({found:!!route,route});return;
  }
  if(rest.some(f=>f!=='--install'))throw new Error('Unknown build option.');
  const out=join(directory,'output/project');
  await mkdir(out,{recursive:true});
  // Display raster only: graph geometry and source evidence remain the original
  // SVG. The normal authoring source-image view expects PNG/JPEG/WebP bytes.
  const sharp=createRequire(new URL('../../apps/pipeline/package.json',import.meta.url))('sharp');
  for(const floor of project.specFloors) {
    const png=await sharp(await readFile(join(directory,floor.sourceFile))).png().toBuffer();
    const source=project.building.floors.find(f=>f.id===floor.id).geometry.source;
    source.dataUrl=`data:image/png;base64,${png.toString('base64')}`;
    source.provenance='Display rendering of the frozen original SVG; graph coordinates and evidence use the original SVG viewBox. Not a generated clean design.';
  }
  const rooms=roomAvailability(project.building);
  const summary={id:project.building.id,name:project.building.name,floors:project.building.floors.length,
    nodes:project.building.nodes.length,edges:project.building.edges.length,cores:project.building.connectors.length,
    landings:project.report.landings.length,inferredCrossFloorEdges:project.building.edges.filter(e=>e.floorId===null).length,
    verifiedCrossFloorEdges:0,availableRooms:rooms.filter(r=>r.ready).length,unavailableRooms:rooms.filter(r=>!r.ready).map(r=>({id:r.id,reason:r.reason})),
    unresolvedApproaches:project.report.unresolvedApproaches,reviewStatus:'agent-inspected',connectionEvidence:'assumed',scale:null,photos:0};
  for(const [name,value] of Object.entries({'building.json':project.building,'connections.json':project.report,'summary.json':summary}))await writeFile(join(out,name),JSON.stringify(value,null,2)+'\n');
  for(const floor of project.specFloors) {
    const source=await readFile(join(directory,floor.sourceFile),'utf8');
    await writeFile(join(out,`${floor.id}-navigation.svg`),renderNavigationSvg(floor,project.building,source));
  }
  if(rest.includes('--install')) {
    const target=resolve(directory,'../../apps/pipeline/public/buildings/sam-ibrahim.json');
    await mkdir(dirname(target),{recursive:true});
    try {
      const previous=await readFile(target);
      await writeFile(join(out,`sam-ibrahim-before-${Date.now()}.json`),previous);
    } catch(e) { if(e.code!=='ENOENT')throw e; }
    // No unrelated saved project or other built-in building is overwritten.
    await copyFile(join(out,'building.json'),target);
    summary.installedFile=target;
  }
  print({...summary,outputDirectory:out});
}
main(process.argv.slice(2)).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
