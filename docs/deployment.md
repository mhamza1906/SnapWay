# Vultr deployment

The [deployment update plan](deployment-update-plan.md) selects the next increment:
Django-owned business APIs and durable jobs, with one private Node compute
service and a serial authoring worker. It defines delivery/resource/rollback
gates; Node and the worker are not implemented by the deployment described here.

Owner: Eric. Updated October 17, 2026. Demo TLS fix: pending on `ci/deployment`.
Earlier deployment commits: [native deployment](https://github.com/mhamza1906/SnapWay/commit/8d0a005)
and [single environment file](https://github.com/mhamza1906/SnapWay/commit/32a5abf).

Deploys the Angular website and Django API using the approved
[native architecture](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md#selected-fast-cicd-strategy).
Tiger Data remains the PostgreSQL server. The VM hosts application processes,
release artifacts and private persistent media/index files. No Docker, new
application dependencies, production Redis, Celery worker or MCP listener is
introduced by this first release. Those unfinished capabilities remain inactive.
The Angular prototype still uses its existing Local Storage/simulated workflows;
hosting the API does not connect unfinished product features automatically.

## Current target and prerequisites

- Domain: `snapway.work` and `www.snapway.work`, Porkbun DNS.
- Vultr Ubuntu 24.04 x86_64: `155.138.198.255`, Atlanta, 2 vCPU / 4 GB RAM.
- Caddy already returns the temporary HTTPS confirmation page; UFW allows 22,
  80 and 443. `snapwayadmin` has sudo; `snapwaydeploy` has a dedicated SSH key.
- The contributor reports an existing migrated Tiger Data schema with no product
  data. Deployment applies pending migrations; it never resets the database.
- Repository Actions secrets: `VULTR_HOST`, `VULTR_USER` (`snapwaydeploy`),
  `VULTR_SSH_PORT`, `VULTR_SSH_KEY`, `VULTR_KNOWN_HOSTS`.
- Production deployment is disabled until the repository Actions **variable**
  `PRODUCTION_DEPLOY_ENABLED` is explicitly set to the string `true`.

The contributor completed server setup during guided installation. The first
release attempt passed SSH upload, dependency installation and settings checks,
then stopped at migration connection setup because the Free-plan Tiger service
presented a certificate outside the VM's system trust store. No successful
application release promotion has been confirmed.

## One-time server preparation

Keep an administrator SSH session open. On the **server**, install the existing
project's uv tool version outside application release directories:

```bash
sudo apt install -y python3-venv
sudo python3 -m venv /opt/snapway-tools
sudo /opt/snapway-tools/bin/pip install uv==0.12.15
sudo ln -s /opt/snapway-tools/bin/uv /usr/local/bin/uv
/usr/local/bin/uv --version
```

If `/usr/local/bin/uv` already exists, inspect its version and ownership rather
than replacing it blindly. uv downloads the repository's exact Python runtime
into `/srv/indoor-nav/python` when preparing the first dependency environment.
No Node installation or Angular build occurs on the VM.

From **local Windows PowerShell**, copy the reviewed infrastructure files:

```powershell
ssh snapwayadmin@155.138.198.255 'mkdir -p ~/snapway-infra/infra'
scp infra/deploy.py infra/install-server.sh snapwayadmin@155.138.198.255:~/snapway-infra/infra/
ssh snapwayadmin@155.138.198.255 'mkdir -p ~/snapway-infra/scripts'
scp scripts/env_contract.py snapwayadmin@155.138.198.255:~/snapway-infra/scripts/
scp .env.example snapwayadmin@155.138.198.255:~/snapway-infra/
```

On the **server**:

```bash
cd ~/snapway-infra
sudo bash infra/install-server.sh
sudo nano /etc/indoor-nav/api.env
```

The installer preserves the running Caddyfile and existing credentials. It
creates the unprivileged `snapway` application identity, immutable root-owned
release storage, upload/venv directories for `snapwaydeploy`, private persistent
media/index storage, and a root-owned activation command. The upload account
receives sudo access only to that command, never arbitrary systemctl or shells.
Updating the controller itself is an administrator maintenance step using
reviewed files; ordinary code releases cannot replace it.

Follow the [single-env synchronization guide](environment-sync.md) to reconcile
all keys and ENV_SCHEMA_VERSION with the root template before installing this
updated controller. Set the production settings/debug/hosts/origins/media values;
the root template defaults are for local development, not a ready-to-run server.
The installer preserves existing credentials. Activation now validates the server
file against the release contract before migrations or process changes.

Complete the production values in the shared environment contract:

- Generate a Django secret with `python3 -c 'import secrets; print(secrets.token_urlsafe(64))'`
  and insert it directly in the server file; never put it in Git or chat.
- Set `DATABASE_URL` to Tiger Data's actual direct PostgreSQL endpoint and port.
  Percent-encode special characters in connection-string passwords. Prefer a
  dedicated runtime role with the application's required grants.
- Set `DATABASE_MIGRATOR` to the same database with the migration/owner login.
  The migration launcher temporarily selects this connection as `DATABASE_URL`
  before Django starts. A missing value fails migrations explicitly. Normal API
  and management processes have `DATABASE_MIGRATOR` removed from their environment.
- The default is `PGSSLMODE=verify-full`. Use `PGSSLROOTCERT=system` only if the service
  certificate chains to a trusted system root. Otherwise copy the CA from Tiger
  Data to `/etc/ssl/certs/tiger-ca.pem`, make it root-owned and world-readable
  (the certificate is public), and configure that absolute path. The application
  user must be able to traverse its parent directories; `/etc/indoor-nav` is
  intentionally root-only. The approved Free-plan demo exception is below.
- Keep the explicit hosts, HTTPS CSRF origins and `DJANGO_TRUST_PROXY=true`.
- Google client credentials are optional for process startup; Google sign-in
  requires the real client configuration and exact HTTPS callback registration.
- Do not set `STATIC_ROOT`, `STATIC_URL`, `PYTHONPATH` or `APP_RELEASE` here; the
  controller supplies release-specific values.

Both connection URLs live in the single protected `/etc/indoor-nav/api.env`:

```dotenv
DATABASE_URL=postgresql://RUNTIME_USER:PASSWORD@HOST:PORT/DATABASE
DATABASE_MIGRATOR=postgresql://snapway_migrator:PASSWORD@HOST:PORT/DATABASE
```

```bash
sudo chown root:root /etc/indoor-nav/api.env
sudo chmod 600 /etc/indoor-nav/api.env
```

The migration connection needs permission to apply the existing schema migrations.
The runtime connection needs schema/table and
sequence access; those grants must be maintained for newly migrated objects.
Do not change or drop the existing schema to work around an error. Verify Tiger
network rules allow the Vultr IPv4. A runtime check cannot prove migration grants.

For a VM with the earlier two-file controller, copy the updated reviewed
infrastructure files and rerun the installer. Add the old migration connection
as `DATABASE_MIGRATOR` in `api.env`, then remove the obsolete file if it exists:

```bash
sudo nano /etc/indoor-nav/api.env
sudo rm /etc/indoor-nav/migration.env
```

Do not remove the old file before preserving its connection and installing the
updated controller. Existing running API processes pick up environment changes
on restart; subsequent releases generate the API service's migration-variable
exclusion. Local development still reads `local/.env` and uses its
`DATABASE_URL`; this change does not alter the local management entrypoint.

### Free-plan demo TLS

On October 17, the requesting contributor explicitly approved `require` for this
Free-plan demo. Traffic remains encrypted, but the database server's identity is
not verified. This exception applies to both runtime and migration connections;
verified TLS remains the default and the target before storing production data.
No dependency, database-role, or service-topology change is needed.

Before deploying the settings fix, edit the file **on the VM**:

```bash
sudo nano /etc/indoor-nav/api.env
```

1. Set `PGSSLMODE=require`.
2. Set `PGSSLROOTCERT=` (retain the empty key for schema parity). `sslrootcert=system` is incompatible with
   `require`, and other CA files can activate certificate verification.
3. In **both** `DATABASE_URL` and `DATABASE_MIGRATOR`, change any `sslmode=verify-full`
   query parameter to `sslmode=require` and remove any `sslrootcert` parameter.
   URLs without either parameter can stay as they are; settings supply the mode.
   Keep the two distinct logins and all other connection details unchanged.
4. Save, then commit/push the settings fix and merge it into `main` to trigger a
   fresh CI/deployment run. If deploying manually, use **CI → Run workflow → main**
   with **deploy** enabled after the merge. Do not rerun the failed deploy job
   alone: its attempt-specific artifact name no longer matches the package
   artifact from the earlier attempt.

Settings reject plaintext-capable modes, mismatched URL/environment modes, and
CA options left in the demo configuration. Revert to `PGSSLMODE=verify-full`,
matching URL modes, and an appropriate `PGSSLROOTCERT` when verified TLS becomes
available. See [PostgreSQL connection parameters](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNECT-SSLROOTCERT)
for the special behavior of `sslrootcert=system`.

## First release and automatic releases

1. Review and commit the branch, open a PR and merge only after CI passes. This
   does not deploy while `PRODUCTION_DEPLOY_ENABLED` is absent or false.
2. Complete server setup, verify the real Tiger TLS/role profile, and arrange
   recoverable database plus persistent-file backups before storing valuable data.
3. Set the Actions repository **variable** `PRODUCTION_DEPLOY_ENABLED=true`.
4. In Actions, select **CI → Run workflow → main**, enable **deploy**, and run.
   The manual run checks all tracked application inputs before packaging.
5. Check the workflow, `https://snapway.work/`, `/api/health/live/`,
   `/api/health/ready/`, a deep Angular route, and browser asset requests. Confirm
   the liveness commit is the tested commit. Test auth separately if configured.

Subsequent application merges into `main` automatically deploy after CI passes.
PRs, feature branches, documentation-only commits and ordinary manual check runs
do not deploy. The existing required CI result remains available. A main run and
the production release job are not canceled when another commit arrives;
GitHub concurrency plus a server-side lock prevent concurrent promotions.

## Release behavior and recovery

The CI browser artifact is cached by complete frontend/config/toolchain input
identity; exact dependency-cache hits skip `npm ci`. Backend-only releases reuse
the browser artifact, rebuilding and retesting it if the exact artifact is missing.
Main pushes classify changes
against the last successful main run so earlier failed changes are not skipped.
The package
contains committed backend source, the validated browser files, a commit/run ID
and a SHA-256 checksum. Untracked local files and server secrets are not included
by `git archive`.

Uploads land in `/srv/indoor-nav/incoming/<commit>-<run>-<attempt>/`. The installed
controller copies them as the uploader, rejects special files/symlinks, then
freezes a root-owned release under `releases/`. It compares complete component
digests with the last successful release, so a previous failed deployment cannot
silently drop a backend change on the next frontend-only commit.

Backend changes reuse only a completed venv keyed by lockfile, manifest, exact
Python version, OS, architecture, uv version and install profile. A cache miss
creates it at its final path; running environments are never resynced. The
controller checks production settings, applies pending migrations using
`DATABASE_MIGRATOR`, collects release-qualified Django static files, and starts
the inactive API slot (`8101`/`8102`). Private liveness/readiness must pass before
Caddy switches to that API and the corresponding frontend. Public HTTPS health
and exact index content must then pass. The old API drains with Gunicorn TERM.

Frontend-only changes do not install Python dependencies, run migrations or
restart the API. Previous browser chunks and release-qualified Django static
assets remain available. `/api`, `/accounts` and `/admin` route to Django before
SPA fallback. Private media and MCP routes return 404; no upload folder is public.
Neither framework readiness nor deployment success proves product/AI readiness.

Failed migrations preserve the existing service but may leave successfully
applied earlier migrations; deployment never automatically reverses the schema.
Only additive/backward-compatible migrations are safe while versions overlap.
Candidate health or promotion failures retain/restore the previous Caddyfile
and stop the candidate. Review partially applied DB changes independently.

On the server, inspect:

```bash
sudo cat /etc/indoor-nav/active.json
sudo cat /etc/indoor-nav/previous.json
sudo journalctl -u snapway-api-blue -u snapway-api-green -u caddy -n 100 --no-pager
```

After independently confirming schema compatibility, an administrator can
reactivate the retained previous release without running migrations:

```bash
sudo /usr/local/sbin/snapway-activate PREVIOUS_RELEASE_ID --rollback
```

Use the `release` value from `previous.json`. Retain active/previous code, venvs,
browser assets and static sets; there is no automatic cleanup. After an abrupt
VM/power failure during promotion, inspect actual slot health, Caddy configuration
and the state manifests before manually reconciling/retrying; this is not a
database/proxy/filesystem distributed transaction. VM backups do not back up Tiger
Data. Recovery exercises must restore DB records and matching private assets.

## Changed files and verification

- [CI](../.github/workflows/ci.yml) and [deployment job](../.github/workflows/deploy.yml)
- [Change classifier](../scripts/ci_changes.py) and [release packager](../scripts/package_release.py)
- [Server installer](../infra/install-server.sh), [upload script](../infra/upload-release.sh),
  [activation controller](../infra/deploy.py), [environment template](../.env.example)
- [Production TLS/static configuration](../apps/api/config/settings/production.py)
  and [configuration regression tests](../apps/api/tests/test_configuration.py)
- [Architecture baseline](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
  and [infrastructure TLS policy](initial/Indoor_Navigation_Infrastructure_Integration_EN.md#32-tls-and-certificate-verification)
- [Release failure tests](../infra/tests/test_deploy.py),
  [package/input tests](../infra/tests/test_package_release.py),
  [infrastructure entrypoint](../infra/README.md)
- [CI feature record](ci.md); contributor history remains in ignored `local/ACTIONS.md`.

Local verification covers failed migrations, private/public health failures,
previous-release preservation, successful promotion/drain, frontend-only reuse,
rollback without migrations, unsafe release IDs and documentation/bytecode
exclusion. Linux systemd/Caddy execution, actual Tiger grants/TLS, real Actions
execution, service reboot persistence and production recovery still require the
first deployment rehearsal. No live deployment is claimed.

October 17 local result: 50 tests passed; 16 PostgreSQL-only cases skipped under
the local SQLite test profile. Ruff lint/format, Bash syntax, actionlint workflow
validation and Git whitespace checks passed. Action commits were checked against
their official GitHub tags. The existing staged schema documentation was preserved.

The requesting contributor subsequently approved consolidating production
configuration into one `api.env`. Regression coverage also checks migration
connection selection, a missing migration connection failing before Django starts,
and normal management/API processes excluding the migration variable. No dependency
or service-topology change accompanies this configuration simplification.

Demo TLS fix verification: all 18 configuration tests passed, including effective
Django/libpq options for the default and demo modes, demo deployment checks,
plaintext rejection, and URL/CA conflict rejection. Ruff lint/format and Git
whitespace checks passed. The VM environment and live release still need the
steps above; this local result does not claim a successful database connection.
