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
  - **Everyone uses `.env.prod`** (`npm run prod`): Claude Sonnet 5.5 at high effort for planning and mapping. Set `AI_PROVIDER=vertex` to map with Gemini (`gemini-4-argon`) instead.
  - `.env.dev` remains Arjun's personal development file.
  - `APP_ENV` defaults to `prod`. Prod accepts only `anthropic` or `vertex`, never falls back automatically, and fails at startup if misconfigured.
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
