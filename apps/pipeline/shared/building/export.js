import JSZip from "jszip";
import { parseBuilding } from "./schema.js";
import { validateBuilding } from "./validation.js";
import { designedSVG } from "./design.js";
import { routeDisplaySegments } from "./route-display.js";
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const pts = (ps) => ps.map((p) => `${p.x},${p.y}`).join(" ");
export function floorSVG(b, floorId, route = null) {
  const f = b.floors.find((f) => f.id === floorId);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}"><title>${esc(b.name)} — ${esc(f.label)}</title><metadata>${esc(JSON.stringify({ version: 2, floorId, revision: f.revision, review: f.geometryStatus }))}</metadata><rect width="100%" height="100%" fill="white"/><g id="sources">${f.sources
    .filter((s) => s.visible)
    .map(
      (s) =>
        `<image href="${b.assets[s.assetId].dataUrl}" width="${s.width}" height="${s.height}" transform="matrix(${s.transform.join(" ")})" opacity="0.65"/>`,
    )
    .join(
      "",
    )}</g><g id="spaces">${f.geometry.spaces.map((s) => `<polygon points="${pts(s.polygon)}" fill="#83b4a2" fill-opacity=".2" stroke="#4e8572"/>`).join("")}</g><g id="walls">${f.geometry.walls.map((w) => `<polyline points="${pts(w.points)}" fill="none" stroke="#394e47" stroke-width="2"/>`).join("")}</g><g id="doors">${f.geometry.doors.map((d) => `<polyline points="${pts([d.a, d.b])}" stroke="#c7902e" stroke-width="4"/>`).join("")}</g><g id="graph">${b.edges
    .filter((e) => e.floorId === f.id)
    .map(
      (e) =>
        `<polyline points="${pts(e.path)}" fill="none" stroke="${e.status === "reviewed" ? "#579382" : "#b95841"}" stroke-dasharray="5 5"/>`,
    )
    .join("")}</g><g id="photos">${b.photos
    .filter((p) => p.floorId === f.id)
    .map(
      (p) =>
        `<g transform="translate(${p.position.x} ${p.position.y}) rotate(${p.direction})"><path d="M0 0L-10 -25L10 -25Z" fill="#9768b7"/><circle r="5" fill="#704395"/></g>`,
    )
    .join("")}</g><g id="route">${routeDisplaySegments(route, f.id)
    .map(
      (s) =>
        `<polyline points="${pts(s.displayPoints)}" fill="none" stroke="#087a66" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`,
    )
    .join("")}</g></svg>`;
}
export async function exportPackage(building) {
  const b = parseBuilding(building),
    zip = new JSZip(),
    manifest = structuredClone(b);
  for (const [id, a] of Object.entries(b.assets)) {
    const extension =
        a.mime === "application/pdf"
          ? "pdf"
          : a.mime === "image/jpeg"
            ? "jpg"
            : "png",
      path = `assets/${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${extension}`;
    zip.file(path, a.dataUrl.split(",")[1], { base64: true });
    manifest.assets[id] = { ...a, dataUrl: undefined, path };
  }
  zip.file("project.json", JSON.stringify(manifest, null, 2));
  zip.file(
    "validation.json",
    JSON.stringify(
      {
        buildingId: b.id,
        at: new Date().toISOString(),
        issues: validateBuilding(b),
      },
      null,
      2,
    ),
  );
  for (const f of b.floors) {
    zip.file(
      `floors/${f.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.svg`,
      floorSVG(b, f.id),
    );
    zip.file(
      `designs/${f.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.svg`,
      designedSVG(b, f.id),
    );
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
export async function importPackage(bytes) {
  const zip = await JSZip.loadAsync(bytes),
    entry = zip.file("project.json");
  if (!entry) throw new Error("Package needs project.json.");
  const b = JSON.parse(await entry.async("string"));
  for (const a of Object.values(b.assets)) {
    if (!a.path || !zip.file(a.path))
      throw new Error("Missing packaged asset.");
    a.dataUrl = `data:${a.mime};base64,${await zip.file(a.path).async("base64")}`;
    delete a.path;
  }
  return parseBuilding(b);
}
