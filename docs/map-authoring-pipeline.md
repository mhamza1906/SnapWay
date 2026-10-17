# Map-authoring pipeline (feature record)

Branch: `feature/map-authoring-pipeline` · Owner: Arjun (map-authoring AI/MCP) ·
Status: local service with an Angular screen; not deployed. IA-1 real-fixture
acceptance **failed** on October 17, 2026. See the
[phase audit, model/pipeline gaps and committed screenshots](audits/2026-10-17-map-authoring-pipeline.md).

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
| Docs | [Pipeline guide](pipeline/README.md), this file, [audit index](audits/README.md), [phase audit and evidence](audits/2026-10-17-map-authoring-pipeline.md), [main smoke check](main-workflow-smoke-check.md), [root README](../README.md) |

## Current verification and acceptance

| Evidence | Outcome |
| --- | --- |
| Local pipeline offline suite, Node 24 | 142 passed / 18 skipped (Waterloo fixture absent) |
| Local Angular suite | 59 passed across 11 files |
| Authorized IA-1 cold Vertex run | `needs-review`; 469.836 s, 9 attempts, 98,224 reported tokens |
| Result quality | 24 raw regions / 8 door candidates; severe displacement and missing labels; no accepted map or usable route |
| Failed-apply protection | Actual apply request returned HTTP 400; original asset/hash and local evidence preserved |

The required GPT Image raster stage, explicit Opus modeling backup and authorized
application MCP/persistence flow remain incomplete. Local SVG rendering and model
function tools do not complete those requirements. Detailed evidence, scope,
confirmed gaps, hypotheses and catalogue status are maintained once in the
[phase audit](audits/2026-10-17-map-authoring-pipeline.md), with a
[portable run summary](audits/assets/2026-10-17-ia-1/run-summary.json).

## Run and configuration boundaries

From `apps/pipeline`, install the existing lockfile with `npm ci`, fill ignored
`.env.prod` from [.env.prod.example](../apps/pipeline/.env.prod.example), then
run `npm run prod`. The team file needs `VERTEX_API_KEY` and `VERTEX_PROJECT`;
keys remain server-side. A configured `/api/health` is only a settings check,
not proof of successful model inference. See the [pipeline quick start](pipeline/README.md)
and [environment contract](pipeline/environments.md).

Start Angular separately with `python scripts/dev.py web` from the root and
open `/authoring`. Restart its dev server after a proxy configuration change.
The Node service uses local files under `apps/pipeline/.local/`; it does not use
Django accounts, PostgreSQL jobs, R2 or reviewed product publications. Django
loads private settings from `local/env/api.env`. R2 variables there are reserved
placeholders with no runtime storage adapter in this checkout.

## Branch and history checkpoints

- AI implementation: `9ce073e`; teammate feature tip: `b2939be`.
- Main `71f24ab` was merged into `acceptance/map-authoring-pipeline` in `b83e87c`;
  main was not the merge target. This is the review/audit branch; no PR or merge
  is requested for the phase closeout.
- Live-tested code: `3edd14e`; first recorded acceptance: `7f40b9c`.
- The [main smoke check](main-workflow-smoke-check.md) retains its original main
  baseline; its observations do not describe the AI branch as empty.
- Full private run files remain in
  `local/test-results/IA-1-2026-10-17T07-33-21-079Z/`; the audit's committed
  screenshots and selected JSON can be reviewed without those private files.
  Contributor development history remains in the single ignored `local/ACTIONS.md`.

## Proposed next iteration

The [web artifact review](audits/2026-10-17-chatgpt-web-floorplan.md) independently
checks both supplied SVG/HTML versions and records a second-version regression:
all hotspots/labels were inserted into the Logo SVG. The
[redesign proposal](pipeline/redesign-proposal.md) specifies GPT Image 2.5 raster
generation, bounded example schemas, coordinate/review gates and staged
cost experiments. Evidence and examples are linked there; this is a proposal,
not a completed pipeline or an application API change.

The [Gemini-only pilot](audits/2026-10-17-gemini-vector-pilot.md) now exercises the
frozen-raster vector stage with four real requests and a replayable
[isolated experiment harness](../apps/pipeline/experiments/README.md). It produces
a useful partial map but fails full geometry/navigation acceptance; the member
deferred GPT image API and fallback-model testing. Application APIs remain unchanged.

The member has now [closed this stage and confirmed the next comparison priorities](audits/2026-10-17-gemini-vector-pilot.md#member-reviewed-stage-conclusion):
whole-image Gemini 4 vectorization is unsatisfactory; segmentation shows local
improvement but needs more evidence. GPT 6.1 sol and Opus 5.5 are priority
vectorization candidates, with Gemini retained as a matched baseline; future
selection must compare accepted quality, total time and cost. No winning model
has been selected. Work awaits the next update; no additional tests, runtime
provider switch or API change accompanies this closeout.

Published checkpoints accompanying this conclusion: [web review and proposal
8d159aa](https://github.com/mhamza1906/SnapWay/commit/8d159aa) and
[Gemini pilot, harness and evidence 71a5a17](https://github.com/mhamza1906/SnapWay/commit/71a5a17).
