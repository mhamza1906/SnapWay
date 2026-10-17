import "./env.js";
import { readFile } from "node:fs/promises";
import { runSmartMap, atomicJson } from "./pipelines/smart-map.js";
const [input, output, ...args] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node server/run-smart-map.js <building.json> <report.json> [floorId…] [--rebuild]");
  process.exitCode = 1;
} else {
  const building = JSON.parse(await readFile(input, "utf8")), ids = args.filter(x => x !== "--rebuild"),
    options = { floorIds: ids.length ? ids : building.floors.filter(f => f.sources.length).map(f => f.id), rebuild: args.includes("--rebuild") };
  const result = await runSmartMap(building, options, { progress: p => console.log(`${p.stage}: ${p.message} (${p.stats.calls} API calls, ${p.stats.cacheHits} cache hits)`) });
  await atomicJson(output.includes("/") ? output : "./" + output, result);
  console.log(JSON.stringify({ status: result.status, summary: result.summary, stats: result.stats }));
}
