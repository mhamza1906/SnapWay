# Map-authoring pipeline

**Visitor photo localization (canonical):** MegaLoc image embeddings — see
[localization-megaloc.md](../localization-megaloc.md) and
[localization-visitor-match.md](../localization-visitor-match.md). Gemini is **not**
the visitor place matcher.

**Map-authoring / graph / raster plan:** [navigation-ai-workflow-plan.md](navigation-ai-workflow-plan.md)
(feasibility for floor-plan AI and navigation UX). Visitor place match in that plan is
MegaLoc; Gemini stays map-authoring only.

**Current vectorization slice:** [Vectorizer.AI adapter and prebuilt demo assets](vectorizer-api-demo.md).
Live calls are disabled with empty credentials. The mock is reserved for **IA floor 4**
(asset pending); IA floor 1 belongs to the separate prebuilt navigation demo route.
The Figma relay proposal is superseded; no relay/plugin automation is being built.

**Acceptance status (October 17, 2026):** real IA-1 photo output failed acceptance.
See the [phase audit, requirement gaps and screenshots](../audits/2026-10-17-map-authoring-pipeline.md).
The workflow below describes the implementation; it does not establish faithful
output for a real target or completion of the required GPT Image stage.

For the next experiment, read the [web artifact review](../audits/2026-10-17-chatgpt-web-floorplan.md)
and [redesign proposal](redesign-proposal.md). They describe proposed changes and
bounded response examples; the runtime documented below has not been replaced.

`apps/pipeline/` is a private Node service. It turns an uploaded floor plan
(PDF, PNG or JPEG) into a draft indoor map: rooms and other spaces, doorways, and
a walking graph that can be routed. Everything it produces is a draft for review.
Uncertain access stays disabled, and agent work is recorded as
`agent-inspected`, never as human-reviewed.

## Hybrid design

The pipeline calls a vision model only when it has to interpret the image. All
other work runs locally and deterministically.

| Work | Where it runs |
| --- | --- |
| Reading labels, proposing room polygons, judging whether a candidate opening is a door, wall or glazing | Vision model (Claude Sonnet 5.5 in prod by default; Gemini on Vertex AI when `AI_PROVIDER=vertex`) |
| PDF decoding and vector extraction, cropping, coordinate mapping, reconciling tiles, cutting wall gaps, building the graph, routing, rendering | Local code (`server/pipelines/`, `shared/building/`) |

Model output never reaches a map without local checks. Each response must pass
a strict Zod schema. Every geometry or access change then goes through the
shared access transaction (`applyAccessDecisions` in
`shared/building/access.js`), which validates the geometry, cuts wall gaps,
rebuilds the floor graph and re-checks routes. When a request is refused, cut
off or malformed, it fails without changing the map. For the full stage
breakdown, see [stages.md](stages.md).

## How it fits SnapWay

- **Private and local.** The service listens only on `127.0.0.1`. The default
  port is `5175` (`PORT`), which avoids the original Hack_The_valley app on 5173.
  It has no authentication, so do not expose it on a network interface.
- **Angular talks to it through the dev-server proxy.** The Angular dev server
  (`python scripts/dev.py web`, port 4200) proxies `/pipeline/**` to
  `http://127.0.0.1:5175` and strips the prefix (`apps/web/proxy.conf.json`,
  `pathRewrite` `^/pipeline`). Angular therefore calls `/pipeline/api/...`, and
  the service receives `/api/...` (`PIPELINE_BASE` in
  `apps/web/src/app/features/authoring/pipeline.service.ts`). Browser calls stay
  same-origin. The service sends no CORS headers, and it rejects any browser
  request whose `Origin` is not on its allow-list (see
  [environments.md](environments.md#security-notes)). The proxy target is fixed
  at port 5175: if you change `PORT`, update the proxy too. See
  [api.md](api.md) for the routes.
- **Keys stay on the server.** Provider credentials are read from
  the single ignored `local/.env` locally and the protected process environment
  on the server. They are never sent to
  Angular, Capacitor or any browser bundle.

### Relationship to the planned architecture

The [architecture and dependency plan](../initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
puts AI authoring inside Django: Celery jobs with persistent job rows, plus the
Python packages `packages/vision/` (provider adapters) and `packages/geometry/`
(normalization, validation, routing). This Node service departs from that plan.
Arjun, the map-authoring AI/MCP lead, approved it as an **interim step**, so that
a working pipeline exists while those parts are still scaffolds.

Things this service does not do yet:

- It does not use the Django database, user accounts or permissions.
- Its job state lives in files under `apps/pipeline/.local/`, not in Celery or
  database job rows.
- Its model choice differs from the plan. The plan names Gemini as primary
  (`gemini-4-argon`) and Claude Opus 5.5 as the vector-modelling backup. Here,
  Claude Sonnet 5.5 (high effort) is used in prod by default, with Gemini on
  Vertex AI selectable.

Moving the work into Django jobs, or porting the geometry and vision code to the
Python packages, is **future work**. The plan's own rule still applies: the
provider, model or vector space is never switched silently after a failed
request.

The code came from Arjun's earlier hackathon project. The trial results and
pipeline history from that project are summarized in
[operations.md](operations.md).

## Quick start (team setup)

Requirements:

- Node 22 or later (`engines` in `package.json`); the repo baseline is Node 24.
- The service scripts (`npm start`, `npm run prod`, `npm run dev`) call
  `server/start.js`. It sets `APP_ENV` and changes into `apps/pipeline/` before
  loading settings, so it needs no inline shell variables and works on
  Windows. You can also run it from another folder, for example
  `node apps/pipeline/server/start.js prod` from the repository root. Run the
  plain `node server/...` CLI scripts from `apps/pipeline/` (see
  [environments.md](environments.md)).
- An Anthropic API key (from Arjun), plus the team's Vertex AI project and API key if you switch mapping to Gemini (`AI_PROVIDER=vertex`).

```sh
cd apps/pipeline
npm ci
# First, from the repo root: python scripts/env_contract.py migrate (old checkout)
# or: python scripts/env_contract.py init (fresh checkout).
# Fill ANTHROPIC_API_KEY (or VERTEX_API_KEY and VERTEX_PROJECT with AI_PROVIDER=vertex) in repo-root local/.env.
npm run prod                     # prints: SnapWay map-authoring pipeline (prod): http://127.0.0.1:5175
```

Before running any job, confirm which provider is live. This check is free:

```sh
curl -s http://127.0.0.1:5175/api/health
# {"ok":true,"environment":"prod","provider":"Anthropic","configured":true,"model":"claude-sonnet-5-5","effort":"high"}
```

Then start the Angular workspace from the repository root in a second terminal:

```sh
python scripts/dev.py web
```

Open http://127.0.0.1:4200/authoring. In the sidebar it is
**Map authoring (AI)**. The Django API (`python scripts/dev.py api`) is not
needed for this screen. To work without Angular, use the HTTP API and CLI in
[api.md](api.md).

Use the single `local/.env` and `npm run prod` (`npm start` is the same).
Prod still requires `AI_PROVIDER=vertex`; local provider experiments require
explicit dev policy and provider selection. Do not create provider-specific env
files. [environments.md](environments.md) and the
[shared sync guide](../environment-sync.md) describe precedence and updates.

Run the offline tests with `npm test`. They make no paid calls; one test starts
the server on port 5174 with a fake key. [operations.md](operations.md) covers
the tests in more detail.

## Directory layout

| Path (under `apps/pipeline/`) | Contents |
| --- | --- |
| `server/` | Cross-platform launcher (`start.js`), Express entry point (`index.js`), Angular authoring routes (`authoring-routes.js`), environment loading (`env.js`), the provider factory and adapters (`provider.js`, `vertex.js`, `anthropic.js`), map-job orchestration (`map-jobs.js`) and CLI scripts (`build-from-plan.js`, `run-smart-map.js`, `run-access-agent.js`) |
| `server/pipelines/` | Server-side stages: plan preparation, local PDF vectors, vision framing, extraction, coverage, smart-map orchestration, region semantics, doorway verification, source crops and design rendering |
| `shared/building/` | Provider-free domain logic: building schema, access transaction, assumed doors, graph, routing, route display, validation, coverage status, references and export. `shared/map.js` holds the single-floor map schema |
| `tests/` | `node --test` suites with no paid calls, plus fixtures (including a sample PDF floor plan) |
| `public/` | Static sample data: `buildings/routing-fixture.json` and `sample/` (a fictional sample plan, extractions and provenance) |
| `.local/`, `output/` | Runtime state created by the service (caches, map jobs, saved projects, backups). Ignored by `apps/pipeline/.gitignore`; see [operations.md](operations.md) |

## Documentation map

| Document | Read it for |
| --- | --- |
| [README.md](README.md) (this file) | What the pipeline is, how it fits SnapWay, quick start |
| [environments.md](environments.md) | Single-file configuration, provider policy, synchronization and health checks |
| [stages.md](stages.md) | How the pipeline works internally, stage by stage |
| [api.md](api.md) | HTTP endpoints (`/api/...`, `/api/authoring/...`) and the CLI scripts |
| [operations.md](operations.md) | Limits, cost, caching, testing, trial results and troubleshooting |
| [clean-plans.md](clean-plans.md) | Note: the image-model redraw stage was removed on 2026-10-17 |

Related SnapWay documents:

- [Phase audit](../audits/2026-10-17-map-authoring-pipeline.md): model roles,
  promised versus implemented flow, real IA-1 evidence and remaining acceptance.
- [Development guide](../development.md): repository bootstrap and the Django
  and Angular toolchain.
- [Architecture and dependency plan](../initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md):
  the long-term design that this service is meant to move into.
- [AI and maps integration guide](../initial/Indoor_Navigation_AI_and_Maps_Integration_EN.md):
  model roles and provider probes.
