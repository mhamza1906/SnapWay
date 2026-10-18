// Claude reads each vectorized floor plan closely, all floors in parallel.
// Usage: APP_ENV=dev node scripts/analyze-svgs.js <out-dir> <svg…>
// Writes <name>.analysis.json per SVG; failures are reported per file.
import "../server/env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { analyzeSvg } from "../server/svg-analysis.js";

const [out, ...files] = process.argv.slice(2);
if (!out || !files.length) { console.error("Usage: APP_ENV=dev node scripts/analyze-svgs.js <out-dir> <svg…>"); process.exit(1); }
if (process.env.APP_ENV !== "dev") { console.error("SVG analysis uses Claude: run with APP_ENV=dev."); process.exit(1); }
await mkdir(out, { recursive: true });
const started = Date.now();
const results = await Promise.allSettled(files.map(async (file) => {
  const name = basename(file, ".svg"), label = name.replace(/-original$/, "").replace("-", " "), t = Date.now();
  const result = await analyzeSvg(await readFile(file, "utf8"), { label });
  await writeFile(join(out, `${name}.analysis.json`), JSON.stringify({ file: basename(file), model: result.model, shapes: result.shapes, usage: result.usage, ...result.analysis }, null, 2));
  const a = result.analysis;
  console.log(`${label}: ${a.rooms.length} rooms, ${a.corridors.length} corridors, ${a.doorways.length} doorways, ${a.noise.length} noise groups, ${a.vectorizationIssues.length} issues · ${Math.round((Date.now() - t) / 1000)} s · in ${result.usage.input_tokens} / out ${result.usage.output_tokens} tokens`);
}));
results.forEach((r, i) => r.status === "rejected" && console.log(`${basename(files[i])}: FAILED ${r.reason.message}`));
console.log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
