// Runs the doorway investigation agent from the command line with the
// configured server provider. Results are proposals/unresolved findings only.
//   node server/run-access-agent.js <building.json> <floorId> <spaceId…> [--merge]
// --merge appends the records to .local/building.json and the published sample
// for human review in Verify access; nothing is accepted automatically.
import "./env.js";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { parseBuilding } from "../shared/building/schema.js";
import { createProvider } from "./provider.js";
import { runAccessJob } from "./pipelines/doorways.js";

const args = process.argv.slice(2),
  merge = args.includes("--merge"),
  [input, floorId, ...spaceIds] = args.filter((a) => a !== "--merge");
if (!input || !floorId || !spaceIds.length)
  throw new Error("Usage: run-access-agent.js <building.json> <floorId> <spaceId…> [--merge]");
const building = parseBuilding(await readFile(input, "utf8")),
  provider = createProvider();
console.log(`Provider ${provider.name} · model ${provider.model}`);
const started = Date.now(),
  job = await runAccessJob(building, floorId, spaceIds, {
    provider,
    progress: (p) => console.log(`[${p.completed}/${p.total}] ${p.message}`),
  });
for (const r of job.results)
  console.log(
    JSON.stringify(
      {
        spaceId: r.spaceId,
        status: r.status,
        cached: r.cached,
        stop: r.stop,
        tokens: r.tokens,
        error: r.error,
        tools: r.transcript?.map((t) => `${t.tool}${t.ok ? "" : "✗ " + t.error}`),
        summary: r.summary,
        records: r.records.map((x) => ({
          kind: x.kind,
          status: x.status,
          type: x.openingType,
          adjacent: x.adjacentIds,
          segment: x.segment,
          validation: x.validation && {
            passed: x.validation.passed,
            failures: x.validation.failures,
            route: x.validation.routeCheck,
          },
          verifier: x.evidence.verifier,
          evidence: x.evidence.description,
          reason: x.reason,
        })),
      },
      null,
      2,
    ),
  );
await mkdir("output/access-agent", { recursive: true });
const file = `output/access-agent/${floorId}-${Date.now()}.json`;
await writeFile(
  file,
  JSON.stringify({ input, floorId, seconds: (Date.now() - started) / 1000, ...job }, null, 2),
);
console.log(`Saved ${file}`);
if (merge) {
  const saved = parseBuilding(await readFile(".local/building.json", "utf8")),
    f = saved.floors.find((f) => f.id === floorId),
    ids = new Set(f.access.records.map((r) => r.id)),
    records = job.results.flatMap((r) => r.records).filter((r) => !ids.has(r.id));
  f.access.records.push(...records);
  saved.updatedAt = new Date().toISOString();
  const text = JSON.stringify(parseBuilding(saved));
  for (const path of [".local/building.json", "public/buildings/waterloo-e2.json"]) {
    await writeFile(path + ".tmp", text);
    await rename(path + ".tmp", path);
  }
  console.log(`Merged ${records.length} record(s) for review.`);
}
process.exit(0);
