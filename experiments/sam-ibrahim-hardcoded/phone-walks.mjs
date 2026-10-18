// Offline export of the existing project into the same graph used by authoring.
// Run with Node's --experimental-strip-types flag (no provider calls).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { planHallPoints } from '../../apps/pipeline/shared/building/capture-points.js';
import { renderSamIbrahimFloor } from '../../apps/pipeline/server/projects/sam-ibrahim.js';
import { photoPointGraph } from '../../apps/web/src/app/features/authoring/photo-graph.ts';

const building = JSON.parse(readFileSync(new URL('../../apps/pipeline/public/buildings/sam-ibrahim.json', import.meta.url)));
const sharp = createRequire(new URL('../../apps/pipeline/package.json', import.meta.url))('sharp');
const walks = [];
for (const floor of building.floors) {
  const underlay = (await sharp(Buffer.from(renderSamIbrahimFloor(building, floor.id))).png().toBuffer()).toString('base64');
  for (const hall of floor.geometry.spaces.filter(space => ['corridor','lobby'].includes(space.kind))) {
    const plan = planHallPoints(building, floor.id, hall.id, {maxPoints:12});
    if (!plan.points.length) continue;
    walks.push({source:`${building.id}:${floor.id}:${hall.id}:12`,title:`Sam Ibrahim · ${hall.label}`,
      floor:floor.label,width:floor.width,height:floor.height,points:plan.points.length,
      underlay, ...photoPointGraph(plan)});
  }
}
if (!process.argv[2]) throw new Error('Pass an output JSON path.');
writeFileSync(process.argv[2], JSON.stringify({walks}));
console.log(JSON.stringify({walks:walks.length,points:walks.reduce((sum,walk)=>sum+walk.points,0)}));
