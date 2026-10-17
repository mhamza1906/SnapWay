// Every building on this machine, in one catalog: published library files, the
// editor's saved project, saved copies of uploaded buildings, pipeline exports,
// and (when DATABASE_URL is set) buildings saved to Tiger Data. The editor and the
// mobile API both list and open buildings from here.
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { BuildingSchema } from "../shared/building/schema.js";
import { buildingSummary } from "../shared/building/navigation-bundle.js";
import { cloudStore, safeError } from "./cloud-store.js";

export const PUBLISHED_DIR = "public/buildings",
  EDITOR_SAVE = ".local/building.json",
  COPIES_DIR = ".local/buildings",
  EXPORTS_DIR = "output";
export const SOURCE_LABELS = {
  published: "Published library",
  "editor-save": "Saved project",
  "saved-copy": "Saved copies",
  "pipeline-export": "Pipeline exports",
  cloud: "Tiger Data",
};
const CLOUD_PREFIX = "cloud-";

const listJson = async (dir) => {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};

async function candidates() {
  const out = [];
  for (const f of await listJson(PUBLISHED_DIR))
    out.push({ key: basename(f, ".json"), file: join(PUBLISHED_DIR, f), source: "published" });
  out.push({ key: "editor-save", file: EDITOR_SAVE, source: "editor-save" });
  for (const f of await listJson(COPIES_DIR))
    out.push({ key: "copy-" + basename(f, ".json"), file: join(COPIES_DIR, f), source: "saved-copy" });
  let dirs = [];
  try { dirs = (await readdir(EXPORTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const d of dirs) out.push({ key: "export-" + d, file: join(EXPORTS_DIR, d, "building.json"), source: "pipeline-export" });
  return out;
}

// Parsed buildings are cached by file identity, so a large project is parsed
// and validated once per change rather than once per request.
const cache = new Map();
async function load(entry) {
  const info = await stat(entry.file),
    identity = `${info.mtimeMs}:${info.size}`,
    hit = cache.get(entry.file);
  if (hit?.identity === identity) return { ...hit, key: entry.key, source: entry.source };
  const building = BuildingSchema.parse(JSON.parse(await readFile(entry.file, "utf8"))),
    spaces = building.floors.flatMap((f) => f.geometry.spaces);
  const loaded = {
    identity,
    building,
    file: entry.file,
    summary: {
      ...buildingSummary(building),
      rooms: spaces.filter((s) => !["corridor", "lobby"].includes(s.kind) && s.access !== "nonwalkable").length,
      regions: spaces.length,
      reviewedFloors: building.floors.filter((f) => f.geometryStatus === "reviewed").length,
      sizeBytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
    },
  };
  cache.set(entry.file, loaded);
  return { ...loaded, key: entry.key, source: entry.source };
}

// Unreadable or invalid files are skipped with a warning, never fatal.
async function fileEntries() {
  const entries = [];
  for (const c of await candidates())
    try {
      const e = await load(c);
      entries.push({ ...e, summary: { key: c.key, source: c.source, sourceLabel: SOURCE_LABELS[c.source], file: c.file, ...e.summary } });
    } catch (e) {
      if (e.code !== "ENOENT") console.warn(`Skipping ${c.file}: ${e.message}`);
    }
  return entries;
}

// Tiger Data rows are listed by stored summary. An unreachable database is
// skipped for a minute so listing stays fast; local files are always listed.
let cloudDownUntil = 0;
async function cloudEntries(store) {
  if (!store.settings.database || Date.now() < cloudDownUntil) return [];
  try {
    return (await store.listBuildings()).map((e) => ({
      key: e.key,
      source: "cloud",
      summary: { key: e.key, source: "cloud", sourceLabel: SOURCE_LABELS.cloud, ...e.summary },
    }));
  } catch (e) {
    cloudDownUntil = Date.now() + 60_000;
    console.warn(`Skipping Tiger Data buildings: ${safeError(e)}`);
    return [];
  }
}

export async function libraryEntries({ store = cloudStore() } = {}) {
  return [...(await fileEntries()), ...(await cloudEntries(store))];
}

export async function libraryEntry(key, { store = cloudStore() } = {}) {
  if (key.startsWith(CLOUD_PREFIX)) {
    if (!store.settings.database) return null;
    const building = await store.getBuilding(key.slice(CLOUD_PREFIX.length));
    return building ? { key, source: "cloud", building } : null;
  }
  return (await fileEntries()).find((e) => e.key === key) || null;
}

// Saves a copy of the current building into the catalog. Re-saving the same
// building updates its copy instead of creating another.
export async function saveCopy(input) {
  const building = BuildingSchema.parse(input);
  await mkdir(COPIES_DIR, { recursive: true });
  const existing = (await fileEntries()).find((e) => e.source === "saved-copy" && e.building.id === building.id),
    slug = (building.name || "building").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "building",
    file = existing?.file || join(COPIES_DIR, `${slug}-${createHash("sha256").update(building.id).digest("hex").slice(0, 8)}.json`);
  await writeFile(file + ".tmp", JSON.stringify(building));
  await rename(file + ".tmp", file);
  return { key: "copy-" + basename(file, ".json"), file, updated: !!existing };
}
