# SnapWay

Collaborative indoor mapping and reviewed visual navigation. The current work is
**Stage 1: Map Platform**. The `feature/frontend-prototype` branch contains an
interactive Angular prototype covering map editing, contribution review,
publication and visitor navigation. Those prototype workflows save business data
in browser Local Storage and simulate AI and Android hardware. The acceptance
branch also contains separate Node AI authoring and Django OAuth foundations;
their integration and acceptance limits are recorded below.

Start with the [prototype walkthrough and integration guide](docs/frontend-prototype.md)
and [Figma prototype](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa).
For frontend-only testing, run `npm ci` then `npm start` from `apps/web`; no API
server or Python environment is required for the prototype.

The [PostgreSQL schema](docs/database-schema.md) now defines map authoring,
evidence, reviewed publications, jobs and navigation persistence through Django
migrations. Product workflows and APIs remain separate implementation work.

Start with the [initial documentation index](docs/initial/README.md), then follow
the [development guide](docs/development.md). The original planning files and
two historical references were copied intact from Hackathon-Plan; their source
directory is retained. Personal `local/` content was excluded.

## Quick start

Install Git, Python 3.12, uv and Node 24.15+ (24.x) with npm 11. Exact Python and
Node baseline versions are recorded in `.python-version` and `.node-version`.
From the repository root:

```sh
python scripts/bootstrap.py
```

This installs locked Python/frontend dependencies, creates ignored `local/`
directories and a private development secret, and migrates a local SQLite
database. SQLite supports onboarding only; PostgreSQL remains required for
database integration and product acceptance. Bootstrap preserves an existing
`local/.env`; follow the [single-env sync guide](docs/environment-sync.md) for
existing-checkout migration and externally distributed configuration updates.

Start two terminals from the root:

```sh
python scripts/dev.py api
```

```sh
python scripts/dev.py web
```

Open **http://127.0.0.1:4200/** for the prototype workspace. The original
**Check connection** diagnostic is at `/connection-check`. The Angular proxy
connects to Django on `127.0.0.1:8000`. Liveness is available at
`/api/health/live/`; database/framework readiness is `/api/health/ready/`.

Run the shared checks:

```sh
python scripts/dev.py check
```

## Repository

```text
apps/web/               Angular contributor workspace + separate visitor entry
apps/web/android/       Generated Capacitor Android project and Gradle wrapper
apps/web/ios/           Generated Capacitor iOS project (Xcode, Swift Package Manager)
apps/api/               Django/DRF, domain schema, custom user, health and Celery setup
apps/mcp/               Official MCP v2 read-only local stdio scaffold
apps/pipeline/          Map-authoring AI pipeline service (Node); see docs/pipeline/
apps/place-match/       Photo place-matching engine (MegaLoc, Vertex AI) and mobile API
packages/geometry/     Geometry boundary; algorithms follow later
packages/vision/       AI adapter boundary; provider calls follow later
contracts/             PostgreSQL DDL reference; future payload schemas and fixtures
infra/                 Native deployment boundary and future configuration
evals/                 Future shared evaluation assets and evidence
docs/initial/          Preserved current plans and historical references
scripts/               Portable bootstrap, development and verification tools
local/                 Ignored private settings, database, logs and research
.venv/                 Ignored machine-local Python environment
```

## Map-authoring pipeline

The **Map authoring (AI)** screen (`/authoring`) uses the Node service in
`apps/pipeline/`. Run it with `npm ci && npm run prod` from `apps/pipeline`
(Gemini on Vertex AI). Django and Node share ignored `local/.env`, using the root
`.env.example`; provider experiments use explicit process overrides without
creating another env file. See [docs/pipeline](docs/pipeline/README.md) and the
[feature record](docs/map-authoring-pipeline.md).

**IA-1 real-photo acceptance failed.** Read the
[phase audit, model/pipeline gaps and committed screenshots](docs/audits/2026-10-17-map-authoring-pipeline.md)
before using this result as evidence of a completed authoring workflow. Real
Vertex access succeeded, but the generated proposal was not accepted as a map.
Visitor photo localization (canonical MegaLoc path):
[docs/localization-megaloc.md](docs/localization-megaloc.md),
[docs/localization-visitor-match.md](docs/localization-visitor-match.md).
iOS camera app notes: [docs/mobile-ios.md](docs/mobile-ios.md)
(API reference: [docs/mobile-ios-api.md](docs/mobile-ios-api.md)).

## Dependencies and collaboration

Share `pyproject.toml`, `uv.lock` and `apps/web/package-lock.json`. Each teammate
recreates `.venv` and `node_modules` locally. Default bootstrap includes the
`ai`, `geometry` and `mcp` Python extras plus development tools. Conditional
`ai-backup`, `storage` and `vector` extras remain optional; the full manifest and
activation boundaries are described in the development guide.

Current leads: Erfang (frontend), Hamza (basic backend APIs), Eric (schema and
CI/CD), Arjun (map-authoring AI/MCP). Collective ownership and cross-review
follow the [assignment plan](docs/initial/Indoor_Navigation_Stage_1_Assignment_Plan_EN.md).

CI checks changed components on main pushes and PRs. Deployment, shared cloud
database/live OAuth integration, device installation and full product acceptance
remain unverified in this review. The AI trial above has its own recorded outcome.
No paid provider calls are made by setup or CI.
