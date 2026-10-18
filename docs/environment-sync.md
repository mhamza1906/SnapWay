# Shared environment contract and synchronization

Updated October 17, 2026. This is the active configuration workflow for contributors and agents.

## One template and one private file per machine

The repository root [`.env.example`](../.env.example) is the sole maintained application environment template. Each member keeps exactly one ignored private file at `local/.env`. Django development settings, Node, the place-match engine and active experiment entry points use that file; process environment overrides it. No application reads a root `.env`, `local/env/api.env`, or pipeline `.env.prod`/`.env.dev` anymore. The file in `docs/initial/` is preserved historical evidence, not another active template.

Production keeps its one private file at `/etc/indoor-nav/api.env` (root-owned, mode 0600). Keeping this established path avoids an unnecessary server path migration. Its key set and `ENV_SCHEMA_VERSION` must exactly match the root template; optional and unavailable keys remain present with empty values. Private values never go into templates, Git, chat, CI output, client bundles or shared action history.

Explicit browser exception: `PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY` is a restricted
website credential that must reach the Maps browser SDK. Export only that key
and `GOOGLE_MAPS_MAP_ID`, never the private file or other settings. Local and
production use separately restricted website keys and may use different map IDs;
these fields are approved host overrides, not server secrets suitable for reuse.

The template describes key names, common non-secret defaults, empty private placeholders, the allowed host-specific exceptions and required-value groups. `@secret` includes private credentials and account/project identifiers whose real values are distributed outside Git. The validator checks structure and common defaults; comparing actual shared credentials requires the external reference file or a member's explicit synchronization confirmation. A matching schema version alone does not prove equal secret values.

## Initial setup and migration

From the repository root:

```sh
# Existing checkout with old Django/Node files: preserve values and consolidate once.
python scripts/env_contract.py migrate
python scripts/env_contract.py check

# Fresh checkout instead: bootstrap also initializes this file without overwriting it.
python scripts/env_contract.py init
```

Migration combines existing values, rejects unknown keys or conflicting nonempty values, writes atomically and verifies the result before removing the superseded env files. Deployment-generated `APP_RELEASE`, `STATIC_ROOT`, `STATIC_URL` and `PYTHONPATH` are not private-file settings. Resolve a conflict privately; never paste either value into chat. Migration is for the one-time old-file transition, not the normal way to accept a new schema or replace shared credentials.

Use flat UTF-8 `KEY=value` lines, comments on their own lines, and empty values as `KEY=`. Do not use `export`, quotes, multiline content, shell expansion, `$`, backticks, backslashes or inline comments. URL-encode database password special characters, and use forward-slash paths without spaces. This deliberately small syntax behaves consistently in dotenv, django-environ and systemd EnvironmentFile. The validator rejects unsupported syntax without showing its contents.

## What must match and what may differ

Shared provider/project/model settings and feature flags should match the externally distributed team configuration. A new provider credential replaces the corresponding value in the existing file; it never creates a second provider-specific file.

Only keys explicitly marked `@override` in the template may differ by host: Django settings/debug/hosts/proxy/origins/media path, broker endpoint, database TLS CA/path/timeouts, Node port/origins, and an explicitly authorized local provider experiment (`APP_ENV`/`AI_PROVIDER`). `APP_ENV=prod` means the Node Vertex-only provider policy, not that the developer is running the deployed production stack. `npm run dev` changes that policy but still reads the same private file; an experimental `AI_PROVIDER` process override must be deliberate and reported.

`DJANGO_SECRET_KEY` is unique per environment. Local `DATABASE_URL` may select an isolated development database or remain empty for SQLite; local `DATABASE_MIGRATOR` normally stays empty. These are documented exceptions to credential equality, not permission to use production write credentials by default. Other credential differences require a named member-approved scope (for example a restricted local OAuth client). Record the exception by key and purpose in personal history, without recording values. Do not automatically copy production identity or migration credentials onto every laptop.

Compare with a freshly obtained external reference, without displaying values:

```sh
python scripts/env_contract.py check --reference local/incoming/team.env
```

The command reports differing key names, including credentials, except host overrides; it performs no synchronization or network operation. Expected environment-specific secret differences above will be reported and must be reviewed explicitly. Delete the temporary reference after reconciliation so `local/.env` remains the only maintained application env file. No watcher can detect an external update the member has not downloaded; synchronization is a team handoff, not an automatic claim of freshness.

## Every configuration update

1. The author changes the root template and consuming code together, increments `ENV_SCHEMA_VERSION` for a key/default/requiredness change or coordinated shared-value rotation, and updates this guide or the relevant sub-README if behavior changes. Secret placeholders stay empty. A key rename/removal must name the old key and migration action.
2. Through the team's external private channel, the responsible member distributes the updated values/file together with schema version, matching commit, changed key names and any rotation/restart deadline. Agents do not send messages through that channel on the member's behalf unless explicitly asked.
3. Each recipient pulls the matching commit, obtains the private update, edits their existing `local/.env`, retains only the documented local exceptions and removes retired keys. Do not blindly replace local debug/hosts/DB/secret with a production file. Templates adding blank fields do not supply the missing real values.
4. Run `python scripts/env_contract.py check` and compare the downloaded reference where appropriate. Clear stale shell overrides for changed keys, then restart Django, Node and affected workers. Validate the relevant free health/session check; a configured key is not proof of successful inference. Make no paid call merely to synchronize settings.
5. The deployment owner updates `/etc/indoor-nav/api.env` against the same release contract, checks the production profile, and restarts affected services through the reviewed release/operations process. A config-only edit does not automatically restart an existing process; the current controller may reuse unchanged application components. Never trigger a destructive data reset to fix config drift.
6. Record the version, changed key names, applied host exceptions, validation and restart/verification status in ignored `local/ACTIONS.md`. Keep the shared feature document concise and link actual changes. A pending teammate/server update stays pending until that owner confirms it.

For every configuration-dependent task, agents consult [AGENTS.md](../AGENTS.md), run the local contract check and inspect relevant process override names without printing values. When drift is found or new env fields are introduced, immediately tell the requesting member: the required commit/schema version, changed key names, where to obtain private values, the validation command and services needing restart. Never silently invent missing credentials, overwrite a private file from the blank template, or claim other members have synchronized.

## Production profile and deployment gate

Keep the same keys as the template, including empty optional ones. Set at least:

| Keys | Production requirement |
|---|---|
| `DJANGO_SETTINGS_MODULE`, `DJANGO_DEBUG` | `config.settings.production`, `false` |
| `DJANGO_SECRET_KEY` | Environment-specific strong secret, retained across ordinary releases |
| `DJANGO_ALLOWED_HOSTS`, `DJANGO_TRUST_PROXY` | `snapway.work,www.snapway.work`, `true` behind the controlled Caddy proxy |
| `CSRF_TRUSTED_ORIGINS`, `CORS_ALLOWED_ORIGINS` | HTTPS application origins; CORS stays empty unless an actual cross-origin client is approved |
| `DATABASE_URL`, `DATABASE_MIGRATOR` | Separate runtime/migration PostgreSQL credentials with existing TLS policy |
| `MEDIA_ROOT` | `/srv/indoor-nav/shared/media` |
| `PGSSLMODE`, `PGSSLROOTCERT` | Normally `verify-full` plus `system`/trusted CA; approved demo `require` plus an empty CA value and no conflicting URL parameters |
| `APP_ENV`, `AI_PROVIDER` | `prod`, `vertex` |
| `VECTORIZER_LIVE_ENABLED`, credentials | `false`, both credentials empty; IA-4 manual mock fixture still pending |

The installer now takes the public template from the repository root and preserves an existing server env file. When updating the installed controller, transfer the reviewed `infra/deploy.py`, `infra/install-server.sh`, `scripts/env_contract.py` and root `.env.example` together in the same directory structure. It installs a public validator/template fallback under `/etc/indoor-nav/` for rollback to older releases that did not package the contract.

Before enabling the new controller, reconcile the existing server file and run:

```sh
sudo python3 /etc/indoor-nav/env_contract.py check --template .env.example --file /etc/indoor-nav/api.env --profile production
```

New release archives carry their committed public template and validator. Activation checks the protected server file against that release before migrations, process startup or proxy switching; missing/unknown keys, stale version, shared-default drift and invalid production values stop activation. Secrets are not uploaded in the release. Existing Django production checks remain required for deeper configuration checks. Rollback restores executables, not old credentials; old-release compatibility still needs review, including template changes that intentionally block an incompatible rollback.

The privileged controller executes only the administrator-installed root-owned
validator, using the release template as data; it never executes uploaded
application Python as root. Validator logic changes require reviewed installer
maintenance before promotion, while ordinary template updates travel with the
release. The installed fallback template is used only for pre-contract rollback.

CI checks the public template and deterministic contract/packaging/gate tests with synthetic values; it never reads the real server/local private files. The branch changes do not install the controller, update the live server env, deploy Node, rotate any key or notify teammates. Those operational handoffs remain explicit follow-up work.

## Implementation references

| Area | Actual updates |
|---|---|
| Contract and onboarding | [template](../.env.example), [validator/migration](../scripts/env_contract.py), [bootstrap](../scripts/bootstrap.py), [local checks](../scripts/dev.py), [root README](../README.md), [development guide](development.md) |
| Runtime readers | [Django](../apps/api/config/settings/development.py), [Node](../apps/pipeline/server/env.js), [launcher comment](../apps/pipeline/server/start.js), [credential error guidance](../apps/pipeline/server/vertex.js), [floor pilot](../apps/pipeline/experiments/floorplan-pilot.mjs), [fullchain pilot](../apps/pipeline/experiments/fullchain-pilot.mjs), [image relay](../apps/pipeline/experiments/meter_image_cli.py) |
| Deployment and CI | [installer](../infra/install-server.sh), [controller](../infra/deploy.py), [packager](../scripts/package_release.py), [input classifier](../scripts/ci_changes.py), [workflow](../.github/workflows/ci.yml), [deployment guide](deployment.md), [update plan](deployment-update-plan.md), [infra README](../infra/README.md) |
| Agent/member instructions | [AGENTS](../AGENTS.md), [Cursor rule](../.cursor/rules/api-env-only.mdc), [API README](../apps/api/README.md), [Node README](../apps/pipeline/README.md), [web README](../apps/web/README.md), [experiment README](../apps/pipeline/experiments/README.md), [pipeline setup](pipeline/README.md), [provider guide](pipeline/environments.md), [operations](pipeline/operations.md), [Vectorizer guide](pipeline/vectorizer-api-demo.md), [OAuth](backend-oauth.md), [permissions](backend-permissions.md), [schema setup](database-schema.md), [feature record](map-authoring-pipeline.md) |
| Offline checks | [contract tests](../apps/api/tests/test_env_contract.py), [Node loader test](../apps/pipeline/tests/env.test.js), [promotion tests](../infra/tests/test_deploy.py), [packaging/classifier tests](../infra/tests/test_package_release.py) |

The four retired per-service templates were removed rather than maintained in
parallel; their values/schema are represented by the root contract. Historical
audit records retain their original configuration paths as dated evidence.

October 17 verification: the API/MCP/infrastructure suite passed 88 tests with
16 PostgreSQL-only skips; after tightening the privileged-validator boundary,
all 20 deployment-controller tests passed. Node passed 152 tests with 18 optional
fixture skips. Changed Python files passed Ruff lint/format, Django system check
passed, and the local file matches the 47-key contract and is Git-ignored. These
are local/offline results; no production env, controller or service was changed.

## Subsequent remote-main contract alignment

The October 17 remote check found that main `7af9eae` adds
`PLACEMATCH_ENGINE_URL`, `PLACEMATCH_ENGINE_TOKEN`, `PLACEMATCH_DEV_TOKEN` and
`LOCALIZATION_RATE`. Contract `2026-10-17.2` includes all four (51 total keys),
with engine/token fields empty and the existing main throttle default `60/min`.
The dev token and engine address are host-specific; the dev token should remain
empty in production. Engine credentials must come from that service's owner.
These settings do not enable a working engine on their own. Their consuming
iOS/localization code was subsequently merged in `04e632e`; see the readiness update below.

This machine's private file was aligned without changing any existing private
value. Its schema matches the updated local template. The remote acceptance/main
templates do not yet contain this branch's single-env contract, and no external
reference or live server file was available to prove credential freshness.
Distribute the public contract/code commit through Git and private provider
values only through the external team channel; never include the local Django
secret or migration credentials in a general team share.


## Merge-readiness configuration update

Main `7af9eae` is now merged into the acceptance branch in `04e632e`. The engine
also reads the single private file, loading only its consumed keys so Django
secrets/settings do not enter its environment. Contract **2026-10-17.3** has
**56 keys**: the previous 51 plus `PLACEMATCH_ENGINE_TIMEOUT_S=30`,
`MOBILE_REFERENCE_SET=default`, `MOBILE_RATE_LIMIT_PER_MIN=60`,
`MOBILE_STORE_FRAMES=0` and `MOBILE_ENABLE_VERTEX=1`, matching existing engine
behavior. The engine's local Python dependencies/lockfile remain independent.

`PLACEMATCH_ENGINE_TOKEN` is the single file-based engine token used by both
Django and the engine. `MOBILE_API_TOKEN` remains a legacy explicit process alias;
one-time migration maps that old file key and rejects conflicting values. The
`mobile-token --create` command writes the canonical key atomically to existing
`local/.env`, preserves other fields and does not print the token. An actual
rotation still requires external distribution, schema coordination and restart.
No real token was generated or rotated during these tests.

This machine's file is aligned with every earlier private value preserved.
Members must obtain the new commit/schema, migrate any old engine-specific file,
add the five defaults above, validate and restart affected services. The deployment
owner must align the server file and reviewed controller/validator before relying
on the new gate. None of those server actions was performed. The
[merge-readiness report](audits/2026-10-17-merge-readiness.md) records verification.

## Object storage and Google Maps contract updates

Main PR #10 advanced the shared template to contract **2026-10-17.4** (**63 keys**)
by adding the seven `S3_*` runtime fields used by Cloudflare R2 media (plus the
existing optional `R2_*` aliases). See [map-node-media.md](map-node-media.md).

Branch `feature/frontend-iteration` then advances to **2026-10-17.5** (**65 keys**)
with `PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY=` and `GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID`.
The restricted browser Maps key is both `@secret` and an approved `@override`
(local versus production website keys / map IDs may differ). Retired root
`.env.web.example` / `.env.google-auth.example` and ignored
`local/env/web.env` / `local/env/google-auth.env` consolidate through
`python scripts/env_contract.py migrate`. See
[frontend-iteration.md](frontend-iteration.md).

Members must pull the matching commit, add the new blank or default keys to
`local/.env` (or migrate legacy Google scaffold files), obtain real Maps/OAuth
values only through the external private channel, run
`python scripts/env_contract.py check`, and restart Django plus any Maps probe.
The deployment owner must align `/etc/indoor-nav/api.env` to the same schema
before relying on the production gate. No live server file was changed here.

The connected frontend used contract **2026-10-17.6** (**65 keys**).
`S3_ENDPOINT_URL` and `S3_BUCKET_NAME` carry `@secret` classification for
private resource identifiers, matching the equivalent R2 alias policy.

Contract **2026-10-18.1** (**67 keys**) adds `NAVIGATION_SESSION_RATE` (default
`30/min`) and `ROUTE_GEMINI_REWRITE` (default `false`) for visitor session create
throttling and optional Vertex rewrite of Dijkstra template directions. Rewrite
reuses existing `VERTEX_API_KEY` / `VERTEX_PROJECT` / `VERTEX_MODEL` (not
`GEMINI_API_KEY`). Members must pull the matching commit, add the two keys to
`local/.env`, set `ENV_SCHEMA_VERSION=2026-10-18.1`, run
`python scripts/env_contract.py check`, and restart Django. Production owners
align `/etc/indoor-nav/api.env` through the release process; no production update
has been performed here.

The live application reads `GET /api/client-config/` at runtime. Its explicit
allowlist exports only the restricted Maps browser key, map ID and a Boolean
Google-login availability flag. It never serializes arbitrary env variables.
No credential needs to be baked into Angular build artifacts; changes require
the Django process to reload settings, then a browser reload. Existing OAuth
Client ID and Secret remain server-side.
