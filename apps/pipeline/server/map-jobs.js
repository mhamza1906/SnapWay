import { readFile } from "node:fs/promises";
import { SmartOptions, runSmartMap, atomicJson, sourceSignature } from "./pipelines/smart-map.js";
import { applyAccessDecisions } from "../shared/building/access.js";
import { clone } from "../shared/map.js";
const active = new Map();
const root = ".local/map-jobs";
const validId = id => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job ID."); return id; };
const path = (id, file) => `${root}/${validId(id)}/${file}.json`;
export async function getMapJob(id) {
  if (active.has(id)) return active.get(id).state;
  const job = JSON.parse(await readFile(path(id, "state"), "utf8"));
  if (job.status === "running") { job.status = "interrupted"; job.progress.message = "Server restarted; resume to reuse completed API stages."; }
  return job;
}
async function dispatch(id, building, options) {
  const controller = new AbortController(), state = { id, status: "running", options,
    progress: { stage: "queued", message: "Hybrid mapping queued" }, startedAt: new Date().toISOString() };
  active.set(id, { state, controller });
  await atomicJson(path(id, "state"), state);
  // Persist transition snapshots serially so older writes cannot win a race.
  let pending = Promise.resolve();
  const persist = () => { const snapshot = clone(state); pending = pending.then(() => atomicJson(path(id, "state"), snapshot)); return pending; };
  runSmartMap(building, options, { signal: controller.signal,
    progress: p => { state.progress = p; persist().catch(() => {}); },
  }).then(result => { state.status = result.status; state.result = result; })
    .catch(e => { state.status = controller.signal.aborted ? "cancelled" : "failed"; state.error = e.message; })
    .finally(async () => { state.finishedAt = new Date().toISOString(); await persist(); active.delete(id); });
  return { id };
}
export async function startMapJob(building, inputOptions) {
  const options = SmartOptions.parse(inputOptions), id = crypto.randomUUID();
  if (active.size >= 1) throw new Error("A mapping job is already running. Cancel it or wait for completion.");
  await atomicJson(path(id, "input"), { building, options });
  return dispatch(id, building, options);
}
export async function resumeMapJob(id, inputOptions) {
  if (active.size) throw new Error("A mapping job is already running.");
  const input = JSON.parse(await readFile(path(id, "input"), "utf8")),
    options = SmartOptions.parse({ ...input.options, ...inputOptions });
  await atomicJson(path(id, "input"), { building: input.building, options });
  return dispatch(id, input.building, options);
}
export async function cancelMapJob(id) {
  const job = active.get(id);
  if (job) { job.controller.abort(); return { cancelled: true }; }
  return { cancelled: false, status: (await getMapJob(id)).status };
}
// Apply to the client's current unsaved snapshot, after checking every source
// identity. Saving remains the ordinary project Save action with undo support.
export async function applyMapJob(id, building) {
  const job = await getMapJob(id);
  if (!job.result || job.status === "running") throw new Error("Wait for a completed pipeline result.");
  const proposals = job.result.proposals.filter(p => p.appliedPreview);
  if (!proposals.length) throw new Error("No checked proposal is ready. Resolve the review queue first.");
  for (const p of proposals) {
    const floor = building.floors.find(f => f.id === p.floorId), source = floor?.sources.find(s => s.id === p.sourceId);
    if (!source || sourceSignature(building, floor, source) !== p.signature)
      throw new Error("The source or geometry changed after this run. Start a new run before applying.");
  }
  let next = building;
  for (const p of proposals) {
    const decisions = p.mode === "access" ? p.decisions : [{ op: "replace-source", sourceId: p.sourceId, map: p.map, records: p.records, coverage: p.coverage, classifications: p.classifications }];
    for (const transaction of p.transactions?.length ? p.transactions : [decisions])
      next = applyAccessDecisions(next, p.floorId, transaction, { reviewer: "Hybrid API pipeline", reviewStatus: "agent-inspected" }).building;
  }
  return { building: next };
}
