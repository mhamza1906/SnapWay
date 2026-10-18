// Source view for the built-in Sam Ibrahim project. This does not interpret SVGs
// or alter the graph. Frozen originals and graph coordinates share one viewBox.
import { readFileSync } from 'node:fs';

export const SAM_IBRAHIM_ID = 'sam-ibrahim-hardcoded';
const files = { LB: 'B', L1: '1', L2: '2', L3: '3', L4: '4', L5: '5' };
const originals = new Map();
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const points = path => path.map(p=>`${p.x},${p.y}`).join(' ');

export function renderSamIbrahimFloor(building, floorId) {
  if (building.id !== SAM_IBRAHIM_ID) return null;
  const floor = building.floors.find(f=>f.id===floorId);
  if (!floor || !files[floorId]) throw new Error('Unknown Sam Ibrahim floor.');
  if (!originals.has(floorId)) {
    const svg = readFileSync(new URL(`../../../../experiments/sam-ibrahim-hardcoded/source/Level-${files[floorId]}-original.svg`, import.meta.url), 'utf8');
    const box = /viewBox="([^"]+)"/.exec(svg)?.[1].split(/\s+/).map(Number);
    originals.set(floorId, {box, inner:svg.replace(/^[\s\S]*?<svg\b[^>]*>/,'').replace(/<\/svg>\s*$/,'')});
  }
  const { box, inner } = originals.get(floorId);
  if (!box || box[2]!==floor.width || box[3]!==floor.height) throw new Error('Sam Ibrahim source frame changed; rebuild the project before rendering.');
  const regions = floor.geometry.spaces.map(s=>`<g data-room-id="${esc(s.id)}" class="designed-room"><title>${esc(s.label)}</title><polygon points="${points(s.polygon)}" fill="${['corridor','lobby'].includes(s.kind)?'#2b8c86':'#d19d44'}" fill-opacity="0.10" stroke="#3b756d" stroke-opacity="0.45" stroke-width="0.45"/></g>`).join('');
  const paths = building.edges.filter(e=>e.floorId===floorId && e.status==='reviewed').map(e=>`<polyline points="${points(e.path)}" fill="none" stroke="#28635e" stroke-opacity="0.55" stroke-width="0.8"/>`).join('');
  const doors = floor.geometry.doors.map(d=>`<g data-door-id="${esc(d.id)}" class="designed-door"><title>${esc(d.label || d.id)} · assumed opening</title><path d="M${d.a.x},${d.a.y}L${d.b.x},${d.b.y}" stroke="#b66c09" stroke-width="1.6"/><path d="M${d.a.x},${d.a.y}L${d.b.x},${d.b.y}" stroke="transparent" stroke-width="7" pointer-events="stroke"/></g>`).join('');
  const markers = building.nodes.filter(n=>n.floorId===floorId && n.connectorId).map(n=>{
    const connector=building.connectors.find(c=>c.id===n.connectorId);
    const x=n.position.x,y=n.position.y,color=connector?.type==='elevator'?'#216f9c':'#8052a0';
    return `<g data-connector-id="${esc(n.connectorId)}"><title>${esc(connector?.label || n.label)} · inferred floor connection, access unverified</title><circle cx="${x}" cy="${y}" r="3.5" fill="${color}" stroke="white" stroke-width="0.8"/><text x="${x+5}" y="${y-5}" font-family="Arial,sans-serif" font-size="7" font-weight="700" fill="${color}" stroke="white" stroke-width="1.8" paint-order="stroke">${esc(connector?.label || n.label)}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${floor.width}" height="${floor.height}" viewBox="0 0 ${floor.width} ${floor.height}"><title>${esc(building.name)} — ${esc(floor.label)} · inferred project routes</title><rect width="100%" height="100%" fill="white"/><g opacity="0.55" pointer-events="none">${inner}</g>${regions}<g pointer-events="none">${paths}</g>${doors}<g pointer-events="none">${markers}</g></svg>`;
}
