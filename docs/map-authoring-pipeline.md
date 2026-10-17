# Map-authoring pipeline (feature record)

Branch: `feature/map-authoring-pipeline` · Owner: Arjun (map-authoring AI/MCP) ·
Status: integrated as a local service with an Angular screen; not deployed.

## What this adds

- **`apps/pipeline/`**: a private Node service that turns a floor-plan PDF/PNG/JPEG
  into rooms, doorways and walking paths. It uses a vision model for reading the plan
  and local geometry for everything else, and was moved here from Arjun's Hack the
  Valley project.
- **Map authoring (AI)** screen in the Angular workspace (`/authoring`):
  - upload a plan
  - build the map with AI
  - review "needs attention" regions (Make it a room / Not a room)
  - add, move, confirm or remove assumed doorways (several per room and per edge allowed)
  - preview a route
  - save a copy
- **Providers:**
  - **Everyone uses `.env.prod`**: Gemini on Vertex AI (`npm run prod`).
  - **Only Arjun uses `.env.dev`**: Claude via the Anthropic API (`npm run dev`).
  - `APP_ENV` defaults to `prod`. Prod refuses any provider except Vertex and fails at startup if misconfigured.
- **Docs:** [docs/pipeline/](pipeline/README.md) covers the overview, [environments](pipeline/environments.md), [stages](pipeline/stages.md), the [HTTP API and CLI](pipeline/api.md), and [operations, costs and trial results](pipeline/operations.md).

## Architecture note (approval)

SnapWay's [architecture plan](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md) puts AI map-authoring in Django jobs (Celery) with Python adapters in `packages/vision` and `packages/geometry`. This change is an approved interim step by the requesting lead (Arjun):

- **Separate service:** the existing Node pipeline runs on its own, on loopback only.
- **Browser access:** the Angular dev proxy reaches it at `/pipeline/**`.
- **Keys:** stay server-side.

Two other points depart from the plan:

- **Vertex AI:** production uses Gemini on Vertex AI, not the Gemini Developer API key the plan describes.
- **Claude:** used only by Arjun in development.

Moving the calls behind Django `Job`/`JobAttempt` records, or porting to Python, is follow-up work. No Django models, migrations or Python dependencies changed.

## Changed files

| Area | Files |
|---|---|
| Pipeline service | `apps/pipeline/server/` (incl. new `authoring-routes.js`, `start.js`), `apps/pipeline/shared/`, `apps/pipeline/package.json`, `package-lock.json`, `.gitignore`, `.env*.example` |
| Pipeline tests | `apps/pipeline/tests/` (incl. new `authoring.test.js`, `fixtures/optional.js`); large Waterloo fixture not committed, its tests skip |
| Angular | `apps/web/src/app/features/authoring/` (page, service, spec), `app.routes.ts`, `app.ts` (nav link), `proxy.conf.json` (`/pipeline/**` → `127.0.0.1:5175`) |
| CI | `scripts/ci_changes.py` (new `pipeline` output), `.github/workflows/ci.yml` (new `pipeline` job: `npm ci` + `npm test`, offline) |
| Docs | `docs/pipeline/*.md`, this file, `README.md` (pointer) |

## Original feature verification (local, no paid calls)

| Check | Result |
|---|---|
| `apps/pipeline`: `npm test` | 142 passed, 18 skipped (Waterloo fixture absent) |
| `apps/web`: `npm run format:check`, `npm test`, `npm run build` | All pass, including the new authoring spec |
| `scripts/ci_changes.py` | ruff check and format pass; classifies `apps/pipeline/` changes and leaves docs-only changes alone |
| Browser, with `/authoring` through the dev proxy | Open the 003E3 building, render the map, preview a route (15 steps), move an assumed door with a live preview, no horizontal overflow at 280 px |

Not verified in the original feature handoff (see later acceptance results below):

- **Vertex Gemini:** no live mapping run on this pipeline yet. Its quality and cost are unmeasured.
- **Node versions:** local runs used Node 23; CI pins Node 24.
- **Python suite:** `python scripts/dev.py check` (the full Python suite) was not run because no Python files besides the CI classifier changed.

## Commits

- `9ce073e` feat(pipeline): integrate map-authoring AI pipeline with Angular authoring screen

## Local acceptance setup — October 17, 2026

- Local branch: `acceptance/map-authoring-pipeline`, created from
  `origin/feature/map-authoring-pipeline` at `b2939be`; latest local `main`
  (`71f24ab`, equal to `origin/main`) was merged **into this acceptance branch**
  without conflicts in `b83e87c`. Main was not modified by the merge. The
  acceptance branch has not been pushed.
- Prepared ignored `apps/pipeline/.env.prod` from the existing
  [.env.prod.example](../apps/pipeline/.env.prod.example), preserving provider,
  model, location and effort defaults; `VERTEX_API_KEY` and `VERTEX_PROJECT`
  are blank for the requester to fill. This follows the explicitly requested
  pipeline path; Django continues to use `local/env/api.env`. No loader,
  dependency declaration or API contract was changed.
- Installed the existing pipeline lockfile with `npm ci --no-audit --no-fund`.
  On Node 24, pipeline tests: **142 passed / 18 skipped** (missing Waterloo
  fixture); Angular tests: **59 passed across 11 files**. These are offline tests,
  not evidence that the configured Vertex model/key works in a real project.
- Started `npm run prod`'s launcher and checked local `/api/health`:
  `environment=prod`, `provider=Vertex AI`, `configured=false`. The temporary
  service was stopped afterward; no real provider requests were made.
- Next: fill both values locally, run `npm run prod` from `apps/pipeline`,
  confirm health, then manually validate `/authoring` per the
  [pipeline guide](pipeline/README.md). A populated-key health result only checks
  local settings; a real job is still needed to verify provider access.

The [main smoke-check record](main-workflow-smoke-check.md) remains tied to its
original main SHA; it does not describe the newly added Node service as missing
from this acceptance branch. Manual review, revised audit structure and the final
gap document remain pending. Detailed contributor history is in `local/ACTIONS.md`.

### Credential boundaries and workflow clarification

The requester supplied additional database/R2 configuration names. Their private
location is `local/env/api.env`; missing names were added there as blank entries
without replacing existing settings. `DATABASE_URL` is consumed by Django
[development settings](../apps/api/config/settings/development.py). `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_NAME` are currently
[template placeholders](../.env.example), with no configured R2 storage backend or
runtime consumer. Filling them does not enable cloud uploads. See
[Cloudflare's credential documentation](https://developers.cloudflare.com/r2/api/tokens/).
The Node pipeline still uses its own `.env.prod` and local files
([jobs](../apps/pipeline/server/map-jobs.js),
[saved copies](../apps/pipeline/server/building-library.js)); it does not use the
Django database or R2. No shared database connection, migration or cloud-storage
operation was performed in this clarification.

The original [required raster stage](initial/Indoor_Navigation_AI_and_Maps_Integration_EN.md#5-required-gpt-image-raster-adapter-and-conditional-opus-backup)
specifies GPT Image raster editing/generation before Gemini vector modeling.
Current [orchestration](../apps/pipeline/server/pipelines/smart-map.js) instead
reads the original PDF/image directly: deterministic normalization and PDF vector
hints, Vertex Gemini inventory/detail extraction, coverage reconciliation,
semantic/opening checks, local geometry/graph validation, then editable results
and human review. The Angular [AI build action](../apps/web/src/app/features/authoring/authoring.ts)
also places explicitly assumed doorways after applying the checked proposal.
SVGs and raster previews are rendered locally; there is no GPT Image call or
automated Opus backup in this path. The configured default model ID remains
`gemini-4-argon`; access was subsequently verified in the live IA-1 run below.
Offline tests do not satisfy
the original raster-generation acceptance requirement. This is a recorded
implementation difference, not approval to remove that requirement; no provider,
API, dependency or architecture changes were made.

### Real IA-1 photo acceptance — October 17, 2026

Requester authorized a live Vertex run against ignored
`local/test-source/IA-1-floor-original.jpg` (2048 × 1536 JPEG). Baseline:
`3edd14e` on `acceptance/map-authoring-pipeline`. The original SHA-256 matched
the preserved source asset. No source edits, manually invented rooms or user
identities were introduced.

- Used the existing HTTP flow: `POST /api/authoring/plans`, save an input copy,
  `POST /api/map-jobs`, poll the durable state, then apply checked proposals and
  place assumed doorways only if the checked apply gate succeeds.
- Job: `34dc6f6c-2021-454c-af02-dee9fad417d2`; provider: Vertex AI,
  configured model: `gemini-4-argon`, effort: high. Default limits remain
  40 calls, 500,000 reported tokens (soft) and 20 minutes.
- Evidence directory: `local/test-results/IA-1-2026-10-17T07-33-21-079Z/`.
  Provider response caches, durable job data and saved building copies remain
  ignored under `apps/pipeline/.local/`. No Django database, R2 or OAuth is used
  by this flow. The real credential reached a successful inventory response.
- Initial observation: inventory detects two plan footprints and explicitly
  identifies the cropped lower plan, while upload creates only one floor.
  Floor separation therefore needs manual checking before accepting any route.
- **Outcome: not accepted for this real fixture.** One cold run finished as
  `needs-review` after 469.836 seconds: 9 provider attempts, 98,224 reported
  tokens, zero cache hits. No billing amount was inferred from token totals.
- Retained proposal: **24 regions / 8 doors**; accepted mapped regions and
  usable destinations: **0**. Semantic checking retained 8 classifications,
  then a Vertex response hit `MAX_TOKENS`; no opening-verification records
  were produced. Applying the job was actually tested and returned HTTP 400:
  `No checked proposal is ready. Resolve the review queue first.`
- Visual overlay fails: extraction is concentrated on the photo's left side;
  Brainstorm and The Cave have no matching proposal region; Dark Matter and
  Muffler appear at visibly incorrect locations. Coordinate-frame mismatch
  (potential normalized-coordinate/pixel mixing) is a hypothesis requiring a
  separate test, not a confirmed fix. No image/model output was manually repaired.
- Coverage retains 17 unmapped entries out of 28, 6 overlap diagnostics and
  4 doorway-boundary diagnostics. The entries include generated aliases and
  are not a ground-truth recall score. The top-level queue has only one failure
  because semantics aborted before later review queues were populated; one
  reported item must not be presented as one remaining defect.
- Input copy is saved in the pipeline catalog; raw results/state/caches and
  `overlay.svg`, `overlay.png`, `inspection.json`, `apply-rejection.json`,
  `index.html`, `review.png` and a detailed `README.md` are in the evidence
  directory. The overlay is an inspection artifact of an **unaccepted proposal**,
  not a published map. There is no mapped `building.json` or portable accepted
  package for this run. The input copy was reopened through Angular `/authoring`.
- Local review page: `http://127.0.0.1:5176/` while its loopback-only static
  server runs. Application/proxy were restarted to load the branch's pipeline
  proxy. This run did not verify the absent GPT Image stage or human publication.

Browser cleanup remains incomplete: 18 earlier Figma-capture tabs belong to an
older browser session and could not be claimed. The browser security policy also
blocked opening Chrome's internal memory-management page (HTTP/HTTPS only); no
workaround or unrelated tab closure was attempted. This turn keeps only its
application and acceptance-report tabs as deliverables.
