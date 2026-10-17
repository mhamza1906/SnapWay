# Development and initialization record

Initialized October 16, 2026 (America/Toronto). The original requirements and
architecture are indexed in [initial/README.md](initial/README.md). This guide
describes implemented setup behavior; the initial files retain their original
planning status and content.

Maintain all authored documentation under `docs/` in English, including plans,
feature records, audits, diagram labels and explanatory examples. Preserve original
source artifacts and historical input bytes; describe their meaning in English
instead of modifying evidence. The shared rule is recorded in [AGENTS.md](../AGENTS.md).

For the interactive frontend, use the [prototype walkthrough](frontend-prototype.md).
Its Local Storage service and simulated AI/device flows run without the API; this
guide remains the initialization and backend/toolchain reference.

## Toolchain and locked dependencies

| Layer | Selected line / manager |
| --- | --- |
| Python | 3.12.14, `.python-version`, uv 0.12.15 used for initialization/CI |
| Backend | Django 5.2 LTS + DRF, resolved in `uv.lock` |
| Frontend | Angular 21.2 + TypeScript 5.9 + RxJS 7, npm lockfile |
| Node/npm | Node 24.15.0 baseline, npm 11.12.1 |
| Mobile | Matching Capacitor core/CLI/Android 8.4.3 |
| MCP | Official Python SDK v2; stdio capability resource only |

Capacitor 8.4.3 was selected after npm audit identified a vulnerable indirect
dependency in CLI 8.5.3. No forced cross-major upgrade or dependency override was
used. Java/Android SDK compatibility is a separate native build check; the host's
default Java 24 is not treated as an accepted Android toolchain.

The Python root project unifies API, worker, MCP and small shared package
dependencies without installing the source tree as a distribution. Runtime
commands are invoked through the development script or `apps/api/manage.py`.

| Profile | Included capability | Default bootstrap |
| --- | --- | --- |
| Base | Django/DRF, allauth, PostgreSQL driver, Celery, configuration, HTTP, image validation | Yes |
| `dev` group | Ruff, pytest, pytest-django | Yes |
| `ai` extra | Google Gen AI, OpenAI, NumPy, HTML parsing | Yes; no calls enabled |
| `geometry` extra | NumPy, OpenCV headless, Shapely, NetworkX, restricted XML parsing | Yes |
| `mcp` extra | Official MCP CLI/SDK and Uvicorn | Yes |
| `ai-backup` extra | Anthropic SDK | No |
| `storage` extra | S3-compatible Django storage adapter | No |
| `vector` extra | pgvector Python adapter | No; DB extension needs separate provisioning |

For optional work, preserve the standard extras when syncing, for example:

```sh
uv sync --locked --extra ai --extra geometry --extra mcp --extra ai-backup
```

Gunicorn is installed on Linux, excluded on Windows. Redis is an independent
native service, not installed by pip. Use WSL2/Linux for Celery/Redis process
integration. No Torch/CUDA/SLAM stack is pulled into the shared environment.

Use `uv add` / `uv lock` for intentional Python dependency updates and `npm
install` inside `apps/web` for intentional frontend updates. Review and commit
the manifest/lockfile together. Reinstall existing locks with `uv sync --locked`
and `npm ci`; never copy `.venv` between machines. Lockfile/platform-specific
packages are resolved by the package managers.

## Bootstrap and private settings

Run `python scripts/bootstrap.py` from a fresh checkout. It checks Node/npm,
creates ignored `local/` directories, installs the locked profiles and runs
migrations/checks. uv obtains the pinned Python if necessary. A development key
is generated only when `local/env/api.env` does not exist. Repeating bootstrap
preserves existing settings and data; an invalid existing configuration is
reported instead of overwritten.

`config.settings.development` alone loads that private file. This project does
**not** use a repo-root `.env` for application settings. Process environment
variables take precedence. The root `.env.example` contains only implemented
development setup settings and inactive provider placeholders (copy values into
`local/env/api.env`). The full future configuration inventory remains intact at
`docs/initial/.env.example`.

| Settings profile | Database | Secret source |
| --- | --- | --- |
| `config.settings.development` | `DATABASE_URL` or ignored `local/dev.sqlite3` | Process environment / `local/env/api.env`; required |
| `config.settings.test` | Isolated in-memory SQLite | Explicit non-deployment test key |
| `config.settings.production` | Required PostgreSQL URL, verified TLS | Process environment; no local file loaded |

For PostgreSQL development, edit the private `DATABASE_URL` and run migrations
explicitly. A trusted loopback-only PostgreSQL may use `sslmode=disable`; cloud
connections retain `verify-full`. Automated PostgreSQL tests must target an
isolated service; no shared demo database should be mutated by test runs.
The initial SQLite checks do not validate PostgreSQL concurrency, constraints,
cloud TLS, extensions or backups.

The custom `accounts.User` is present before the first migration. Map-specific
administrator/volunteer membership will be implemented separately; staff access
does not constitute the product authorization policy. For optional internal
inspection, create a local administrator yourself:

```sh
uv run --locked python apps/api/manage.py createsuperuser
```

Google OAuth for developers is wired through django-allauth on branch
`feature/backend-oauth`. See the shared feature record
[backend-oauth.md](backend-oauth.md): `/accounts/google/login/`, session
`GET /api/auth/me/` and `POST /api/auth/logout/`, and env placeholders for
`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`. Private development
settings live **only** in ignored `local/env/api.env` (never a repo-root `.env`).
Development prefers Tiger Data PostgreSQL via `DATABASE_URL` there; SQLite
remains the offline fallback. Map roles are never granted by Google. AI provider
SDKs remain inactive. No application authoring job or server-backed
guest-navigation capability is implemented. The separate frontend prototype still
simulates contributor roles locally until an Angular login UI is added.

## Development commands and health

Run `python scripts/dev.py api` and `python scripts/dev.py web` in separate
terminals. API binds to `127.0.0.1:8000`; frontend binds to `127.0.0.1:4200`.
Stop each with Ctrl+C. API/auth/admin development paths are proxied through the
web origin. Django CSRF uses Angular's `XSRF-TOKEN` / `X-XSRF-TOKEN` convention.
Protected DRF endpoints default to session authentication and authenticated
permissions; future public endpoints must deliberately opt in.

| Endpoint | Meaning |
| --- | --- |
| `GET /api/health/live/` | Process liveness and release identifier; independent of DB/providers |
| `GET /api/health/ready/` | SQL connection plus initial user table exists; 503 on DB failure |

Health endpoints are read-only public operational checks. Readiness currently
covers the framework database only, not queues, providers, map publications or
indexes. Exception details are not returned. The frontend's connection button
checks liveness; it does not claim product readiness.

MCP: run `python scripts/dev.py mcp` from the root in an MCP client's subprocess
configuration. The resource `snapway://status` reports that map tools are not
enabled. No HTTP listener or map mutation exists. Signed delegation and shared
authorized domain services are required before adding private HTTP/tools.

## Frontend and Android boundary

From `apps/web`:

```sh
npm run build
npm run build:visitor
npm test
npm run format:check
```

Web output is `dist/snapway/browser`. Visitor output is
`dist/snapway-visitor/browser` and uses `src/main.visitor.ts`, excluding the
workspace route/component. `capacitor.config.ts` bundles visitor output; it
contains no live-reload server URL or provider keys. The Android project and
Gradle wrapper are generated from the selected Capacitor template and tracked.

```sh
npm run android:sync
npx cap open android
```

Android Studio, a compatible JDK/SDK and a physical phone remain necessary to
build/install/test an APK. App ID `org.snapway.app` is an initial candidate; agree
the release identity and signing custody before distribution. No APK, camera
plugin behavior, device permission flow or native acceptance is claimed.

## Checks and CI

Run `python scripts/dev.py check` after bootstrap. It verifies initial-document
hashes, Ruff, Django checks/migration drift, Python tests, frontend formatting,
frontend tests and both production builds. The tests cover DB-failure health
behavior, invalid production settings, MCP resource exchange through a real
stdio subprocess, and frontend connection failure/retry. They use no real
cloud credentials or model calls.

GitHub Actions classifies changed inputs, checks Python on Windows/Linux and
builds web/visitor plus Capacitor synchronization on Linux. An always-running
aggregate `required` job handles skipped component jobs. CI action revisions are
pinned. Hosting/release promotion and device acceptance are not implemented.

CI excludes documentation from component change detection and frontend formatting,
and does not run the initial-document hash check. Documentation-only updates skip
application jobs while the aggregate check completes. See [CI behavior](ci.md).
The document inventory check remains part of local bootstrap/development checks.

Production settings require a strong secret, explicit hosts, PostgreSQL and
`verify-full` TLS. `STATIC_ROOT` and `MEDIA_ROOT` must point outside releases.
Enable `DJANGO_TRUST_PROXY=true` only behind a controlled proxy that strips
caller-supplied forwarded headers. HSTS applies to the chosen host; extending
it to every subdomain or requesting preload remains an explicit operational
decision (`DJANGO_HSTS_INCLUDE_SUBDOMAINS`, `DJANGO_HSTS_PRELOAD`). The associated
Django advisory warnings remain visible until that decision.

## Documentation migration

All 14 shared source files (README, nine current plans, configuration/ignore
files and two archive references) were copied byte-for-byte into `docs/initial`.
`docs/initial-manifest.json` records SHA-256 hashes. Git preserves their original
line endings so verification works on a fresh clone. Relative document links
retain the original directory relationships. `scripts/check_docs.py` verifies
the snapshot independently of the original source directory.

Keep new implementation guidance and decisions under `docs/`; link back to
the initial requirement where useful. Personal scripts, original research source
downloads, private captures, logs and credentials remain in ignored `local/`.

Initialization does not pass G1 or any product gate. PostgreSQL/Tiger Data,
Redis/worker recovery, real OAuth/AI integrations, native build/device checks,
cloud deployment and map/navigation acceptance remain to be executed.
