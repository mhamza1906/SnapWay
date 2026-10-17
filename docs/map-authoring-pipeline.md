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

## Verification (local, no paid calls)

| Check | Result |
|---|---|
| `apps/pipeline`: `npm test` | 142 passed, 18 skipped (Waterloo fixture absent) |
| `apps/web`: `npm run format:check`, `npm test`, `npm run build` | All pass, including the new authoring spec |
| `scripts/ci_changes.py` | ruff check and format pass; classifies `apps/pipeline/` changes and leaves docs-only changes alone |
| Browser, with `/authoring` through the dev proxy | Open the 003E3 building, render the map, preview a route (15 steps), move an assumed door with a live preview, no horizontal overflow at 280 px |

Not verified:

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
