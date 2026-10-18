// Cleaned plan image (scripts/clean_svg.py) → clean floor-plan SVG.
// Rooms and corridors come from the raster room finder (no models). Rooms are
// numbered Room 1, Room 2, … in reading order (top to bottom in bands, then
// left to right); no other names are used. Corridors are grey and unlabelled.
// Usage: node scripts/plan-to-svg.js <clean.png> <scale> <out.svg> [title]
import { readFile, writeFile } from "node:fs/promises";
import { rasterRoomsMap } from "../server/pipelines/raster-rooms.js";
import { inside, pointSegment } from "../shared/map.js";

const [png, scaleArg, out, title = ""] = process.argv.slice(2);
if (!png || !scaleArg || !out) { console.error("Usage: node scripts/plan-to-svg.js <clean.png> <scale> <out.svg> [title]"); process.exit(1); }
const scale = Number(scaleArg), map = await rasterRoomsMap(await readFile(png), { source: { id: "plan" } });
const u = (v) => Math.round((v / scale) * 100) / 100, pt = (p) => `${u(p.x)},${u(p.y)}`;
const W = u(map.width), H = u(map.height);

// The interior point farthest from the outline: where a label fits best.
function labelPoint(poly) {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let best = null, clearance = -1;
  const step = Math.max(1, Math.min(x1 - x0, y1 - y0) / 24);
  for (let x = x0 + step / 2; x < x1; x += step)
    for (let y = y0 + step / 2; y < y1; y += step) {
      const p = { x, y };
      if (!inside(p, poly)) continue;
      const d = Math.min(...poly.map((a, i) => pointSegment(p, a, poly[(i + 1) % poly.length])));
      if (d > clearance) { clearance = d; best = p; }
    }
  return { p: best || { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, clearance: Math.max(clearance, 0) };
}

const rooms = map.spaces.filter((s) => s.kind !== "corridor").map((s) => ({ s, l: labelPoint(s.polygon) }));
const band = map.height / 8;
rooms.sort((a, b) => Math.floor(a.l.p.y / band) - Math.floor(b.l.p.y / band) || a.l.p.x - b.l.p.x);
rooms.forEach((r, i) => (r.label = `Room ${i + 1}`));

const corridors = map.spaces.filter((s) => s.kind === "corridor");
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${Math.round(W * 2)}" height="${Math.round(H * 2)}">`;
svg += `<title>${title || "Floor plan"}</title><rect width="${W}" height="${H}" fill="#ffffff"/>`;
svg += `<g stroke="#111111" stroke-width="1.2" stroke-linejoin="round">`;
for (const c of corridors) svg += `<polygon data-kind="corridor" points="${c.polygon.map(pt).join(" ")}" fill="#d8d8d8"/>`;
for (const r of rooms) svg += `<polygon data-kind="room" data-label="${r.label}" points="${r.s.polygon.map(pt).join(" ")}" fill="#ffffff"/>`;
svg += `</g>`;
// Doorways: openings drawn over the walls in the colour of the space they open onto.
const kindOf = new Map(map.spaces.map((s) => [s.id, s.kind]));
svg += `<g stroke-linecap="butt">`;
for (const d of map.doors) {
  const open = d.spaceIds.some((id) => kindOf.get(id) === "corridor") ? "#d8d8d8" : "#ffffff";
  svg += `<line data-kind="doorway" x1="${u(d.a.x)}" y1="${u(d.a.y)}" x2="${u(d.b.x)}" y2="${u(d.b.y)}" stroke="${open}" stroke-width="2.4"/>`;
}
svg += `</g><g font-family="Arial, Helvetica, sans-serif" fill="#222222" text-anchor="middle">`;
for (const r of rooms) {
  const size = Math.max(2.2, Math.min(7, u(r.l.clearance) * 0.55));
  svg += `<text x="${u(r.l.p.x)}" y="${u(r.l.p.y) + size * 0.35}" font-size="${Math.round(size * 10) / 10}">${r.label}</text>`;
}
svg += `</g></svg>`;
await writeFile(out, svg);
console.log(JSON.stringify({ out, rooms: rooms.length, corridors: corridors.length, doorways: map.doors.length }));
