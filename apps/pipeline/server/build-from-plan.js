import "./env.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname, resolve, join } from "node:path";
import sharp from "sharp";
import { preparePlan } from "./pipelines/preparation.js";
import { runSmartMap, atomicJson } from "./pipelines/smart-map.js";
import { hashBytes } from "./pipelines/extraction.js";
import { newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { emptyMap } from "../shared/map.js";
import { applyAccessDecisions } from "../shared/building/access.js";
import { designedSVG } from "../shared/building/design.js";
import { exportPackage } from "../shared/building/export.js";
import { validateBuilding } from "../shared/building/validation.js";
import { placeAssumedDoorways } from "../shared/building/assumed-doors.js";
const [input, destination, ...flags] = process.argv.slice(2);
if (!input || !destination) throw new Error("Usage: node server/build-from-plan.js <plan.pdf|png|jpg> <output-directory> [--max-calls=40] [--name=Building] [--floor=1] [--floor-label=\"Floor 1\"] [--no-assumed-doors]");
const directory = resolve(destination), bytes = await readFile(input), extension = extname(input).toLowerCase(),
  mime = extension === ".pdf" ? "application/pdf" : extension === ".png" ? "image/png" : [".jpg", ".jpeg"].includes(extension) ? "image/jpeg" : null;
if (!mime) throw new Error("Use PDF, PNG or JPEG.");
const prepared = await preparePlan(bytes, basename(input), mime);
if (prepared.sources.length !== 1) throw new Error("Assign multi-page source plans to their floors in the editor before running the pipeline.");
const flag = name => flags.find(f => f.startsWith(`--${name}=`))?.split("=").slice(1).join("="),
  source = { ...prepared.sources[0], geometryIds: [], alignment: "reviewed",
    notes: "Agent checked identity source-to-floor coordinates for the only source. No human alignment review claimed." },
  floorLevel = Number(flag("floor") || 1),
  building = newBuilding(), floor = newFloor(`floor-${floorLevel}`, flag("floor-label") || `Floor ${floorLevel}`, floorLevel);
building.id = "plan-" + hashBytes(bytes).slice(0,16);
building.name = flag("name") || basename(input, extension);
building.provenance = "Automatic hybrid pipeline from one original source; uncertain access remains disabled.";
building.assets = prepared.assets;
floor.width = source.width; floor.height = source.height; floor.sources = [source];
floor.geometry = emptyMap({ name: source.name, width: source.width, height: source.height,
  dataUrl: building.assets[source.assetId].dataUrl, normalized: true, provenance: "Original source", fictional: false });
building.floors = [floor];
await mkdir(directory, { recursive: true });
await atomicJson(join(directory, "input-building.json"), parseBuilding(building));
const controller = new AbortController(); process.once("SIGINT", () => controller.abort());
const result = await runSmartMap(building, { floorIds: [floor.id], rebuild: true,
  maxCalls: Number(flag("max-calls") || 40),
}, { signal: controller.signal, progress: p => console.log(`${p.stage}: ${p.message} (${p.stats.calls} requests, ${p.stats.cacheHits} cache hits)`) });
await atomicJson(join(directory, "pipeline-result.json"), result);
let built = building;
for (const p of result.proposals.filter(p => p.appliedPreview))
  built = applyAccessDecisions(built, p.floorId, [{ op: "replace-source", sourceId: p.sourceId,
    map: p.map, coverage: p.coverage, records: p.records, classifications: p.classifications }],
    { reviewer: "Hybrid API pipeline", reviewStatus: "agent-inspected" }).building;
// Rooms whose doorway the source review could not establish get an explicitly
// assumed door at the middle of their hallway edge, unless disabled.
const assumed = [];
if (!flags.includes("--no-assumed-doors"))
  for (const f of built.floors.filter(f => f.geometry.spaces.length && f.geometryStatus === "reviewed")) {
    const r = placeAssumedDoorways(built, f.id);
    built = r.building;
    assumed.push({ floorId: f.id, placed: r.placed, skipped: r.skipped });
    console.log(`assumed doorways: ${f.label}: ${r.placed.length} placed, ${r.skipped.length} need manual editing`);
  }
if (!built.floors.some(f => f.geometry.spaces.length)) {
  console.log("Proposal retained; review or resume is needed before a checked map can be exported.");
  process.exitCode = 2;
} else {
  // Keep completed paid work even if the export schema rejects the project.
  await atomicJson(join(directory, "building.unchecked.json"), built);
  const checked = parseBuilding(built), svg = designedSVG(checked, floor.id);
  await atomicJson(join(directory, "building.json"), checked);
  await atomicJson(join(directory, "validation.json"), validateBuilding(checked));
  await atomicJson(join(directory, "assumed-doors.json"), assumed);
  await writeFile(join(directory, "map.svg"), svg);
  await sharp(Buffer.from(svg)).resize({ width: 2000, height: 2000, fit: "inside" }).png().toFile(join(directory, "map.png"));
  await writeFile(join(directory, "map-package.zip"), await exportPackage(checked));
  console.log(JSON.stringify({ status: result.status, stats: result.stats, summary: result.summary, output: directory }));
}
