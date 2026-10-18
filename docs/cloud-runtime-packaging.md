# Cloud runtime package and Vultr setup

Updated October 18, 2026. Implementation: [initial package](https://github.com/mhamza1906/SnapWay/commit/ab0c726), [Windows source-byte preservation](https://github.com/mhamza1906/SnapWay/commit/8b8d382), [runtime preparation and operator installer](https://github.com/mhamza1906/SnapWay/commit/bf2359c). Contributor execution history is in ignored `local/ACTIONS.md`.

## Current state

The user authorized installing Node and MegaLoc on the existing Vultr machine. The [CI capability probe](https://github.com/mhamza1906/SnapWay/actions/runs/39116081959) authenticated with the existing GitHub Actions identity, without a local SSH key. It confirmed that `incoming`, `venvs` and `python` under `/srv/indoor-nav` are writable, while `releases`, `shared`, systemd configuration and the protected env file are not. The identity has no general administrator permission. No account or sudo policy was changed.

The [runtime preparation job](https://github.com/mhamza1906/SnapWay/actions/runs/39116341870) stages dependencies and weights without starting a listener or changing API/web releases. It completed successfully: Node 24.15.0, Python 3.12.14, Torch 2.9.1 and 914,577,436-byte MegaLoc weights are installed. One finite 8,448-value CPU descriptor took 906.3 ms; cold-load/forward peak RSS was 3,435,655,168 bytes (about 3.2 GiB). This single synthetic check is not a sustained latency or location-accuracy benchmark. No calibration or catalog was synchronized. Permanent system services still require an administrator to run the prepared installer. This boundary comes from the server's actual permissions.

## CI preparation

The existing [CI workflow](../.github/workflows/ci.yml) has a default-off `mobile_runtime` choice. `probe` checks capabilities without server writes. `prepare` uploads filtered committed source and runs [prepare-mobile-runtime.sh](../infra/prepare-mobile-runtime.sh) as the existing deployment account. [mobile-runtime-ci.sh](../infra/mobile-runtime-ci.sh) uses the existing CI secrets, strict pinned host-key checks, a private temporary identity and cleanup on exit. Secret values and connection diagnostics are not printed.

```sh
gh workflow run ci.yml --ref feature/map-authoring-pipeline \
  -f mobile_runtime=prepare -f deploy=false -f cloud_audit=false
```

Source is stored under `/srv/indoor-nav/incoming/<commit>-<run>-<attempt>/source`. The runtime is `/srv/indoor-nav/venvs/mobile-<commit>/`:

| Path below runtime | Contents |
| --- | --- |
| `node/` | Official Node 24.15.0 Linux x64 archive, verified against its pinned SHA-256 |
| `pipeline/node_modules/` | Existing production npm lock, installed without lifecycle scripts |
| `placematch/` | Python 3.12.14 environment, existing frozen lock, non-editable installation and copied package files |
| `placematch-data/models/megaloc/` | Existing pinned upstream model code and weights, both fully SHA-256 verified |
| `placematch-runs/` | Empty private runtime destination; frame retention stays off |
| `prepared.json` | Runtime versions, lock/model hashes and basic CPU smoke-check results |

Dependency subprocesses receive a filtered environment without database/provider/deployment credentials. Preparation does not read the protected API env. It checks Node imports, OpenCV/PyTorch imports and one synthetic `(1, 3, 322, 322)` CPU inference. The descriptor must be finite and have shape `(1, 8448)`. No camera image, full video, paid provider call, reference embedding cache or accuracy evaluation is involved.

The existing Linux PyPI PyTorch lock includes CUDA wheels even though this service uses CPU. The script preserves that lock and requires at least 12 GiB free for dependencies, cache and weights; it does not choose a different wheel source or purchase a GPU. Two threads and CPU visibility are enforced. The model's existing pinned constructor performs no additional pretrained download.

## Administrator activation

The [operator installer](../infra/install-mobile-services.sh) requires root and must be reviewed and invoked by an authorized server administrator. It is not granted to the upload account through sudo. After a successful preparation, the command shape is:

```sh
sudo bash /srv/indoor-nav/incoming/RELEASE_ID/source/infra/install-mobile-services.sh \
  --stage RELEASE_ID \
  /srv/indoor-nav/venvs/mobile-COMMIT/node/bin/node \
  /srv/indoor-nav/venvs/mobile-COMMIT/placematch
```

The completed preparation is release `bf2359c5e8b1b710601e008e14bbc3cecce5bfa3-39116341870-1`. For this installed runtime, paste:

```sh
runtime=/srv/indoor-nav/venvs/mobile-bf2359c5e8b1b710601e008e14bbc3cecce5bfa3
release=bf2359c5e8b1b710601e008e14bbc3cecce5bfa3-39116341870-1
sudo bash /srv/indoor-nav/incoming/"$release"/source/infra/install-mobile-services.sh --stage "$release" "$runtime/node/bin/node" "$runtime/placematch"
```

Open the existing instance in [Vultr Console](https://console.vultr.com/), locate its administrator credentials in Overview, then use **View Console**. Sign in with the current administrator account. Vultr documents **Send Clipboard** for pasting through the console toolbar; no local SSH key is needed. See [Vultr's console guide](https://docs.vultr.com/products/compute/instances/cloud-compute/connection/vultr-console). Do not share credentials or credential-bearing screenshots. If the installer names a missing existing setting, report its name only and obtain the value through the private configuration channel.

Use the exact prepared release and commit recorded by CI. The installer copies source as the unprivileged upload identity, rejects links/special files, freezes the source under the selected immutable release and creates empty mount destinations. It verifies the prepared lock identities, existing token/provider configuration and runtime executability as the service account. Credential values are never printed or overwritten. Missing existing `PLACEMATCH_ENGINE_TOKEN`, `AI_PROVIDER` or the selected provider's credentials must be supplied by the configuration owner through the existing private channel. No new env key or schema version is introduced.

The installer renders the [pipeline](../infra/units/snapway-pipeline.service) and [MegaLoc](../infra/units/snapway-placematch.service) templates, runs `systemd-analyze verify`, and starts/enables only those two optional units. It retains previous unit files and enabled/active states and restores them on startup failure. It does not run the API deployment controller, migrations, Caddy changes, API restarts or sudo-policy changes. Source/runtime/data are retained on rollback.

Both services run as `snapway`, read the existing root-only `/etc/indoor-nav/api.env` through systemd, drop `DATABASE_MIGRATOR`, and enforce final execution flags after env-file loading. This matters because [systemd env files override `Environment=` assignments](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile=).

| Service | Private listener | Enforced execution bounds |
| --- | --- | --- |
| Pipeline | `127.0.0.1:5175` | Production provider policy, two libuv/OpenMP threads |
| MegaLoc | `127.0.0.1:8790` | One process, two CPU threads, Vertex off, frame retention off |

Read-only bind mounts supply `runtime/pipeline/node_modules`; writable binds supply `shared/pipeline-local`, `shared/pipeline-output`, `runtime/placematch-data` and `runtime/placematch-runs`. Model/catalog data remain private to `snapway`. Code and environments are frozen separately. The interpreter provisioned in the existing Python directory remains managed by the server's established deployment identity.

Service checks establish process availability and rejection of unauthenticated engine requests. They do not establish calibrated confidence, loaded floor indexes, accurate location or a working phone flow. The source files remain pinned to their release; the API-only controller does not manage their lifecycle or retention.

## Remaining integration boundaries

The API's existing `PLACEMATCH_ENGINE_TOKEN` must match the engine and `PLACEMATCH_ENGINE_URL` must select the loopback service. Its protected server configuration can be changed only by the configuration owner. Sam's reference artifacts are already in private R2, but its local metadata has not been transferred into Tiger Data. An identity-preserving backed-up transfer and authorized catalog synchronization remain required. Calibration and legitimate publication/connection review are separate from installing a runtime; no draft is silently published.

The default Caddy configuration routes `/api/*` to Django and does not forward standalone pipeline endpoints. Keep both optional services private. Cloud authoring still requires a reviewed authenticated gateway; exposing `/pipeline/**` directly would expose unauthenticated server operations. This setup does not alter that boundary or claim cloud authoring is live.

Physical phone permissions, Maps display, camera lifecycle, cellular transport and independent matching accuracy remain device checks. No cloud instance resize, new resource or paid model call is part of this setup.

## What the optional release includes

The existing packager also supports a reviewable archive, separately from CI runtime preparation:

```sh
python3 scripts/package_release.py <40-character-commit>-<run-id>-<attempt> \
  --with-mobile-services --web apps/web/dist/snapway/browser \
  --output local/release-with-mobile-services.tar.gz
```

[package_release.py](../scripts/package_release.py) packages committed API/MCP/web sources plus optional pipeline, MegaLoc, original Sam SVG/project sources, locks, unit templates and the preparation/operator scripts. Default API-only packaging and main-only production deployment gates remain unchanged. The release ID must match HEAD. Git archive disables newline conversion and excludes uncommitted files. Additional optional-source filtering excludes private envs, installed dependencies, local state, weights, vectors, private keys and recordings even if accidentally tracked. Code still needs ordinary credential review; filenames alone cannot detect a secret hidden in a source file.

## Checks and references

Basic local checks passed: **50 infrastructure tests** in about two seconds, Bash syntax, changed Python lint/format and Git whitespace checks. Tests exercise unsafe-argument rejection, Windows Git Bash selection, archive source-byte preservation, private artifact filtering, explicit CI gates, unit bounds and installer/rollback boundaries. They do not run a root installation on the developer machine.

- [Preparation tests](../infra/tests/test_prepare_mobile_runtime.py)
- [Operator installer tests](../infra/tests/test_mobile_service_installer.py)
- [Packaging tests](../infra/tests/test_package_release.py)
- [Existing deployment-controller tests](../infra/tests/test_deploy.py)
- [Environment contract](environment-sync.md)
- [Matching/index readiness](cloud-integration-readiness.md)
- [Official Node checksums](https://nodejs.org/dist/v24.15.0/SHASUMS256.txt)
- [uv non-editable installation guidance](https://docs.astral.sh/uv/guides/integration/docker/#non-editable-installs)

## Read-only cloud audit through existing GitHub Actions credentials

The separate default-off `cloud_audit=true` job remains read-only. Its [script](../infra/cloud-readiness.sh) checks machine capacity, existing executables, unit states and HTTP statuses; it reads no private env, application record or response body and performs no remote writes, package installation, sudo command or service restart. [Audit boundary tests](../infra/tests/test_cloud_readiness.py) keep it separate from the new explicit preparation action. Earlier [audit results](https://github.com/mhamza1906/SnapWay/actions/runs/39115318153) measured three CPU threads and about eight GiB RAM; the current capability probe also confirmed the existing OpenCV system library and approximately 200 GiB free disk.
