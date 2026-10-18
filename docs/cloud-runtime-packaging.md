# Optional cloud runtime package

Updated October 18, 2026. This is a reviewable package of the existing services,
not a deployed production configuration. No cloud resource, machine, credential,
unit, proxy route or paid model call was created or enabled. The existing
[deployment controller](../infra/deploy.py), installer, CI deployment policy and
API-only default remain unchanged. Contributor execution history is in ignored
`local/ACTIONS.md`.

## What the option includes

Run the existing packager after committing and validating the intended source:

```sh
python3 scripts/package_release.py <40-character-commit>-<run-id>-<attempt> \
  --with-mobile-services \
  --web apps/web/dist/snapway/browser \
  --output local/release-with-mobile-services.tar.gz
```

The release ID must name the checked-out commit. Packaging uses `git archive HEAD`,
so uncommitted edits and ignored local files never become release source. The flag
requires the optional sources and lock files to be committed. Run without the flag
for the existing API/MCP/browser archive and original manifest shape.

| Component | Source in the optional archive | Dependency authority |
| --- | --- | --- |
| Django API and MCP | `source/apps/api`, `source/apps/mcp`, `source/packages` | Root `source/pyproject.toml` and `source/uv.lock` |
| Browser application | `web/` | Already validated Angular browser build |
| Authoring pipeline | `source/apps/pipeline` | Its committed `package.json` and `package-lock.json`; root `.node-version` |
| MegaLoc engine | `source/apps/place-match` | Its separate `pyproject.toml` and `uv.lock` |
| Sam Ibrahim project | `source/experiments/sam-ibrahim-hardcoded` | Existing project code, metadata and original SVG evidence |
| Operator templates | `source/infra/units/snapway-{pipeline,placematch}.service` | Reviewed existing executable entry points |

The optional manifest adds `components` and `service_templates` metadata. It does
not mark any service active or ready. SHA-256 packaging output remains unchanged.
The Sam source SVGs are required by the pipeline renderer through its existing
relative source path; they must travel with the pipeline code. This archive is a
runtime package, not a complete frontend development checkout: experiment tools
that import web TypeScript still require a full checkout when rebuilding exports.

The optional source filter excludes known private/runtime artifacts even if
accidentally committed: private `.env*` files (public `*.example` templates remain),
local state, installed dependencies, virtual environments, model/weight folders,
model binaries, embedding arrays, private key formats, video recordings, Python
cache files, engine `data/` and `runs/`, and generated outputs. A Git commit must
still undergo credential review: an arbitrary secret hidden in an ordinary source
file cannot be recognized safely by filename filtering. No model weights, reference
photos, generated embeddings, local database, or private env is supplied by this
package. Empty runtime mount directories are added deliberately; they contain no
local state.

## Reviewed service boundaries

The two files are **templates**. They contain unresolved placeholders and must not
be copied verbatim into active systemd configuration. Use only values selected
and reviewed by the deployment owner:

- `@RELEASE_ID@`: an immutable directory under `/srv/indoor-nav/releases/` that
  contains the optional package. Pin both services to this release. `/current`
  can later point at an API-only release and is unsuitable for these units.
- `@NODE_BINARY@`: the absolute executable path for the already approved Node
  runtime matching `.node-version`, installed outside a protected home folder.
- `@PLACEMATCH_VENV@`: the absolute, separately prepared Python 3.12 virtual
  environment path under `/srv/indoor-nav/venvs/`, populated from the engine's
  committed lock. The API virtual environment does not contain the engine stack.

Both run as the existing `snapway` service user. systemd reads the existing
root-only `/etc/indoor-nav/api.env`; the service user does not need permission to
read that file. `DATABASE_MIGRATOR` is removed from each runtime environment.
Neither template puts credentials in command lines or JavaScript. This packaging
change adds no private-env key or contract version. Missing existing credentials
must come from the responsible owner through the team's private channel; never
substitute shared credentials in an application bundle.

The pipeline's existing listener binds `127.0.0.1:5175`. Its launcher preserves
`APP_ENV=prod` and existing provider policy/settings from the protected env. Its
Node/libuv and OpenMP worker limits are two. The engine uses its existing
`serve-mobile --host 127.0.0.1 --port 8790` command with one process, two
OMP/MKL/OpenBLAS/NumExpr threads, and CPU-only visibility. This is a conservative
starting configuration for a two-vCPU host, not a measured cloud speed claim.
The template disables optional Vertex fallback and frame retention explicitly;
live requests use MegaLoc and ephemeral query cache. Engine matching state and
signed request authorization stay in the existing application services.

Both units harden the filesystem with `ProtectSystem=strict`, `ProtectHome=yes`,
private temporary storage and `NoNewPrivileges`. Mutable paths are bind-mounted
from protected, persistent shared storage into empty destinations in the release:

| Shared path | Release destination | Access |
| --- | --- | --- |
| `/srv/indoor-nav/shared/pipeline-node_modules` | `source/apps/pipeline/node_modules` | Read only; locked Linux dependency installation |
| `/srv/indoor-nav/shared/pipeline-local` | `source/apps/pipeline/.local` | Read/write runtime state |
| `/srv/indoor-nav/shared/pipeline-output` | `source/apps/pipeline/output` | Read/write exports |
| `/srv/indoor-nav/shared/placematch-data` | `source/apps/place-match/data` | Read/write indexes/catalog and provisioned model/calibration |
| `/srv/indoor-nav/shared/placematch-runs` | `source/apps/place-match/runs` | Read/write runtime directory; frame retention remains off |

Provision writable shared directories for `snapway:snapway` with mode 0700. Keep
code, virtual environments and prepared dependency installation read only to the
service. The host installer does not create these optional paths. The operator
must prepare them before verifying or activating rendered units. Do not install
npm packages or download Python wheels on service startup.

## Activation gates for the deployment owner

1. Build/test the committed browser/API/pipeline/engine versions and inspect the
   optional archive and manifest. Retain its SHA-256 sidecar and release identity.
2. Confirm an existing compatible Linux Node runtime, Python 3.12, engine native
   dependencies and two separate lock-resolved environments are available. The
   CUDA/PyTorch packages selected by the engine's existing lock may require a
   substantial disk download. This task did not install, change or purchase them.
   Review any needed OS package/runtime change before proceeding.
3. Prepare shared paths and existing pinned MegaLoc code/weights using the
   documented hashes, calibration and authorized reference indexes. Reference
   photos/indexes remain in their existing private R2 storage and are loaded or
   synchronized through the authorized API/engine flow. Do not make the bucket
   public. The existing `PLACEMATCH_ENGINE_TOKEN` must agree between API and engine;
   the API's `PLACEMATCH_ENGINE_URL` must point at the reviewed loopback endpoint.
4. Measure **on the actual host**, under simultaneous API load: cold startup peak
   RSS, warmed inference RSS, request latency, CPU pressure and disk usage. The
   prior local eight-thread CPU run peaked near 2.13 GB process footprint and
   suggested roughly 3 GB per serial worker ([measurement](sam-ibrahim-video-localization.md)).
   This does not validate a two-thread Linux/Vultr configuration. Do not activate
   MegaLoc where measured headroom cannot cover it plus the API, OS, and optional
   authoring work. Suspend authoring during matching if the combined budget fails;
   no automatic instance resize or GPU purchase is authorized by this package.
5. Render unit placeholders against the selected release, inspect the resulting
   files, and run `systemd-analyze verify` on the deployment host. No systemd syntax
   validator is available on the author's macOS machine; repository tests check
   the template boundaries, not Linux activation. Only the owner should install
   or enable units after the earlier gates pass.
6. Probe both private services and then the authorized API flow. A running process
   or a successful `/v1/health` response does not establish ready weights, indexed
   floors, calibrated confidence or accurate localization. Confirm cold/warm
   loading, uncertain/unmapped responses and real-phone permission/lifecycle flows.

The default Caddy configuration routes `/api/*` to Django and does **not** forward
the pipeline authoring endpoints. Never expose the unauthenticated standalone
pipeline server directly on the public internet. A reviewed, authenticated gateway
is required before cloud authoring is enabled. The matching engine likewise stays
private; phones call the authenticated or session-scoped Django gateway rather than
port 8790. This change does not alter proxy rules or claim cloud authoring is live.

The existing controller does not install, start, probe, roll back or rotate these
optional units. Their pinned release must be retained while they run. A production
activation/rollback plan must cover them separately before enabling them. CI still
packages/deploys through its existing default main-branch policy; this flag is not
silently enabled in CI and pushing a feature branch does not deploy a server.

## Changed files and verification

- [Release packager](../scripts/package_release.py)
- [Packaging and boundary tests](../infra/tests/test_package_release.py)
- [Pipeline unit template](../infra/units/snapway-pipeline.service)
- [MegaLoc unit template](../infra/units/snapway-placematch.service)

**Validation:** packaging and existing deployment-controller suites pass together
(**34 tests**); changed Python lint/format and Git whitespace checks pass.
Focused packaging tests use disposable Git repositories and synthetic secrets;
they cover default archive compatibility, opt-in committed code/locks/SVGs,
manifest components, uncommitted changes, artifact exclusions, and template
permission/thread/listener boundaries. Existing controller tests remain unchanged.
Commit links will be added after the reviewed integration is committed.

## Read-only cloud audit through existing GitHub Actions credentials

The existing CI workflow now has a separate, independent `cloud-readiness` job.
It runs only on an explicit workflow dispatch with `cloud_audit=true`; both
`cloud_audit` and the existing `deploy` input default to false. It uses the five
already configured Vultr SSH secrets through the existing CI identity. Secret
values are never displayed. Temporary identity and pinned known-host files use
mode 0600 under a mode 0700 runner directory, with cleanup on exit. SSH host-key
verification is mandatory; raw connection diagnostics are suppressed.

After the reviewed branch is committed and pushed, the authorized repository
operator can request the audit without a local SSH key:

```sh
gh workflow run ci.yml --ref feature/map-authoring-pipeline \
  -f cloud_audit=true -f deploy=false
```

Read the **Read-only cloud readiness** job summary in that run. The job checks SSH
authentication, operating system/CPU, available memory, disk capacity, SnapWay unit
names/states, existing executable presence and HTTP status codes. It probes only
loopback ports 5175/8790 and public liveness, readiness and native map routes; it
uses no authorization header and discards all HTTP response bodies. A protected
engine may appropriately return 401/403; an absent service reports unreachable.
A public native map status of 200 establishes HTML availability, not successful
Google rendering or a valid provider allowlist.

The remote script reads no env file, process environment, private key, application
record, image, embedding or database content. It performs no remote writes, sudo,
package installation, migration, deployment or service activation/restart. The job
is independent of the test/deployment dependency graph and leaves the existing
main-only packaging/deployment expressions unchanged. A feature-branch audit
cannot activate that branch through this option. Existing tests may also run in
the dispatched workflow; their results do not turn `deploy=false` into consent to
deploy. If GitHub rejects dispatch inputs until the workflow is available on the
default branch, report that platform limitation and do not bypass production gates.

Implementation: [CI workflow](../.github/workflows/ci.yml),
[read-only audit script](../infra/cloud-readiness.sh), and
[offline boundary tests](../infra/tests/test_cloud_readiness.py). The tests assert
explicit default-off invocation, strict host-key checking, read-only remote
commands and exact preservation of the existing production gate expressions.
The combined audit, packaging and existing deployment-controller suite passes
**37 tests**; Bash syntax, changed Python lint/format and Git whitespace checks pass.
No remote audit was executed while authoring these files.
