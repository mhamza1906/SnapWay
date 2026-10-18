// Prepare original-source backgrounds and exact saved-walk coordinates for the PDF.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { renderSamIbrahimFloor } from '../../apps/pipeline/server/projects/sam-ibrahim.js';

const [walkPath, output] = process.argv.slice(2);
if (!walkPath || !output) throw new Error('Usage: point-pdf-assets.mjs WALKS_JSON OUTPUT_FOLDER');
const walks = JSON.parse(await readFile(walkPath, 'utf8')).walks;
const progress = JSON.parse(await readFile(path.join(output, 'progress.json'), 'utf8'));
const building = JSON.parse(await readFile(new URL('../../apps/pipeline/public/buildings/sam-ibrahim.json', import.meta.url), 'utf8'));
const sharp = createRequire(new URL('../../apps/pipeline/package.json', import.meta.url))('sharp');
await mkdir(path.join(output, 'assets'), { recursive: true });
for (const floor of building.floors) {
  await sharp(Buffer.from(renderSamIbrahimFloor(building, floor.id)))
    .resize({ width: floor.width * 4 }).png().toFile(path.join(output, 'assets', `${floor.id}.png`));
}
const manifest = { ceiling: 40, generatedDate: 'October 18, 2026', review: 'agent-inspected', source: 'Original SVG source plans; existing walking graph; saved photo-stop identities preserved', walks: [] };
for (const walk of walks) {
  const floorId = walk.source.split(':')[1];
  const added = new Set(walk.densityProfile?.addedOrders || []);
  const points = walk.nodes.map(node => ({ ...node, order: Number(/^Point (\d+)$/.exec(node.label)?.[1] || 0) }))
    .filter(node => node.order).sort((a, b) => a.order - b.order)
    .map(node => ({ order: node.order, x: node.x, y: node.y, added: added.has(node.order), uploadedDirections: progress[walk.source]?.[node.order] || [] }));
  if (points.length !== walk.points) throw new Error('Point count mismatch');
  manifest.walks.push({ title: walk.title, floor: walk.floor, floorId, source: walk.source, width: walk.width, height: walk.height,
    background: `assets/${floorId}.png`, previousPoints: walk.densityProfile?.previousPoints ?? points.length,
    points, segments: walk.edges.map(edge => [walk.nodes[edge.from], walk.nodes[edge.to]].map(({ x, y }) => ({ x, y }))) });
}
manifest.totalPoints = manifest.walks.reduce((sum, walk) => sum + walk.points.length, 0);
manifest.addedPoints = manifest.walks.reduce((sum, walk) => sum + walk.points.filter(p => p.added).length, 0);
await writeFile(path.join(output, 'point-plan.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ walks: manifest.walks.length, points: manifest.totalPoints, added: manifest.addedPoints }));
