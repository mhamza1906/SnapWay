import sharp from "sharp";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createProvider } from "../provider.js";
import { cachedExtraction, hashBytes } from "./extraction.js";
import { consolidateCoverage } from "../../shared/building/coverage.js";

export const COVERAGE_VERSION = "coverage-v2-2026-10-16";
export function planTiles(
  width,
  height,
  { tileSize = 600, overlap = 0.25 } = {},
) {
  const result = [],
    step = Math.round(tileSize * (1 - overlap));
  if (tileSize < 100 || tileSize > 1600 || overlap < 0.1 || overlap > 0.5)
    throw new Error("Invalid detail tile configuration.");
  const axis = (n) => {
    const values = [0];
    while (values.at(-1) + tileSize < n) {
      const next = Math.min(n - tileSize, values.at(-1) + step);
      if (next === values.at(-1)) break;
      values.push(next);
    }
    return values;
  };
  for (const y of axis(height))
    for (const x of axis(width))
      result.push({
        x,
        y,
        width: Math.min(tileSize, width),
        height: Math.min(tileSize, height),
      });
  return result;
}
export const tileInstructions =
  "This is an overlapping enlarged detail, not a separate floor. Map EVERY visible enclosed space, including tiny offices, washrooms, stair enclosures, elevator cabins and storage. Preserve letter suffixes. Use one polygon per physically distinct room; continuously open subdivided areas can share one polygon with all their labels. Label unlabelled enclosed spaces descriptively. Include adjoining corridors and actual door gaps with both adjacent space references. Mark clipped geometry at crop boundaries in issues. Preserve room labels whose leaders point into small rooms. Exclude only tags referring to a doorway without a separate enclosed room, along with legends and site/location insets. Do not silently skip small rooms.";

export async function runCoveragePipeline(
  source,
  {
    provider = createProvider(),
    baseMap = null,
    tiles = null,
    progress = () => {},
    concurrency = 2,
  } = {},
) {
  if (!provider.configured)
    throw new Error(
      "Configure the server image provider before scanning coverage.",
    );
  const bytes = Buffer.from(source.dataUrl.split(",")[1], "base64"),
    imageHash = hashBytes(bytes);
  const key = hashBytes(
    JSON.stringify({
      imageHash,
      model: provider.model,
      ...(provider.effort ? { effort: provider.effort } : {}),
      provider: provider.name,
      version: COVERAGE_VERSION,
      tiles,
      base: baseMap ? { spaces: baseMap.spaces, doors: baseMap.doors } : null,
    }),
  );
  const path = `.local/coverage/${key}.json`;
  try {
    const result = JSON.parse(await readFile(path, "utf8"));
    if (!result.coverage.failures?.length) return { ...result, cached: true };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const sourceTiles = tiles || planTiles(source.width, source.height),
    sections = [],
    failures = [],
    skippedTiles = [];
  progress({
    stage: "inventory",
    completed: 0,
    total: sourceTiles.length,
    message: "Independently inventorying room labels",
  });
  const inventoryPath = `.local/coverage/inventory-${hashBytes(JSON.stringify({ imageHash, model: provider.model, provider: provider.name, ...(provider.effort ? { effort: provider.effort } : {}), version: COVERAGE_VERSION }))}.json`;
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    inventory = provider.inventory
      ? await provider.inventory(source)
      : {
          items: [],
          notes: [
            "Independent label inventory is unavailable for this provider; completeness requires manual inventory.",
          ],
        };
    await mkdir(".local/coverage", { recursive: true });
    await writeFile(inventoryPath + ".tmp", JSON.stringify(inventory));
    await rename(inventoryPath + ".tmp", inventoryPath);
  }
  let next = 0,
    completed = 0;
  async function worker() {
    while (next < sourceTiles.length) {
      const i = next++,
        crop = sourceTiles[i];
      try {
        if (
          inventory.footprints?.length &&
          !inventory.footprints.some((p) => {
            const xs = p.map((v) => v.x),
              ys = p.map((v) => v.y);
            return (
              crop.x < Math.max(...xs) &&
              crop.x + crop.width > Math.min(...xs) &&
              crop.y < Math.max(...ys) &&
              crop.y + crop.height > Math.min(...ys)
            );
          })
        ) {
          skippedTiles.push({
            tile: i + 1,
            crop,
            reason: "Outside floor footprint",
          });
          completed++;
          progress({
            stage: "details",
            completed,
            total: sourceTiles.length,
            message: `Checked detail ${completed} of ${sourceTiles.length}`,
            failures,
          });
          continue;
        }
        const tile = sharp(bytes).extract({
          left: Math.round(crop.x),
          top: Math.round(crop.y),
          width: Math.round(crop.width),
          height: Math.round(crop.height),
        });
        const stats = await tile.clone().stats();
        if (stats.channels.every((c) => c.min > 235)) {
          skippedTiles.push({ tile: i + 1, crop, reason: "Blank image tile" });
          completed++;
          progress({
            stage: "details",
            completed,
            total: sourceTiles.length,
            message: `Checked detail ${completed} of ${sourceTiles.length}`,
            failures,
          });
          continue;
        }
        const { data, info } = await tile
          .resize({
            width: Math.round(crop.width * 2.5),
            height: Math.round(crop.height * 2.5),
            fit: "fill",
          })
          .png()
          .toBuffer({ resolveWithObject: true });
        const input = {
          ...source,
          name: `${source.name} · detail ${i + 1}`,
          width: info.width,
          height: info.height,
          dataUrl: "data:image/png;base64," + data.toString("base64"),
        };
        const result = await cachedExtraction(input, provider, {
          instructions: tileInstructions,
        });
        sections.push({
          map: result.map,
          crop,
          cacheKey: result.cacheKey,
          cached: result.cached,
        });
      } catch (e) {
        failures.push({ tile: i + 1, crop, message: e.message });
      }
      completed++;
      progress({
        stage: "details",
        completed,
        total: sourceTiles.length,
        message: `Mapped detail ${completed} of ${sourceTiles.length}`,
        failures,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, 3) }, worker));
  if (!sections.length)
    throw new Error("No detail passes completed. Existing map retained.");
  progress({
    stage: "reconcile",
    completed,
    total: sourceTiles.length,
    message: "Reconciling duplicate rooms, boundaries, and doorway references",
  });
  sections.sort((a, b) => a.crop.y - b.crop.y || a.crop.x - b.crop.x);
  const result = consolidateCoverage(source, sections, {
    baseMap,
    inventory: inventory.items,
    footprints: inventory.footprints || [],
  });
  result.coverage = {
    ...result.coverage,
    sourceHash: imageHash,
    pipeline: COVERAGE_VERSION,
    inventoryNotes: inventory.notes,
    failures,
    skippedTiles,
    scannedTiles: sections.map((s) => ({
      crop: s.crop,
      cacheKey: s.cacheKey,
      cached: s.cached,
    })),
    provider: provider.name,
    model: provider.model,
  };
  const output = { ...result, cacheKey: key, cached: false };
  await mkdir(".local/coverage", { recursive: true });
  await writeFile(path + ".tmp", JSON.stringify(output));
  await rename(path + ".tmp", path);
  progress({
    stage: "complete",
    completed,
    total: sourceTiles.length,
    message: "Coverage proposal ready for comparison",
    failures,
  });
  return output;
}
