# Pipeline operations

How to run the map-authoring pipeline (`apps/pipeline/`) safely: its limits, caches, measured cost, test suite and common failures.

Related pages:

- [README.md](README.md): overview.
- [environments.md](environments.md): single `local/.env` (Claude Sonnet 5.5 for mapping by default, Gemini on Vertex selectable), provider policy and team synchronization.
- [stages.md](stages.md): what each stage does internally.
- [api.md](api.md): HTTP endpoints.

All paths below are relative to `apps/pipeline/`. `server/start.js` changes into that folder before it loads settings, so `npm start`, `npm run prod` and `npm run dev` find the same env files and `.local/` from any working directory, Windows included. The service listens on `127.0.0.1:5175` by default (`PORT`).

## 1. Limits and budgets

### Job options (`SmartOptions`)

These are defined in `server/pipelines/smart-map.js`. A job request (`POST /api/map-jobs`, or a resume) can override any of them within the allowed range. They are the limits that were measured in the trials. Do not lower them to save money without measuring the effect on quality.

| Option | Default | Allowed | Meaning |
|---|---:|---|---|
| `floorIds` | (required) | 1–20 | Floors to process, in order |
| `rebuild` | `false` | | `false` keeps existing regions and only checks access. `true` re-extracts the source. |
| `concurrency` | 2 | 1–3 | Parallel detail-tile and opening-batch workers |
| `maxCalls` | 40 | 1–100 | Provider requests per job, counting retries and failed attempts |
| `maxTokens` | 500,000 | 1,000–2,000,000 | Reported-token allowance per job (soft; see below) |
| `deadlineMs` | 1,200,000 (20 min) | 1 s–1 h | Wall-clock deadline. All requests are aborted when it passes. |
| `maxDetailTiles` | 8 | 1–30 | Source detail tiles extracted per floor source |
| `maxSemanticBatches` | 4 | 0–10 | Region-classification batches, up to 8 regions each |
| `maxRepairTiles` | 2 | 0–10 | Targeted re-reads for inventory labels with no mapped region |
| `maxDoorBatches` | 50 | 0–50 | Opening-verification batches, up to 8 openings each. The call budget still applies. |
| `maxAccessRegions` | 8 | 0–100 | Unresolved regions given to the access investigator (existing-map mode only) |

Inside a smart-map job, the access investigator runs with `maxTurns: 4`, `retries: 0` and a per-region deadline of at most 5 minutes. Standalone access jobs (`/api/access/investigate`, `server/run-access-agent.js`) use `DOORWAY_LIMITS` in `server/pipelines/doorways.js` instead: 8 turns, 400,000 tokens, an 8-minute region deadline and 2 retries. Coverage, `/api/extract` and design requests do not go through the smart-map budget.

From the CLI, `server/build-from-plan.js` accepts `--max-calls`. `server/run-smart-map.js` does not expose any budget flags.

### Per-request output ceilings

| Request | `max_output_tokens` |
|---|---:|
| Label and footprint inventory | 12,000 |
| Detail extraction, wall-free (used by smart-map) | 16,000 |
| Detail extraction with full wall arrays (legacy, `/api/extract`) | 24,000 |
| Opening-verification batch | 6,000 |
| Region-semantics batch | 6,000 |
| Access-investigator turn | 8,000 |
| Single-segment check (access investigator) | 2,000 |
| Design suggestions | 6,000 |
| Adapter fallback when a body sets none | 8,192 (budget wrapper: 8,000) |

The budget wrapper lowers each ceiling to the allowance that is left (`maxTokens − stats.tokens`). The cache key is computed from the original body, so this lowering does not change cache keys.

### How the budget behaves

- Every model call in a job goes through one wrapper, `budgetProvider`. That includes tool continuations, independent checks and retries.
- Before each attempt, the wrapper checks the deadline, then `maxCalls`, then `maxTokens`. When a limit is reached it throws `PipelineLimit`. The job ends with `status: "limited"` and a `limit` queue item, for example "API call limit reached; resume to use completed stages". Completed responses stay cached, so a resume does not pay for them again.
- **Retry:** a request that fails with HTTP 429, any 5xx or a transient network error (`fetch failed`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `UND_ERR…`) is retried once. The retry counts against the call and token budgets. A second failure is reported. Aborts and timeouts are not retried.
- **Reported tokens are a soft allowance, not a billing cap.** The check runs only before a call starts. Input tokens are not limited. Two workers can be in flight at once, and each call adds its usage only after it returns. A job can therefore end somewhat above `maxTokens`. The allowance is also per job, not per account: other workflows, other machines and other jobs are not counted. Set billing limits in the provider console.
- Only one map job runs at a time per server (`server/map-jobs.js`). If the server restarts during a job, the job is marked `interrupted`, and a resume reuses the completed API stages.

## 2. Caching and reuse

### Where caches live

| Path | Contents | Key includes |
|---|---|---|
| `.local/map-pipeline/responses/` | Completed smart-map responses | `SMART_MAP_VERSION`, provider name, model, effort, full request body (prompt, schema, images) |
| `.local/map-pipeline/locks/` | Short-lived request leases | same key as the response |
| `.local/map-pipeline/opening-checks/` | Per-opening verifier observations | protocol version, join or door kind, source and original asset hashes, transform, rounded segment, provider, model, effort |
| `.local/cache/` | Single-image extractions (`/api/extract`) | image hash, provider, model, effort, pipeline version, options |
| `.local/coverage/` | Coverage jobs and inventories | image hash, provider, model, effort, coverage version, tiles, base map |
| `.local/access/` | Access-investigator results | agent, prompt, tool and access versions, provider, model, effort, floor revision, source hashes, region geometry |
| `.local/map-jobs/<id>/` | Durable job `input.json` and `state.json` | job UUID |
| `.local/project.json`, `.local/building.json`, `.local/buildings/`, `.local/extractions/` | Saved projects, building copies and extractions | |

How the caches behave:

- Only completed responses are cached. A response that fails schema parsing is deleted (`invalidateResponse`), so the next run asks again.
- Leases stop two runners from paying for the same request body. A second runner waits and then reads the first runner's result. A lease is taken over when its owner process is dead (after 2 s), or when it is older than twice the request timeout plus 10 s. Leases only remove exact duplicates. Requests that are semantically redundant but have a different prompt or crop are still paid for twice.
- Wall-free detail extraction can reuse an earlier, compatible full-wall response (`cacheAlternatives`).
- A reused opening observation is not a reused acceptance. Local validation and route checks run again on the current geometry every time.

### Switching provider or model is a cache miss

Provider, model and effort are part of every key. Switching from Claude to Vertex Gemini, changing `ANTHROPIC_MODEL`/`VERTEX_MODEL`, or changing effort therefore misses every cache, and the next run pays again in full. This is deliberate: evidence from one model must never be presented as another model's evidence. `seedOpeningChecks` can migrate observations only when the source hashes, the original-plus-locator crop protocol and the model all match. Do not seed arbitrary old records. Bump a version constant whenever a prompt, crop protocol or interpretation contract changes.

### Never wipe caches to force a rerun

The caches are the only record of work that has already been paid for, and offline replays depend on them. To get a fresh answer for one stage, bump that stage's version key, or delete only the one malformed entry. Never empty `.local/`.

### Keep `.local/` out of git

`apps/pipeline/.gitignore` ignores `.local/`, `output/` and `node_modules/`. Caches, map jobs and saved copies are therefore not committed. The repository root `.gitignore` ignores `.env` and `.env.*` (except the `*.example` files). Note that `public/buildings/waterloo-e2.json` is **not** ignored (see [Testing](#5-testing)).

## 3. Cost and usage measurement

### Reading `pipeline-result.json`

The CLIs write this file. Map jobs store the same object as `state.result`.

- `provider`, `model`, `effort`, `version`: the provider that produced the result, and the pipeline version.
- `stats.calls`: provider attempts made in this invocation, including retries and failed attempts. Cache hits are not counted.
- `stats.tokens`: the sum of the provider-reported `total_tokens`. For Anthropic this is input + output + prompt-cache creation + prompt-cache read. For Vertex it is `totalTokenCount`.
- `stats.cacheHits`: completed responses reused from disk.
- `stats.openingCacheHits`: opening observations reused.
- `stats.localMs`: time spent on local vector extraction.
- `summary`:
  - `regions`
  - `ready`: destinations with a usable connection to some other room. This does not mean connected to every room.
  - `destinations`
  - `reviewItems`
  - `elapsedMs`
  - `validationErrors`
- `status`: `complete`, `needs-review`, `limited`, `cancelled` (or `failed` for a job).
- `queue`: every item that still needs review, with a `type`: `coverage`, `opening`, `classification`, `access`, `geometry`, `graph-review`, `extraction`, `alignment`, `limit` or `failure`.

**Incomplete responses are now counted.** When a response stops early (Anthropic `stop_reason` other than end_turn/tool_use/stop_sequence, or a Vertex `finishReason` other than STOP), the error carries the usage and the wrapper adds it to `stats.tokens`. Before this fix, a cut-off response added 0. For example, the first 003E3 attempt reported 1 call and 0 tokens. For Anthropic incomplete responses, only input + output tokens are counted. Prompt caching is not configured, so the measured cache counters were 0.

**Still unknown:** HTTP errors and network failures carry no usage, and are added as 0. A zero for those attempts means "unknown", not "free". Trial reports note these as "+ unknown".

### Typical cost per floor (measured, Sonnet 5.5 / high)

A cold run of one single-page floor took roughly **16–21 fresh calls and 140k–260k reported tokens**.

| Run | Fresh calls | Reported tokens | Notes |
|---|---:|---:|---|
| 028C2 floor 1, round 1 | 17 | 211,241 | cold |
| 028C2 floor 2, round 1 | 21 | 259,134 | cold |
| 028C2 floor 3, round 1 | 16 | 186,408 | cold |
| 028C2 floor 3, round 3 | 18 | 142,572 | |
| 003E3 floor 1 (`e3-floor-1-v3`) | 21 | 232,012 | cold, 0 cache hits, 403 s |
| All 028C2 rounds (3 floors) | 157 | ≈1.67M | includes debugging reruns |

In the floor 1 breakdown, detail tiles used about 58% of the tokens, and thinking made up about two thirds of the detail output.

These figures are **estimates from reported usage, not invoices**. They leave out earlier or interrupted invocations. Warm reruns (for example 11 calls and 94k tokens for floor 1, round 3) reuse earlier work and are not cold-run costs. The trial summary priced the 1.67M tokens at roughly $7 using list prices. That estimate has not been checked against billing. An exact audit has to reconcile these figures with the provider's usage records.

**Production now defaults to Claude Sonnet 5.5 (high)**, so the Sonnet figures above apply to `.env.prod` unless it is switched to `AI_PROVIDER=vertex`. Gemini mapping figures are in the (historical) clean-plan trial below.

## 4. Measured trial results

All of the following were produced by the original Hack_The_valley project (`output/`). All evidence is agent-inspected, and none of it has been reviewed by a person.

### 028C2 (Chemistry 2), floors 1–3, Sonnet 5.5 / high

Each floor is one page, 2400×1855, with outlined labels. Route pairs are far-apart room pairs, and each pair was tested in both directions. The pair sets differ slightly between rounds.

| Floor | Round | Export | Rooms / labels mapped | Components (nodes) | Route pairs connected | Calls / tokens |
|---|---|---|---|---|---|---|
| 1 | R1 | yes | 24/37 rooms | 66, 11, 6, 2, 1×4 | 5/7 (4 detour through lab 162A) | 17 / 211k |
| 1 | R2 | no (2 `fetch failed` tiles) | 34/37 | 80, 12, 2, 1×5 | 1/7 | 18 / 190k |
| 1 | R3 | yes (`c2-floor-1-v3`) | 36/37 | 139, 10, 1×7 | 1/7 | 11 / 94k (warm) |
| 2 | R1 | yes | 32/60 labels | 83, 3, 3, 1×5 | 6/9 | 21 / 259k |
| 2 | R2 | no (2 `fetch failed` tiles) | 33/60 | 123, 1, 1 (local replay) | 1 of 3 testable | 18 / 199k + unknown |
| 2 | R3 | yes (`c2-floor-2-v3`) | 51/60, 0 missing | 122, 3, 1, 1, 1 | 7 of the 9 R1 pairs (summary: 7/10) | 17 / 154k (warm) |
| 3 | R1 | crashed (graph ID over 150 chars) | ≈30/48 | 2 corridor components + islands | 7/13 | 16 / 186k |
| 3 | R2 | no | 40/48 | 93 + 80 + islands | 6/14 | 19 (2 failed) / 215k |
| 3 | R3 | blocked (stair overlap) | 44/48 | 1 (173) | 13/14 | 18 / 143k |
| 3 | R4 | yes (`c2-floor-3-v4`) | 44/48 | 1 (173) | 13/14 | 2 / 15k |

Every route found had 0 invalid steps, and all wall and void negative cases were rejected. Door spot checks found no accepted false-positive door. The remaining failures came from geometry and the pipeline, not from Sonnet misreading the plan.

### 003E3, floor 1, Sonnet 5.5 / high

| Measure | Result |
|---|---|
| Run | `e3-floor-1-v3`: 21 calls, 232,012 tokens, 7 tiles, 0 tile failures, `needs-review`, 0 validation errors. `e3-floor-1-final` is a local replay of it. |
| Inventory coordinate ratio | 1.000 after `VISION_MAX_EDGE` = 2048. Before the fix, a 2292 px page came back at 0.955×. |
| Labels | 45/50 as reported by the coordinator. **Not reproduced from the saved files:** they show 50 regions and 43 of 48 coverage entries associated. The unassociated entries are 1107, 1159, 1161, Courtyard and Walkway. |
| Opening checks | 35 checked: 22 supported, 9 not supported, 4 uncertain |
| Final doors | 54 doorways. 62 opening records: 19 accepted with AI-verified evidence (13 door, 5 double-door, 1 exterior), 23 accepted assumed doors and 20 proposed but not accepted. 8 assumed doors were withdrawn as redundant. |
| Remaining gaps | (1) The east wing has two path components, because the link between the 1155 vestibule and corridor 1157 was never detected. (2) The west cluster is split internally. 1107 is also unmapped. Fix these with **Add a doorway**. |

Earlier E3 attempts failed with "Anthropic response did not complete (max_tokens)". These failures led to the tile-splitting and usage-counting fixes.

### Biology 1 (007B1), Opus 5.5 / high

The map has 114 regions, 133 openings (45 of them analytical joins), 45 of 53 destinations ready, 72 of 79 coverage entries associated, 48 review items and 0 validation errors. The 164 ↔ 174F route is disconnected, and the west wing and annex do not connect to the main component. This map was made with **Opus**, so it is not a Sonnet benchmark. It may also have been affected by the vision-cap bug (unverified).

### Bugs found and fixed during the trials

| Bug | Fix | Test |
|---|---|---|
| **Vision cap.** The API silently downscales large images, so coordinates came back at 0.909× (2400 px page) or 0.955× (2292 px page). Sonnet's measured effective long edge is about 2180 px. | `server/pipelines/vision-frame.js` sends images within 2048 px and 3.4 MP, states the frame that was sent and rescales the results. Both adapters throw on oversized images. | `vision-frame.test.js` |
| **ID length.** Graph edge IDs of 182–183 chars broke the 150-char limit and crashed the export. | `boundedId` in `shared/building/graph.js` (deterministic, at most 150 chars) | `vision-frame.test.js` |
| **Corridor joins.** Analytical seams were judged as doors and failed the door-width limit. | Joins are batched separately with a seam question. An open answer becomes a `decomposition-join`. | `smart-map.test.js` |
| **Network retry.** `fetch failed` was not retried, and one failed tile blocked the export. | One budgeted retry (`transientNetworkError`) | `smart-map.test.js` |
| **Tile ranking.** Clamped near-duplicate tiles crowded out distinct areas. | Greedy ordering by labels that earlier tiles do not already cover | `smart-map.test.js` |
| **Nested duplicates.** An enclosed same-kind region caused an overlap that blocked a whole floor. | A `nested-duplicate` rule in `shared/building/coverage.js`. Numbered rooms are never merged. | `plan-generalization.test.js` |
| **`max_tokens` splitting.** Dense tiles were cut off at the 16k ceiling. | Tiles with more than 14 labels are split before any request. A cut-off tile is re-read as overlapping halves, up to 4 pieces of at least 200 px. Tiles grow to take in labels within 80 px of the footprint. | `smart-map.test.js` |
| **Re-enabling supported doors.** Openings that the source supported stayed disabled only because of their classification. | `shared/building/assumed-doors.js` re-enables them before and after placing assumed doors, then drops assumed doors that have become redundant. | no dedicated test found (unverified) |
| **Bridging.** Some parts of the map were disconnected. | `bridgeComponents` (up to 12) uses detected openings that the verifier called "unclear". Wall and glazing verdicts are never overridden. | `assumed-doors.test.js` |

### Clean-plan trial

Sam Ibrahim board photo, 6 floors, prod (Vertex AI), October 17, 2026.
Historical: the clean (redraw) stage measured here was removed later the same
day; see [clean-plans.md](clean-plans.md). The mapping figures still describe
Gemini 4 throughput on Vertex.

| Run | Clean stage | Mapping (6 floors in parallel, Gemini 4 high) | Outcome |
| --- | --- | --- | --- |
| 1 | 147 s; 6 redraws in ~30 s | 1,201 s wall vs 5,426 s summed; 90 requests, 1.16 M tokens | Level B **35/35 rooms routable**; the other 5 floors held: detail tiles timed out (180 s limit), Level 2 inventory hit `MAX_TOKENS`, Level 1 corridor overlaps |
| 2 (timeout 5 min + retry) | 226 s (re-planned; split cache not yet in place) | Every floor reached its 20-minute deadline after 10–15 requests; Level 5's first request timed out twice | No floor applied |

**Finding:** with 6 floors × 2 requests in flight, this Vertex project answered
Gemini 4 (high) requests in several minutes each, so floors run out of time.
The same parallel layout on Claude (dev) finished 6 floors in 455 s earlier the
same day. Before relying on 6-way parallelism on Vertex, check the project's
quota/throughput, or lower `floorConcurrency`, or use medium effort for
extraction. Cached stages are reused on every resume.

## 5. Testing

```sh
cd apps/pipeline
npm test            # node --test tests/*.test.js
```

Latest result on this branch: **160 tests, 142 pass, 0 fail, 18 skipped**, in about 6 s.

The suite covers:

- budget, retry, leases, resume and cancel
- tile ranking and splitting
- corridor joins
- vision-frame scaling
- Anthropic and Vertex request translation, and their refusal, incomplete and HTTP-error paths
- the prod provider gate
- access transactions and route checks
- assumed doors
- coverage reconciliation
- design rendering
- route display
- the HTTP server: health without credentials, upload normalisation, cross-origin rejection, job-input validation

**No live calls.** Every test uses a synthetic provider or a stubbed `fetch`. `server.test.js` starts the server on `127.0.0.1:5174` with a placeholder key, and only calls endpoints that do not reach a provider. Some tests use the default cache paths, so they write synthetic entries into `.local/cache/` and `.local/coverage/`. The provider in those keys is a test one, so they cannot collide with real entries, and `.local/` is ignored.

**Skipped Waterloo tests.** 18 tests use `wtest` from `tests/fixtures/optional.js` (3 in access, 1 in anthropic, 6 in building and 8 in design). They are skipped unless the 16 MB regression building is present at `public/buildings/waterloo-e2.json`. To run them, copy it from the original project:

```sh
cp "../../../Hack_The_valley/public/buildings/waterloo-e2.json" public/buildings/
npm test
```

That path is not git-ignored. Do not commit the file, and remove it after the run if you are about to commit.

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Anthropic response did not complete (max_tokens)" or "Vertex AI response did not complete (MAX_TOKENS)" | A dense tile ran out of output room. Smart-map splits it automatically (up to 4 pieces). If a piece still fails, it stays in the queue as an `extraction` item. Do not raise the ceilings. Reduce the tile instead, or map that area by hand. The tokens are counted in `stats.tokens`. |
| Coordinates shifted, with rooms drawn smaller or off towards the top-left | The image exceeded the vision frame. Check that every coordinate-bearing image goes through `fitVisionFrame` or `renderSourceCrop`. If an adapter reports "Image W×H exceeds the vision frame", fit the image first. Never raise `VISION_MAX_EDGE`. Results cached before the fix keep the old frame. |
| "Route access check failed: …" | `applyAccessDecisions` rejected the whole transaction, and the building was not changed. The message names the problem: "No valid doorway node", "Doorway is isolated from other rooms", "Room has no usable doorway endpoint" or "Doorway path …". Fix the opening or the neighbouring region and apply again. |
| Rooms listed under "Needs attention" in the Doorways panel | These are walkable regions with no usable doorway. Use **Place assumed doorways**, **Make it a room** or **Not a room**, or add a doorway. |
| A disconnected wing or cluster | A real link was never detected (for example 1155 ↔ 1157 on 003E3). Check the original PDF, then use **Add a doorway to any room**, choose the edge and add it. The pipeline never bridges a wall or glazing verdict. |
| `403 {"error":"Only local app requests are accepted."}` | The browser origin is not allowed. Allowed origins are `localhost` and `127.0.0.1` on `PORT` (5175), plus `PIPELINE_ALLOWED_ORIGINS`. Setting that variable **replaces** its default (`http://localhost:4200,http://127.0.0.1:4200`), so list every origin you need. Restart after editing. |
| The service exits at startup with "Pipeline provider settings are invalid for APP_ENV=…" | The provider settings failed validation before the server listened. For example, "APP_ENV=prod requires AI_PROVIDER=vertex", an unknown `AI_PROVIDER`, or `VERTEX_EFFORT` or `ANTHROPIC_EFFORT` out of range. `APP_ENV` defaults to `prod`, and both policies read the same `local/.env`. Fix that file or use explicit authorized process overrides with dev policy. There is no automatic fallback. See [environments.md](environments.md). |
| "AI requests need VERTEX_API_KEY and VERTEX_PROJECT…" | The provider is selected but has no credential. Add the credential to `local/.env`, which is server-only and never printed. |
| Job status `limited` | A call, token or deadline limit was reached. Resume the job (optionally with larger options). Completed stages are reused. |
| "A mapping job is already running" | Only one job runs at a time. Wait for it, or cancel it. |

## 7. Known limitations and next steps

- **Django/Celery integration.** Jobs run inside this Node process. They are persisted under `.local/map-jobs/`, and only one runs at a time. SnapWay's backend does not yet queue, track or authorise them.
- **Python port.** The pipeline is Node only. A port to the SnapWay backend has not started.
- **Per-call usage manifest.** `stats` keeps only totals. In the trials, token categories had to be rebuilt from the response cache. A planned append-only manifest would record the stage, hashes, model and effort, request ID, native token counters, latency, attempts and stop reason, without keys or image payloads.
- **Vertex quality and cost have not been benchmarked.** All measured trials used Claude. Before relying on prod output, run one measured Vertex trial on a 028C2 floor and compare it with the table above.
- **Multi-floor connectors are manual.** Stairs and elevators between floors are not linked automatically. Multi-page PDFs need floors assigned in the editor, and `build-from-plan` labels its floor from `--floor` and `--floor-label`, not from the plan's title.
- The access step still has some open local problems. Same-label room pieces are split at tile edges. Rooms stop a few pixels short of a corridor. Corridor ends are left unmapped. Validated doors are sometimes dropped by local checks. See `output/c2-coordination/SUMMARY.md` in the original project.
