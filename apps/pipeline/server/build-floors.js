import "./env.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname, resolve, join } from "node:path";
import sharp from "sharp";
import { preparePlan } from "./pipelines/preparation.js";
import { runSmartMap, atomicJson, applyProposals } from "./pipelines/smart-map.js";
import { hashBytes } from "./pipelines/extraction.js";
import { newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { emptyMap } from "../shared/map.js";
import { designedSVG } from "../shared/building/design.js";
import { exportPackage } from "../shared/building/export.js";
import { validateBuilding } from "../shared/building/validation.js";
import { placeAssumedDoorways } from "../shared/building/assumed-doors.js";
import { roomAvailability } from "../shared/building/routing.js";
import { createProvider } from "./provider.js";

// One building from N plan files: each file becomes its own labelled floor and
// all floors run through the model pipeline at the same time (one independent
// pipeline per floor, each with its own request budget).
const args = process.argv.slice(2), flags = args.filter((a) => a.startsWith("--")), [destination, ...inputs] = args.filter((a) => !a.startsWith("--"));
if (!destination || !inputs.length)
  throw new Error('Usage: node server/build-floors.js <output-directory> <plan1.pdf|png|jpg> <plan2> ... [--labels="Level B,Level 1,..."] [--levels="-1,1,..."] [--name=Building] [--max-calls=40] [--floor-concurrency=6] [--segmentation=auto|raster|model] [--no-assumed-doors]');
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.split("=").slice(1).join("="),
  labels = flag("labels")?.split(",").map((s) => s.trim()) || [],
  levels = flag("levels")?.split(",").map(Number) || [];
if (labels.length && labels.length !== inputs.length) throw new Error("Give one label per input file.");
if (levels.length && levels.length !== inputs.length) throw new Error("Give one level per input file.");
const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

const directory = resolve(destination);
let building = newBuilding();
const hashes = [];
building.assets = {};
building.floors = [];
await mkdir(directory, { recursive: true });
for (const [i, input] of inputs.entries()) {
  const extension = extname(input).toLowerCase(), mime = MIME[extension];
  if (!mime) throw new Error(`${input}: use PDF, PNG or JPEG.`);
  const bytes = await readFile(input), prepared = await preparePlan(bytes, basename(input), mime);
  if (prepared.sources.length !== 1) throw new Error(`${input}: one page per floor file; split multi-page PDFs first.`);
  hashes.push(hashBytes(bytes));
  const level = levels[i] ?? i + 1, label = labels[i] || basename(input, extension),
    source = { ...prepared.sources[0], geometryIds: [], alignment: "reviewed",
      notes: "Agent checked identity source-to-floor coordinates for the only source on this floor. No human alignment review claimed." },
    floor = newFloor(`floor-${i + 1}`, label, level);
  Object.assign(building.assets, prepared.assets);
  floor.width = source.width; floor.height = source.height; floor.sources = [source];
  floor.geometry = emptyMap({ name: source.name, width: source.width, height: source.height,
    dataUrl: building.assets[source.assetId].dataUrl, normalized: true, provenance: "Original source", fictional: false });
  building.floors.push(floor);
}
building.id = "plan-" + hashBytes(hashes.join(":")).slice(0, 16);
building.name = flag("name") || "Multi-floor building";
building.provenance = `Automatic hybrid pipeline: ${inputs.length} original sources, one per floor, processed in parallel; uncertain access remains disabled.`;
await atomicJson(join(directory, "input-building.json"), parseBuilding(building));

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
let lastLine = "";
const result = await runSmartMap(building, {
  floorIds: building.floors.map((f) => f.id), rebuild: true,
  maxCalls: Number(flag("max-calls") || 40), floorConcurrency: Number(flag("floor-concurrency") || 6),
  ...(flag("segmentation") ? { segmentation: flag("segmentation") } : {}),
}, { signal: controller.signal, progress: (p) => {
  const line = p.floors ? Object.values(p.floors).map((f) => `${f.label}: ${f.done ? f.status : f.stage} ${f.stats?.calls ?? 0}r`).join(" | ") : p.message;
  if (line !== lastLine) console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  lastLine = line;
} });
await atomicJson(join(directory, "pipeline-result.json"), result);

let built = applyProposals(building, result.proposals);
const assumed = [];
if (!flags.includes("--no-assumed-doors"))
  for (const f of built.floors.filter((f) => f.geometry.spaces.length && f.geometryStatus === "reviewed")) {
    const r = placeAssumedDoorways(built, f.id);
    built = r.building;
    assumed.push({ floorId: f.id, placed: r.placed, skipped: r.skipped });
  }
await atomicJson(join(directory, "building.unchecked.json"), built);
const checked = parseBuilding(built), rooms = roomAvailability(checked);
await atomicJson(join(directory, "building.json"), checked);
await atomicJson(join(directory, "validation.json"), validateBuilding(checked));
await atomicJson(join(directory, "assumed-doors.json"), assumed);
for (const f of checked.floors.filter((f) => f.geometry.spaces.length)) {
  const svg = designedSVG(checked, f.id), name = `map-${f.id}`;
  await writeFile(join(directory, `${name}.svg`), svg);
  await sharp(Buffer.from(svg)).resize({ width: 2000, height: 2000, fit: "inside" }).png().toFile(join(directory, `${name}.png`));
}
await writeFile(join(directory, "map-package.zip"), await exportPackage(checked));
const perFloor = result.parallel?.floors || [{ floorId: building.floors[0].id, label: building.floors[0].label, status: result.status, elapsedMs: result.summary.elapsedMs, stats: result.stats }];
const report = {
  status: result.status, provider: result.provider, model: result.model, effort: result.effort,
  wallClockMs: result.summary.elapsedMs, sumOfFloorMs: result.summary.sequentialMs ?? result.summary.elapsedMs,
  stats: result.stats,
  floors: perFloor.map((p) => {
    const f = checked.floors.find((f) => f.id === p.floorId), r = rooms.filter((r) => r.floorId === p.floorId);
    return { label: p.label, status: p.status, seconds: Math.round((p.elapsedMs || 0) / 1000), requests: p.stats?.calls, tokens: p.stats?.tokens, cacheHits: p.stats?.cacheHits,
      spaces: f?.geometry.spaces.length || 0, doors: f?.geometry.doors.length || 0,
      edges: checked.edges.filter((e) => e.floorId === p.floorId).length,
      readyRooms: `${r.filter((x) => x.ready).length}/${r.length}`,
      assumedDoors: assumed.find((a) => a.floorId === p.floorId)?.placed.length || 0 };
  }),
  output: directory,
};
await atomicJson(join(directory, "parallel-report.json"), report);
console.log(JSON.stringify(report, null, 2));
