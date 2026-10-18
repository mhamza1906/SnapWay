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
  - **Team settings in `local/.env`** (`npm run prod`): Claude Sonnet 5.5 at high effort for planning and mapping; set `AI_PROVIDER=vertex` to map with Gemini on Vertex AI.
  - **Authorized local experiments use the same file plus explicit overrides** (`npm run dev`).
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
`local/.env` from the root [.env.example](../.env.example), then
run `npm run prod`. The team file needs `VERTEX_API_KEY` and `VERTEX_PROJECT`;
keys remain server-side. A configured `/api/health` is only a settings check,
not proof of successful model inference. See the [pipeline quick start](pipeline/README.md)
and [environment contract](pipeline/environments.md).

Start Angular separately with `python scripts/dev.py web` from the root and
open `/authoring`. Restart its dev server after a proxy configuration change.
The Node service uses local files under `apps/pipeline/.local/`; it does not use
Django accounts, PostgreSQL jobs, R2 or reviewed product publications. Django
loads private settings from `local/.env`. R2 variables there are reserved
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

## Original-photo GPT full-chain experiment

The subsequent [real GPT image/vector API trial](audits/2026-10-17-gpt-fullchain-pilot.md)
preserves source labels and capacities in local SQLite before one GPT Image 2.5
edit, then compares GPT 6.1 sol/Gemini 4 whole-image vectors and two GPT crops.
Image labels are removed, but exterior cleanup is incomplete; whole maps and crops
still fail geometry/navigation acceptance. The report links all changed
[experiment code and commands](../apps/pipeline/experiments/README.md), measured
usage/cost, database mapping and portable evidence. Shared DB connectivity/import
remains unresolved; application APIs and production schema are unchanged.

## Figma tracing review

The member-supplied [Figma SVG review](audits/2026-10-17-figma-vectorization.md)
finds much stronger visual fidelity to the same optimized raster than the previous
whole-map LLM outputs, but no exported room/door/route semantics. It links the
original SVG, reproducible visual analysis, comparison/detail images and a pinned
public API investigation. Dedicated tracing plus separate semantic extraction is
proposed for the next controlled trial; VTracer and a commercial API remain
untested. No runtime/API/dependency changes or additional model calls accompany
this audit; Figma latency and credits were not instrumented.

The same report's [Vector Magic follow-up](audits/2026-10-17-figma-vectorization.md)
now distinguishes desktop batch conversion from a supported current cloud API.
Current API onboarding is unverified; published Vector Magic and Vectorizer.AI
terms require clarification/authorization for downstream AI processing and the
planned comparisons. Commercial candidates remain conditional, with no purchase,
upload, software installation or supplier message made for this investigation.

The historical [personal-Figma bridge assessment](pipeline/figma-demo-bridge-proposal.md)
is superseded by the member-approved [Vectorizer.AI adapter and demo contract](pipeline/vectorizer-api-demo.md),
which links every changed implementation/configuration/test file and the import/run commands.
The additive Node routes implement disabled-by-default official API access and
an explicitly disclosed **IA-4-only mock**; its actual floor asset is pending.
The supplied IA-1 Figma SVG is stored in local SQLite for the separate navigation
demo prebuild, with exact bytes/source hashes and navigation review still pending.
No subscription, paid request, Figma relay, shared DB migration or existing API
contract change was made. Nine offline tests pass; the full pipeline suite reports
151 passes, 18 existing optional-fixture skips and zero failures.

Implementation checkpoint: [f65ac91](https://github.com/mhamza1906/SnapWay/commit/f65ac91)
(local commit; remote link becomes available when this branch is next pushed).

## Future authoring and visual navigation workflow

**Visitor photograph localization (canonical):** MegaLoc embed + global catalog match —
[localization-megaloc.md](localization-megaloc.md),
[localization-visitor-match.md](localization-visitor-match.md). No floor prompt;
Gemini is not the place matcher.

Map-authoring AI (raster/graph) remains assessed in
[navigation/AI workflow plan](pipeline/navigation-ai-workflow-plan.md): Image 2.5
optimization and developer edits; Gemini 4 semantic graph proposals; Flash-assisted
editing; four-direction capture as authoring; IA-4 mock. Visitor place match is
MegaLoc only (see links above). Continuous world-registered AR requires its own
measured acceptance.

The [Indoor Live View research note](pipeline/indoor-live-view-research.md)
separates Google disclosures from inference about its private indoor product.
Tracking/AR experiments must plug into **MegaLoc localize** as the cloud slow path
for place identity, not Gemini scene matching.

The member authorized continuous geometric tracking (plan sections 9.4–9.7): local
camera/IMU plus periodic **MegaLoc** re-localization. No sensor reading or new SDK
installation is claimed by this documentation update.

## Latest main integration and gap audit

Latest `origin/main` `2dfd1ef` was merged into this acceptance branch in `1922769`,
preserving the already committed plans. The [new categorized audit](audits/2026-10-17-main-sync-gaps.md)
credits working OAuth/membership foundations and verified Web/API deployment,
then separates environment/assets, missing features and refactoring/integration
work against the current navigation plan. It records seven CI-classifier test
failures and 89 Ruff diagnostics on this merged branch, while main's deployed CI
and the local Node/Angular suites pass. IA-4 mock asset preparation is an external
dependency; purchasing Vectorizer.AI is explicitly excluded. No product fixes,
paid calls, PR, deployment or push accompany this audit.

## Documentation language maintenance

All authored `docs/` content is maintained in English under [AGENTS.md](../AGENTS.md)
and the [development guide](development.md). The plans, research and audits linked
above were translated with API names, commands, hashes, source citations, gap IDs
and recorded outcomes preserved; the [web-artifact review](audits/2026-10-17-chatgpt-web-floorplan.md)
now explains the translated control label, and the [earlier smoke-check link](main-workflow-smoke-check.md)
points to the current setup section. Original evidence and `docs/initial/` remain
unchanged. Personal execution history stays in ignored `local/ACTIONS.md`.

The member clarified that browser Local Storage test records may be discarded,
so no legacy prototype-data migration is required. The [Node/Django responsibility
proposal](pipeline/navigation-ai-workflow-plan.md#101-nodedjango-responsibility-and-integration-proposal)
documents the remaining persistence, schema, permission, job and delivery gaps,
recommending Django-owned shared state with private Node computation through
background workers. This is an integration recommendation, not an implemented
runtime change or a request to delete source evidence/prebuilt assets.

## Selected deployment increment

The [deployment update plan](deployment-update-plan.md) selects Django as the
business/data authority with one private Node compute service and a serial
authoring worker on the current VM. It records resource budgets as unverified
rehearsal settings, persistent asset/configuration boundaries, coordinated
release/rollback and acceptance gates. The [deployment guide](deployment.md)
and [workflow delivery plan](pipeline/navigation-ai-workflow-plan.md#11-delivery-sequence-costs-and-acceptance)
link to this conclusion. No runtime/API/dependency change, service installation,
main merge, data deletion or deployment accompanies the document.

## Single environment synchronization

The [environment sync contract](environment-sync.md) consolidates Django/Node
and active experiments into ignored `local/.env`, with one root public template
and externally distributed private updates. It links all loader/tool/deployment
changes and offline verification. Release activation gains a schema/version gate;
the live controller/env still need owner synchronization before deployment.
Agents must flag changed keys and required member updates immediately under
[AGENTS.md](../AGENTS.md). No shared credentials were published or rotated.

The [subsequent remote-main alignment](environment-sync.md#subsequent-remote-main-contract-alignment)
adds the four iOS/localization settings from fetched main `7af9eae` to contract
`2026-10-17.2` without merging its consumer code. This machine's env is aligned;
team/server distribution and real engine credentials remain pending.

## Merge-readiness repairs

Main `7af9eae` was merged in `04e632e`; the
[repair report](audits/2026-10-17-merge-readiness.md) links the classifier/quality,
evidence-preserving replay, shared-engine configuration, Windows telemetry and
invalid-photo fixes, with local/remote verification kept distinct. Frontend changes
apply the required formatter and preserve behavior. The current env contract is
`2026-10-17.3` (56 keys); main deployment and real pipeline acceptance remain
separate gates.

## Photo points and the graph editor (October 18, 2026)

After merging main, the authoring screen's Photo points menu can send a hall's
photo points to main's graph editor ("Send to graph editor"). It creates a fresh
graph draft (`POST /api/maps/drafts/ensure/` with `force_new`), uploads the floor
plan rendered to PNG as the underlay (the editor's frame is the image size, so
points are converted into its pixels), adds one node per point (`checkpoint`,
or `junction` at junctions) labelled `Point N`, and links neighbouring points in
walking order (skipping jumps longer than 1.6 spacings). Photos for each node are
then added in the graph editor and stored in R2 by main's media store. It needs a
signed-in session (Google sign-in); the authoring screen is behind main's
session guard. Not yet tried end to end with a signed-in account.

## Hosted saved-project/manual authoring boundary (2026-10-18)

The web client uses `/api/maps/authoring-compute/` rather than the local-only
`/pipeline/api/` proxy. Django requires a Developer session and CSRF for POSTs.
`GET buildings/sam-ibrahim` returns the bundled six-floor project; `?download=1`
downloads `Sam_Ibrahim_Project.json`. The authoring screen also links the existing
R2 source/point PDFs and the standalone Level 1 3D scene. These links are not
conditioned on the private compute health check.

The fixed loopback Node adapter allowlists only health and stateless preparation,
summary/rendering, route, doorway, region and hall-point operations. Browser
cookies, provider credentials, arbitrary paths, other users' catalogues and Node
saved-file operations are not forwarded. Publication still uses existing Django
map permission checks. No provider call is made just to open the saved project.

Cloud paid AI jobs and shared-file Save Copy remain disabled at this interim
boundary; they require the durable authorized job/storage implementation in
[the selected deployment plan](deployment-update-plan.md). The UI reports this
limit and disables new AI builds. Download the project for a portable copy, and
send graphs through the existing authorized graph-import workflow.

Implementation: `apps/api/maps/views_authoring.py`, `maps/urls.py`,
`tests/test_authoring_compute.py`, and the authoring component/PipelineService in
`apps/web/src/app/features/authoring/`. No dependency or environment-key changes.
The private Node service must remain available on loopback port 5175 for compute.
