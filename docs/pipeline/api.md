# Pipeline HTTP API and CLI reference

This is the reference for the HTTP routes and command-line tools of the
map-authoring service in `apps/pipeline/`. To learn what the service is and how
to run it, read [README.md](README.md). For settings and providers, see
[environments.md](environments.md). The pipeline stages behind a mapping job are
described in [stages.md](stages.md), and cost, caches and recovery in
[operations.md](operations.md).

Sources: `server/index.js`, `server/authoring-routes.js`, `server/map-jobs.js`,
`server/building-library.js`, and the CLIs in `server/`.

## Conventions

- **Base URL.** `http://127.0.0.1:<PORT>`. `PORT` defaults to `5175`. The
  service binds only to loopback and has no authentication.
- **Starting it.** Use `npm start` or `npm run prod`, which run
  `node server/start.js prod`, or `npm run dev`, which runs
  `node server/start.js dev` (dev is for Arjun only). The `start.js` launcher
  sets `APP_ENV` and changes into `apps/pipeline/`, so it works from any folder
  and on Windows. When `APP_ENV` is unset it defaults to `prod`.
- **Startup check.** If the provider settings are invalid, the service logs
  `Pipeline provider settings are invalid for APP_ENV=…` and exits with code 1
  before it listens. Prod without `AI_PROVIDER=vertex` is one example. No
  provider call is made during this check.
- **Working directory.** Run the CLIs from `apps/pipeline/`.
  `.local/`, `output/` and `public/buildings/` are resolved relative to the
  process working directory. The launcher sets this for the server, but
  `node server/index.js` run directly does not.
- **Origin check.** If a request has an `Origin` header that is not on the
  allow-list, it gets `403 {"error":"Only local app requests are accepted."}`.
  This applies to every route, including health. The allow-list holds the
  service's own `http://localhost:<PORT>` and `http://127.0.0.1:<PORT>`, plus
  `PIPELINE_ALLOWED_ORIGINS`, a comma-separated list that defaults to
  `http://localhost:4200,http://127.0.0.1:4200`. Requests without an `Origin`
  header, such as curl or server-to-server calls, are not checked. No CORS
  headers are sent.
- **Body limits.** JSON bodies can be up to 150 MB (`express.json`). Uploads go
  through multer in memory, up to 15 MB per file. A PDF can have at most 20
  pages.
- **Building payloads.** A "building" is a full `BuildingSchema` object, and
  every endpoint re-parses it. It embeds the plan images as base64 `dataUrl`
  assets, so request bodies are often several MB. The authoring endpoints are
  stateless: the client keeps the current building and sends it with every call.
- **Errors.** Unknown `/api/*` paths return `404 {"error":"Unknown API route"}`.
  Every other failure goes through one error handler that returns **400** with
  `{"error": string}`:
  - Zod failures read `Invalid project schema: <path> <message>; …`, with the
    first three issues listed.
  - A multer "File too large" error reads `Image exceeds 15 MB.` (the wording
    is the same for PDFs).
  - Anything else returns the thrown message as it is. That includes internal
    `TypeError` text and `ENOENT` paths.

  The only routes with their own status codes are the explicit 404s noted
  below and the `202` returned when a job starts.
- **Paid or local.** "Paid" means the route calls the configured AI provider
  (`AI_PROVIDER`). Every other route runs only local code.

## Building and Floor shapes (summary)

These come from `shared/building/schema.js`.

`Building`:

- `version: 2`
- `id`
- `name`
- `provenance`
- `assets: {[id]: {id, name, mime, dataUrl, hash, provenance}}`
- `floors: Floor[]`
- `nodes[]` and `edges[]`, the routing graph
- `connectors[]`, for stairs and elevators
- `photos[]`
- `routing: {stairsPenalty, elevatorPenalty, uncalibratedFloorCost}`
- `updatedAt`

`Floor`:

- `id`, `label`, `level`, `width`, `height`
- `sources[]`: the plan pages. Each has an `assetId`, `originalAssetId`,
  `transform`, `alignment` and optional `coverage`.
- `geometry`: a `MapSchema` with `spaces`, `walls`, `doors`, `pois`, `graph`
  and `review`.
- `presentation`
- `access: {version, records[]}`: the doorway evidence.
- `revision`
- `geometryStatus`: `draft`, `reviewed` or `stale`.
- `reviewer` and `reviewNotes`
- `graphRevision`
- `history[]` and `snapshots[]`

## Health

### `GET /api/health` (local)

Returns `{ok: true, environment, provider, configured, model, effort?}`. The
provider is constructed but never called, and keys are never echoed.
`configured` only means a key is present. If `createProvider()` throws, the
route returns 400 with that message. In practice this is rare, because invalid
settings already stop the service at startup.

## Authoring (used by SnapWay's Angular app)

These are all `POST` routes under `/api/authoring`. Each takes a JSON body
`{building, floorId?, …}`, except `plans`, which is multipart. None of them call
the provider, and none of them write files. Every geometry or access change runs
through `applyAccessDecisions`.

### `POST /api/authoring/plans` (local)

Turns an uploaded plan into a new building, with one draft floor per page.

- **Request:** multipart.
  - `plan` (required): a PDF, PNG or JPEG file. Any other file field name
    returns `Unexpected file field`.
  - `name` (optional): the building name. It defaults to the file name without
    its extension and is cut to 200 characters.
  - `floorLabel` (optional): used only when the plan has exactly one page.
- **Response:** `{building, summary}`.
  - `building.id` is `plan-<first 16 hex chars of the file hash>`, so uploading
    the same file again gives the same id.
  - The floors are `floor-1 … floor-N`, labelled `Floor <n>`, with `level`
    equal to the page number.
  - Each floor is created with `geometryStatus: "draft"`, one source with
    `alignment: "reviewed"`, and empty geometry.
  - `summary` has the `summary` shape described below.
- **Errors:**
  - No file: `Choose a PDF, PNG or JPEG floor plan.`
  - Wrong type: `Choose a PDF, PNG, or JPEG.`
  - More than 20 pages: `Import up to 20 PDF pages at a time.`
  - A file over 15 MB is rejected.

### `POST /api/authoring/clean-plans` (local, paid)

Redraws each floor with the image model before mapping. See
[clean-plans.md](clean-plans.md).

- **Request:** multipart `plan` (file), `mode` (`floor` or `building`),
  `floors` (required for `building`, 2–20), optional `labels`
  (comma-separated, one per floor, bottom to top) and `name`.
- **Response:** `202 {id}`. Poll `GET /api/authoring/clean-plans/:id` for
  `{id, status: running|complete|failed|cancelled, progress, result?, error?}`.
  `result` is `{building, summary, elapsedMs, imageModel, usage, floors[]}` with
  per-floor `originalPreview` and `cleanPreview` JPEG data URLs.
  `POST /api/authoring/clean-plans/:id/cancel` stops it. One job at a time.
- **Errors:** missing plan type, missing floor count, a label count that does
  not match the floor count, or a multi-page PDF for a floor plan.

### `POST /api/authoring/summary` (local)

- **Request:** `{building}`.
- **Response:**
  `{id, name, floors: FloorSummary[], validationErrors: number}`.
  `validationErrors` counts the issues with severity `error`.

A `FloorSummary` contains these fields:

| Field | Contents |
| --- | --- |
| `floorId`, `label`, `level`, `geometryStatus`, `regions` | `regions` is the number of geometry spaces |
| `rooms[]` | `{id, label, kind, ready, reason, doors}`: routable destinations and whether each is ready |
| `spaces[]` | `{id, label, kind, doors}`: every walkable space, sorted by label in natural order |
| `needsAttention[]` | `{spaceId, label, kind, status, reason}`: the access queue |
| `assumed[]` | `{doorId, roomId, roomLabel, roomDoors, edgeKey, t, width, segment:{a,b}, candidates[]}` |
| `counts` | `{verified, assumed, ready, destinations}` |

Each edge candidate is
`{key, adjacentId, adjacentLabel, adjacentKind, hallway, length, doors, a, b}`.
`a` and `b` are the shared edge's endpoints, as `{x, y}` in floor coordinates.

`key` is a number: the candidate's index in a list sorted so that hallway edges
come first and longer edges come before shorter ones. It is recomputed from the
geometry on every call, so always take it from the latest response.

### `POST /api/authoring/render` (local)

- **Request:** `{building, floorId, overlay?: {segments?: [{a:{x,y}, b:{x,y}, color?}], routes?: [[{x,y}, …]]}}`.
- **Response:** `{svg: string}`. This is the designed floor SVG. When an
  overlay is given, the SVG also contains a
  `<g data-overlay="true">` with route polylines (blue) and segment lines
  (`#c2185b` unless `color` is set).
- **Errors:**
  - An unknown floor returns `Choose an existing floor.`
  - Any overlay coordinate that is not a finite number returns
    `400 Overlay coordinates must be numbers.` Only finite numbers reach the
    SVG.

### `POST /api/authoring/routes` (local)

- **Request:** `{building, from: roomId, to: roomId}`.
- **Response:** one of the following:
  - `{route: {steps, cost, units, floorIds, floors: [{floorId, segments}]}}`.
    `segments` is an array of polylines, and each polyline is an array of
    `{x, y}` points. These are the simplified `displayPoints` from
    `routeDisplaySegments`, which can be passed straight to `render` as
    `overlay.routes`. `steps` is a count.
  - `{route: null, message: "No connected route between these rooms yet."}`,
    when both rooms exist but are not connected.
- **Errors:** `400 Unknown room <id>.` when `from` or `to` is not the id of a
  space on any floor.
- The display segments are for drawing only. Pathfinding is unchanged.

### Doorway tools: `POST /api/authoring/doorways/*` (local)

Every doorway route takes `{building, floorId, …}` plus an optional `reviewer`
string. Unless noted otherwise, each responds with `{building, summary, …extra}`,
where `building` is the updated copy. The client should replace its copy with
it.

| Path | Extra request fields | Extra response fields | What it does |
| --- | --- | --- | --- |
| `place` | `floorId?`, `spaceIds?` | `results: [{floorId, placed[], skipped[], roomed[], enabled[], bridged[]}]` | Places assumed doorways for rooms that have no usable door. Without `floorId`, it runs on every floor whose `geometryStatus` is `reviewed`. In order, it: <br>1. treats unclear regions as rooms (`roomed`) <br>2. re-enables doors the source already supports (`enabled`) <br>3. places a door at the middle of each shared hallway edge (`placed`: `{spaceId, label, doorId, opensOnto, viaRoom}`) <br>4. bridges disconnected areas (`bridged`) <br>Rooms it cannot place a door for are listed in `skipped: {spaceId, label, reason}`. |
| `define-room` | `spaceId` | `placed`, `skipped` | Classifies the space as a room and immediately places an assumed door for it. |
| `not-room` | `spaceId` | (none) | Makes the space non-walkable and rejects every door into it. |
| `edges` | `spaceId` | Returns **only** `{edges: [candidate…]}` | Lists the shared edges available for a new door, with the number of doors already on each edge. |
| `add` | `spaceId`, `edgeKey?` | `doorId`, `opensOnto` | Adds another assumed door. When `edgeKey` is given, the door goes on that edge (take the key from `edges`). Otherwise the best edge is chosen. Door ids follow the pattern `<spaceId>:assumed-door[-n]`. |
| `edit` | `doorId`, `edgeKey`, `t` (0–1 along the edge), `width`, `confirm?` | (none) | Moves or resizes an assumed door. Take `edgeKey` from `summary…assumed[].candidates`, which are computed without the door being edited. Setting `confirm: true` records the door as a manual, human-reviewed opening. This requires a non-empty `reviewer`. |
| `remove` | `doorId` | (none) | Rejects an assumed door. |

Errors from these routes:

- `Unknown region.`
- `Unknown floor.` (from `place`)
- `That is not an assumed doorway.` (from `edit` and `remove`)
- `Enter your name to confirm this doorway.`
- `Pick the space this doorway opens onto.` (`edit` with a bad `edgeKey`)
- `No free spot …` and `… shares no edge with a walkable space.` (from `add`)
- `<label> is not a room; use Make it a room first.`

Review status:

- `define-room` and `not-room` are recorded as `human-reviewed` only when a
  non-empty `reviewer` is given. Without one, the reviewer is
  `Unnamed editor action` and the status is `agent-inspected`.
- Confirmed edits always require a name and are recorded as `human-reviewed`.
- Assumed placement, moves and removals are recorded as `agent-inspected`.

## Angular end-to-end sequence

1. **Upload.** `POST /api/authoring/plans`, multipart `plan`, optional `name`
   and `floorLabel`. The response is `{building, summary}`. Keep `building`.
2. **Start a mapping job (paid).** `POST /api/map-jobs` with
   `{building, options: {floorIds: ["floor-1"]}}`. The response is
   `202 {id}`, where `id` is a UUID.
3. **Poll.** `GET /api/map-jobs/:id` until `status` is no longer `running`.
   The terminal statuses are `complete`, `needs-review`, `limited`,
   `cancelled` and `failed`. `interrupted` means the server restarted, and the
   job can be resumed. While the job runs, show `progress.stage`,
   `progress.message` and `progress.stats.calls`.
4. **Apply.** `POST /api/map-jobs/:id/apply` with `{building}`, the
   building from step 1. The response is `{building}`, now with mapped
   geometry. This step needs at least one proposal with `appliedPreview: true`.
5. **Place doorways.** `POST /api/authoring/doorways/place` with `{building}`,
   or with `{building, floorId}`. The response is
   `{building, summary, results}`. Rooms in `skipped` need
   `define-room`, `not-room` or `add`.
6. **Show the result.** Call `POST /api/authoring/summary` for the lists and
   `POST /api/authoring/render` with `{building, floorId}` for the SVG. Then
   iterate with the doorway tools and `routes`.

Saving the result is a separate step. See
[Building library](#building-library) (`POST /api/buildings/copies`).

### Dev proxy

In the Angular dev server (`ng serve --proxy-config proxy.conf.json`, on
`127.0.0.1:4200`), the browser calls `/pipeline/api/...`. The proxy rewrites
those calls to the service's `/api/...`. The mapping is configured in
`apps/web/proxy.conf.json`:

```json
"/pipeline/**": {
  "target": "http://127.0.0.1:5175",
  "secure": false,
  "pathRewrite": { "^/pipeline": "" }
}
```

The `/api/**`, `/admin/**` and `/accounts/**` entries in that file still go to
Django on port 8000.

The proxy forwards the browser's `Origin` header (`http://127.0.0.1:4200` or
`http://localhost:4200`), and both values are on the default allow-list. If the
service runs on a different `PORT`, update `target` to match.

## Mapping jobs

A mapping job is durable. Its state is kept in
`.local/map-jobs/<id>/{input,state}.json`. Only one job can run at a time
across the process. For the stages, see [stages.md](stages.md), and for budgets
and resumption, see [operations.md](operations.md).

| Method and path | Paid | Request | Response |
| --- | --- | --- | --- |
| `POST /api/map-jobs` | **yes** | `{building, options}` | `202 {id}` |
| `GET /api/map-jobs/:id` | no | (none) | The job state (below) |
| `POST /api/map-jobs/:id/resume` | **yes** | `{options?}`, merged over the stored options. The body may be omitted. | `202 {id}` (the same id) |
| `POST /api/map-jobs/:id/cancel` | no | (none) | `{cancelled: true}`, or `{cancelled: false, status}` if the job is not active |
| `POST /api/map-jobs/:id/apply` | no | `{building}` | `{building}` |

`options` (`SmartOptions`):

| Option | Range | Default |
| --- | --- | --- |
| `floorIds` (required) | 1–20 floor ids | (none) |
| `rebuild` | boolean | `false` |
| `concurrency` | 1–3 | 2 |
| `maxCalls` | 1–100 | 40 |
| `maxTokens` | 1,000–2,000,000 | 500,000 |
| `deadlineMs` | 1,000–3,600,000 | 1,200,000 |
| `maxDetailTiles` | 1–30 | 8 |
| `maxSemanticBatches` | 0–10 | 4 |
| `maxRepairTiles` | 0–10 | 2 |
| `maxDoorBatches` | 0–50 | 50 |
| `maxAccessRegions` | 0–100 | 8 |

The job state has these fields:

- `id`, `status` and `options`.
- `progress: {stage, message, stats: {calls, tokens, cacheHits, localMs}}`.
  The stages, in order, are `queued`, `local`, `preserve`, `inventory`,
  `extract`, `repair`, `semantics`, `doors`, `graph`, `api` and `finished`.
- `startedAt` and, once the job ends, `finishedAt`.
- `error`, when the job failed or was cancelled.
- `result`, once the job finishes.

`result` has these fields:

- `version`, `provider`, `model`, `effort` and `stats`.
- `status`.
- `proposals[]`. Each proposal has `floorId`, `sourceId`, `signature`, `mode`
  (`source` or `access`), `map`, `coverage`, `records`, `queue[]`,
  `appliedPreview` and `transactions?`.
- `queue[]`: review items `{floorId, sourceId, reason, type?, spaceId?, doorId?, label?}`.
- `summary: {regions, ready, destinations, reviewItems, elapsedMs, validationErrors}`.

Notes:

- **Starting a job** returns 400 when the input is invalid and
  `A mapping job is already running. Cancel it or wait for completion.` when
  another job is active. The job itself fails when the provider cannot return
  structured responses. That is the case for the plain `gemini` adapter, which
  fails with `The configured provider must support structured vision and doorway tools.`
- **Polling:** an id that is not a UUID returns `400 Invalid job ID.` An id
  with no job returns `404 Mapping job not found.`
- **Apply** re-checks each proposal's source signature against the `building`
  you send. If they differ, it fails with
  `The source or geometry changed after this run. Start a new run before applying.`
  Two other errors: `Wait for a completed pipeline result.` and
  `No checked proposal is ready. Resolve the review queue first.`
  Changes are applied as `agent-inspected` with the reviewer
  `Hybrid API pipeline`. Nothing is saved.
- **Missing jobs:** `GET`, `resume`, `cancel` and `apply` all return
  `404 Mapping job not found.` for a valid UUID that has no job.

## Building library

`server/building-library.js` collects every building on the machine:

| Source | Location | Library key |
| --- | --- | --- |
| Published library | `public/buildings/*.json` | `<basename>` |
| Saved project | `.local/building.json` | `editor-save` |
| Saved copies | `.local/buildings/*.json` | `copy-<basename>` |
| Pipeline exports | `output/<dir>/building.json` | `export-<dir>` |

A file that is invalid or cannot be read is skipped with a server warning.
Parsed buildings are cached by file mtime and size.

| Method and path | Paid | Request | Response |
| --- | --- | --- | --- |
| `GET /api/buildings` | no | (none) | `{buildings: [{key, source, sourceLabel, file, id, name, provenance, updatedAt, floors:[{id,label,level}], photos, testPhotos, rooms, regions, reviewedFloors, sizeBytes, modifiedAt}]}` |
| `GET /api/buildings/:key` | no | (none) | The full building, or `404 Unknown building.` |
| `POST /api/buildings/copies` | no (writes a file) | The building itself as the body (not wrapped) | `{key, file, updated}`. Saving the same `building.id` again overwrites its copy. A schema failure returns `400 That building does not pass the schema; fix validation errors first.` |

## Access and doorway investigation

| Method and path | Paid | Request | Response |
| --- | --- | --- | --- |
| `POST /api/access/crop` | no | `{floor, assets, spaceId?, segments?: [{a,b}] (≤12), scale?: "detail" or "context"}` | `{dataUrl, metadata}`: a PNG re-rendered from the original source, with the region outline and segments drawn on top |
| `POST /api/access/investigate` | **yes** | `{building, floorId, spaceIds: string[1..40]}` | `202 {id}` |
| `GET /api/access/:id` | no | (none) | `{id, status, provider, model, progress:{completed,total,message}, result?, error?}`. `result` is `{floorId, provider, model, results[]}`. |
| `POST /api/access/:id/cancel` | no | (none) | `{cancelled: true}` |

Error messages from these routes:

- `crop`: `Unknown region.` or `Choose a region or opening to inspect.`
- `investigate`: `Unknown floor.`, `Unknown region <id>.` or
  `Configure the server image provider before investigating doorways.`
- `GET /api/access/:id` and `POST /api/access/:id/cancel`: 404 for an unknown
  id.

Investigation jobs are held **in memory only** and are lost on restart. Their
per-region results are cached in `.local/access/`. The results are proposals
and are not applied automatically.

## Design

| Method and path | Paid | Request | Response |
| --- | --- | --- | --- |
| `POST /api/design/render` | no | `{building, floorId, presentation?}` | `{dataUrl, width, height}`: a PNG at most 1800 px on its longest side. If `presentation` is omitted, the floor's own presentation is used. |
| `POST /api/design/suggest` | **yes** | `{building, floorId, prompt}`, where `prompt` is 3–2000 characters | `{presentation, calls, provider, model, preview: {dataUrl, width, height}}` |

`suggest` fails with
`Configure the server image provider before using AI design.` when the provider
is not configured.

## Legacy and editor endpoints

These come from the original single-image editor. The Angular authoring flow
does not use them, and they are kept only for compatibility. `/api/project` uses
the older single-map `MapSchema`, not `BuildingSchema`.

| Method and path | Paid | Request | Response and notes |
| --- | --- | --- | --- |
| `POST /api/normalize` | no | multipart `image`, PNG or JPEG | `{name, width, height, originalWidth, originalHeight, dataUrl, normalized, provenance, fictional}`. Applies EXIF rotation and resizes to at most 2400 px. |
| `POST /api/plans` | no | multipart `image`, PDF, PNG or JPEG | `{assets, sources}` (the raw `preparePlan` output). Note the field name `image`, not `plan`. |
| `POST /api/extract` | **yes** | `{source}`, where `dataUrl` must be a normalized PNG | The extracted map. Writes `.local/extractions/<id>.json`. |
| `POST /api/extraction` | **yes** | `{source}` | `{map, cacheKey, cached, imageHash}` |
| `POST /api/coverage` | **yes** | `{source, baseMap?}` | `202 {id}`. Coverage jobs are in memory only. |
| `GET /api/coverage/:id` | no | (none) | `{id, status, progress, result?, error?}`, or 404 |
| `GET` and `PUT /api/project` | no | A `MapSchema` body | Read and write `.local/project.json`. `GET` returns 404 until something is saved. |
| `GET` and `PUT /api/building` | no | A `Building` body | Read and write `.local/building.json` and `.local/building-validation.json`. Before writing, `PUT` backs up `.local/building.json`, and `public/buildings/waterloo-e2.json` if it exists, into `output/backups/`. `GET` returns 404 until something is saved. |

## Command-line tools

Run these from `apps/pipeline/`. They read the same `.env.<APP_ENV>` and `.env`
files as the server. `APP_ENV` defaults to `prod` (Vertex AI). Set `APP_ENV=dev`
only for Arjun's Claude setup. All three call the provider, so they
are **paid**. Responses are cached under
`.local/`, and repeat runs reuse the cache.

### `build-from-plan.js` (paid)

```sh
node server/build-from-plan.js <plan.pdf|png|jpg> <output-dir> \
  [--name=Building] [--floor=1] [--floor-label="Floor 1"] \
  [--max-calls=40] [--no-assumed-doors]
# or: npm run build-plan -- <plan> <output-dir> [flags]
```

Flags must use the `--flag=value` form.

- `--floor` sets the level and the floor id `floor-<n>`.
- `--max-calls` is the `maxCalls` budget. The job runs with `rebuild: true`.
- The plan must have exactly one page. For a multi-page plan, assign the pages
  to floors first.
- Ctrl-C (SIGINT) cancels the run.

The tool writes these files to `<output-dir>`:

- `input-building.json`
- `pipeline-result.json`
- `building.unchecked.json`
- `building.json`
- `validation.json`
- `assumed-doors.json`
- `map.svg`
- `map.png` (at most 2000 px)
- `map-package.zip`

It also prints a JSON line with `{status, stats, summary, output}`. When no
floor has any geometry, it keeps only the proposal and exits with code `2`.
If `<output-dir>` is `output/<name>`, the result appears in the library as
`export-<name>`.

### `run-smart-map.js` (paid)

```sh
node server/run-smart-map.js <building.json> <report.json> [floorId…] [--rebuild]
```

If no floor ids are given, the tool runs every floor that has sources. It uses
the default `SmartOptions`. The full result is written to `<report.json>`, and
`{status, summary, stats}` is printed. The building file is not modified.

### `run-access-agent.js` (paid)

```sh
node server/run-access-agent.js <building.json> <floorId> <spaceId…> [--merge]
```

The tool runs the doorway investigation agent and prints each region's records,
validation and tool transcript. The full job is written to
`output/access-agent/<floorId>-<timestamp>.json`. With `--merge`, new records
are appended to the floor in `.local/building.json`, which must already exist,
and the result is also written to `public/buildings/waterloo-e2.json`. See the
notes below. The records stay proposals.

## Notes and known gaps

- **Tests.** `tests/authoring.test.js` covers the authoring routes over HTTP:
  upload, summary, the place/edit/remove doorway tools, render overlays, routes
  and bad input. `tests/server.test.js` covers `normalize`, `project`, the
  origin check and map-job errors. The doorway helpers are also tested directly
  in `tests/assumed-doors.test.js`.
- **Most errors are 400.** Apart from the explicit 404s and 403, every failure
  returns 400 with the thrown message, including internal errors. For example,
  `/api/authoring/doorways/edges` with an unknown `floorId` returns a raw
  `TypeError` message rather than `Unknown floor.`
- **Requests without an `Origin` header are accepted.** The origin check only
  blocks browsers on other origins. There is no authentication, so keep the
  service on loopback.
- **Legacy Waterloo paths.** `run-access-agent.js --merge` and
  `PUT /api/building` still refer to
  `public/buildings/waterloo-e2.json` from the earlier project. `--merge`
  creates that file if it is missing.
