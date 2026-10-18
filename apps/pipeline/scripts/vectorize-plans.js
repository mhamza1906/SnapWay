// Vectorize raster plans to SVG with vectorizer.ai (development only).
// Usage: APP_ENV=dev node scripts/vectorize-plans.js <out-dir> <image…>
import "../server/env.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { vectorize } from "../server/vectorizer.js";

const [out, ...images] = process.argv.slice(2);
if (!out || !images.length) { console.error("Usage: APP_ENV=dev node scripts/vectorize-plans.js <out-dir> <image…>"); process.exit(1); }
await mkdir(out, { recursive: true });
for (const file of images) {
  const result = await vectorize(await readFile(file), { name: basename(file) }),
    target = join(out, basename(file, extname(file)) + ".svg");
  await writeFile(target, result.svg);
  console.log(`${basename(file)} → ${target} (${result.cached ? "cached" : `${result.credits} credit(s)`}; ${result.callsUsed}/${result.callsLimit} calls used)`);
}
