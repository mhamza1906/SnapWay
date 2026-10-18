# Indoor Navigation Infrastructure and Identity Integration

**Status:** Architecture and integration preparation; no accounts, infrastructure, credentials, dependencies, or deployments have been configured by this document.  
**Research date:** October 16, 2026  
**Owners:** `{{PLATFORM_OWNER}}`, `{{APP_OWNER}}`; review by `{{QA_LEAD}}`  
**Related records:** [Architecture and dependencies](Indoor_Navigation_Architecture_and_Dependencies_EN.md), [acceptance plan](Indoor_Navigation_Acceptance_and_Test_Plan_EN.md), [test catalogue](Indoor_Navigation_Test_Catalog_EN.md), and [configuration template](.env.example).

This guide covers Angular, Django, Android packaging with Capacitor, Tiger Data/PostgreSQL, Vultr, GoDaddy, and Google authentication. AI providers and Google Maps have separate integration notes. All procedure steps describe future execution. Examples use reserved domains and placeholders. Environment names describe the application's planned configuration contract; setting them does nothing until the settings/build code explicitly reads them.

**Delivery constraint:** use native Ubuntu services, cached dependencies, and versioned release artifacts for fast repackaging and deployment. Docker, Compose, and container rebuild workflows are excluded from this implementation plan. Personal experiments, scripts, downloaded references, test outputs, logs, and personal `SKILL.md` files belong under the ignored workspace `local/` directory. This document creates no runtime files or services.

## 1. Decisions, verified capabilities, and remaining checks

| Area | Proposed project decision | Verified documentation | Account or implementation check still required |
|---|---|---|---|
| Frontend | Angular; web editor and public navigation share libraries, with a separate Android navigation entry/build | Angular publishes runtime and TypeScript compatibility by release | Clean build, browser support, and native integration with the selected lockfile |
| Backend | Django 5.2 LTS with Django REST framework; one application with explicit modules, plus a worker process | Django supports PostgreSQL; DRF supports Django 5.2 | Resolve current compatible package patches, run migrations and permission tests |
| Mobile | Capacitor 8 Android package; native functionality behind adapters | Capacitor has Android runtime and official camera/geolocation APIs | Exact plugin peers, SDK/Gradle/JDK combination, and real-device behavior |
| Database | Tiger Cloud hosts the production PostgreSQL database; local PostgreSQL is a development/test counterpart | Tiger Data uses PostgreSQL clients and extensions | Actual service PostgreSQL version, extension versions, TLS certificate support, limits, network access, and recovery options |
| Deployment | One Vultr Ubuntu VM; systemd manages Caddy, Gunicorn, Celery, private MCP, and local Redis; release artifacts reuse cached virtual environments | Vultr supports VM provisioning; Gunicorn and Caddy document systemd operation | Region/capacity, service isolation, measured release switching, and phone connectivity |
| Domain | GoDaddy registration/DNS; a project subdomain points to the VM | GoDaddy supports A/AAAA records | Whether GoDaddy is actually authoritative for the selected domain |
| Authentication | Google login for web administrators/volunteers, Django sessions, server-owned role assignments; public navigation works without login | allauth supports Google's OAuth flow | Consent configuration, exact redirects, two-account tests, CSRF, and backend authorization |

**Tiger Data + PostgreSQL means a managed PostgreSQL deployment, not two production databases to synchronize.** Do not add a second production PostgreSQL instance on Vultr. A separate local/test database gives isolated development without modifying shared demo data. Timescale-specific hypertables are not needed for the initial map/revision/navigation model. [Tiger Data overview](https://www.tigerdata.com/docs)

## 2. Local toolchain and dependency preparation

### 2.1 Candidate compatibility baseline

These are proposed compatible families, not a tested lockfile or a claim that each is the latest major release.

| Component | Candidate | Selection rule |
|---|---|---|
| Node.js | Current patched 24.x, at least 24.15 | One version across development and CI; production serves prebuilt frontend files |
| Angular | 21.2.x core, CLI, compiler, router, forms, HTTP packages | Keep Angular package versions aligned; retain a supported release |
| TypeScript / RxJS | TypeScript 5.9.x; RxJS 7.x | Stay within Angular 21's published compatibility ranges |
| Python / Django | Patched Python 3.12.x; patched Django 5.2.x LTS | One Python minor locally, in CI, and in native Ubuntu virtual environments |
| Django REST framework | Current supported stable release explicitly compatible with Django 5.2 | Resolve and lock after reviewing release notes; do not combine an old tutorial pin with an assumed current stack |
| PostgreSQL driver | Psycopg 3; `psycopg[binary]` for the first reproducible build | Record bundled libpq/OpenSSL versions; use `psycopg[pool]` only if an application pool is selected |
| Authentication | `django-allauth[socialaccount]`, compatible stable release | Use the installed release's setup instructions and provider settings |
| Capacitor | Matching 8.x `@capacitor/core`, `@capacitor/cli`, and `@capacitor/android` | Pin exact versions together; plugin versions follow their peer requirements |
| Android tools | Android Studio 2025.2.1 or newer; installed Android SDK; generated compatible Gradle wrapper/JDK | Capacitor 8's initial guide targets SDK 36; inspect the selected 8.x template before freezing tool versions |
| Local database | PostgreSQL 17 candidate; match the actual chosen Tiger Cloud major before acceptance | Use a local native installation or isolated test service; install required extensions explicitly |
| Deployment | Supported Ubuntu LTS, proposed 24.04; systemd, Python venv, Caddy 2, Redis | Record OS/package/runtime versions; releases use source/static artifacts and checksums |

Angular 21 permits Node 24, TypeScript 5.9, and RxJS 7; its compatibility table also lists newer Angular releases, so this is a stability choice. Capacitor 8 requires Node 22 or newer and documents its Android tool requirements. Python 3.12 is supported by Django 5.2, DRF, and allauth. [Angular compatibility](https://angular.dev/reference/versions), [Angular support](https://angular.dev/reference/releases), [Capacitor 8 migration](https://capacitorjs.com/docs/updating/8-0), [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup), [Django compatibility](https://docs.djangoproject.com/en/5.2/faq/install/), [DRF requirements](https://www.django-rest-framework.org/), [DRF release notes](https://www.django-rest-framework.org/community/release-notes/), [allauth requirements](https://docs.allauth.org/en/latest/installation/requirements.html)

### 2.2 Ordered local setup, to execute later

1. Record OS, CPU architecture, Node, npm, Python, Java/Gradle, Android SDK, and device/WebView versions in an environment manifest. Use Windows Android Studio for Android; use the Linux CI runner or an independent Ubuntu VM for systemd/worker deployment parity. WSL is optional.
2. Create isolated frontend/backend directories and dependency manifests. Resolve exact package patches once, generate lockfiles, and commit those lockfiles. Bootstrap with `npm ci` after a lockfile exists; use the chosen Python locked-install workflow. Reuse a validated dependency environment while its lockfile/runtime key remains unchanged; recreate it on a key change or missing/invalid cache. Do not use floating `latest` in the deployment procedure.
3. Use a Python virtual environment locally, with personal trial environments under `local/env/`. Install backend core dependencies only during the later setup task, with storage, AI, and optional native capabilities kept identifiable in dependency groups.
4. Start local PostgreSQL using an isolated data directory and credentials, with its listener bound to loopback; alternatively use an explicitly isolated test service. Provision `vector` only for the selected PostgreSQL vector-search profile; NumPy semantic retrieval does not require it. Keep automated test databases separate from shared demo data.
5. Implement settings parsing from a private file under `local/env/` with explicit boolean/list parsing. Missing required secrets must produce a named configuration error without printing the value. Production uses protected service environment files and rejects local-only defaults.
6. Run initial Django migrations with the migration connection, run `check`, and serve a minimal API. Angular uses a local dev proxy for `/api/` and `/accounts/` where practical, so browser session/CSRF testing resembles the production origin.
7. Build a tiny navigation page, initialize Capacitor, add Android, set the actual Angular output directory as `webDir`, then run `npx cap sync android` and open/build it with Android Studio. These steps are future commands, not completed work.
8. Install the APK on a physical Android device. Test one capture and one HTTPS upload before introducing map generation or localization. Record cancellation, permission denial, orientation, upload size, background/resume, and connectivity results.

### 2.3 Infrastructure-facing library list

| Purpose | Planned package/tool | Required now or conditional |
|---|---|---|
| Web application | Angular packages, RxJS, TypeScript, Angular CLI | Baseline |
| Android bridge | `@capacitor/core`, `@capacitor/android`, `@capacitor/cli` | Baseline |
| Capture and lifecycle | `@capacitor-community/camera-preview`, `@capacitor/app`; optional `@capacitor/camera` | Embedded preview is the initial candidate; official system-camera/picker fallback needs Activity restoration and does not itself satisfy live-preview acceptance |
| Coarse outdoor location | `@capacitor/geolocation` | When outdoor/nearby-building flow is enabled |
| API and ORM | `Django`, `djangorestframework`, `psycopg` | Baseline |
| Auth | `django-allauth[socialaccount]` | Google login baseline |
| Configuration | `django-environ` or one equivalent parser | Choose one; no duplicate settings systems |
| Allowed cross-origin clients | `django-cors-headers` | APK/web cross-origin HTTP path |
| Production serving | `gunicorn` for the proposed WSGI API | Baseline; select an ASGI server separately if later needed |
| Durable jobs | Selected queue library plus its client, e.g. Celery with Redis transport | Align with the architecture plan; no public broker port |
| Media validation | Pillow | Baseline; decode/validate actual bytes rather than trusting extensions |
| S3-compatible media | `django-storages[s3]` / Boto3 | Conditional on selecting object storage |
| Embedding storage | `pgvector` Python package and database `vector` extension | When the vector-search adapter is selected |
| Delivery | systemd, Python venv, Caddy, Git, SSH, rsync or artifact upload/download, CI runner | Baseline; no image build or container registry |
| Verification | pytest/pytest-django, frontend unit runner, Playwright, Android tooling | According to the acceptance plan; real-device cases remain physical checks |

AI, editing, Maps, and experimental navigation dependencies belong in their respective architecture/dependency sections. Keep experimental SLAM/CUDA dependencies in a separate environment when their research track is enabled.

## 3. Tiger Cloud PostgreSQL integration

### 3.1 Account and connection preparation

1. `{{PLATFORM_OWNER}}` selects a Tiger Cloud project/service and records its region, PostgreSQL major, service identity, available extension versions, connection limit, certificate behavior, backup retention, and recovery controls. The service must meet the signed-TLS gate below before it carries production data.
2. Retrieve host, port, database, and administrator credentials from the service's connection panel or initial credentials download. The port is service-specific; do not replace it with `5432` by assumption. Keep a personal credential download under ignored `local/env/`, outside version control; production copies belong in the protected server secret store. [Tiger connection details](https://www.tigerdata.com/docs/integrate/find-connection-details)
3. Create an application/migration ownership strategy in a dedicated application schema. Keep service-administrator credentials for provisioning/extensions. Use a migration role owning application tables and a runtime role with only required schema usage, table DML, and sequence access. Apply default grants for new migration-created objects. The worker receives runtime access to jobs/assets/results, not schema-creation authority.
4. Record and test the exact permissions using both roles. Runtime must fail to create/drop schemas or change role memberships. Test newly created tables/sequences as well as the initial migration, because missing default grants often appear only after the second deployment.
5. Use the direct endpoint initially for API/worker and always retain a direct migration/maintenance endpoint. Set connection and query timeouts. Count API threads, worker concurrency, test tools, and maintenance connections against the actual service limit.
6. If service network controls are available, restrict inbound database access to the Vultr egress IP and explicitly required developer/CI egress. Test allowed and denied sources. A Vultr VPC is not automatically privately connected to Tiger's cloud network. Tiger documents IP allow lists and separate VPC connectivity options; their availability must be checked in the account. [Tiger IP allow lists](https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/security/ip-allow-list), [Tiger VPC connectivity](https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/security/vpc)

### 3.2 TLS and certificate verification

**Deployment policy:** use `PGSSLMODE=verify-full`, the exact service DNS hostname, and a trusted root source. For a libpq 16+ client, Tiger documents `sslrootcert=system`; for other client builds, use a vetted CA bundle at a protected host path readable by the API, worker, and migration service identities. Test permissions under the actual service user.

**Approved demo exception, October 17, 2026:** the requesting contributor explicitly
approved encrypted `require` connections without server identity verification for
the current Free-plan demo. The [deployment record](../deployment.md#free-plan-demo-tls)
contains the runtime/migration configuration and restoration steps. This exception
does not replace the verified-TLS gate before storing production data.

Tiger states that a newly created service can initially use a self-signed certificate, with a signed certificate normally replacing it after roughly 30 minutes, and that free services do not provide SSL certificates. Verify the selected service's certificate capability rather than treating every account as equivalent. Outside the approved demo exception above, a failed hostname/CA check is a readiness blocker; do not change to `disable` or `require` merely to get a green result. [Tiger strict TLS instructions](https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/security/strict-ssl)

PostgreSQL distinguishes encrypted transport from verified identity: `verify-full` checks the trusted chain and hostname. Record the libpq version bundled with the installed Psycopg build, and test the same configuration in the deployed Linux virtual environment. [PostgreSQL TLS verification](https://www.postgresql.org/docs/current/libpq-ssl.html)

Proposed runtime mapping:

| Setting | Intended meaning |
|---|---|
| `DATABASE_URL` | Runtime application role and selected direct/session/transaction endpoint |
| `DATABASE_MIGRATION_URL` | Direct endpoint, migration role; injected only into controlled migration jobs |
| `PGSSLMODE` | `verify-full` in cloud; a separate explicit local profile may use `disable` only for isolated loopback development |
| `PGSSLROOTCERT` | `system` after checking libpq support, or a protected host CA path readable by the service |
| `DATABASE_CONN_MAX_AGE` | Start with `0`; tune only with connection-limit evidence |
| `DATABASE_DISABLE_SERVER_SIDE_CURSORS` | `true` if using transaction pooling |
| `DATABASE_CONNECT_TIMEOUT` | Proposed application setting for a finite libpq connection timeout |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Proposed application/role setting; separate migration timeout if needed |

Explicitly pass parsed TLS settings into Django's database options and reject contradictory URL query parameters. Percent-encode special characters in URL credentials. Do not log URLs. Use a password prompt/protected password file for diagnostic `psql` sessions instead of putting passwords in shell history.

### 3.3 Extensions and vector retrieval

Tiger's current extension catalogue lists pgvector, pgvectorscale, PostGIS, and pgRouting as available but not enabled by default. Availability does not prove activation or a particular version in the selected database. The initial app only needs ordinary relational/JSONB tables; `vector` is enabled when the embedding-search adapter needs it. PostGIS, pgRouting, and hypertables are optional decisions. [Tiger extension catalogue](https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/tiger-cloud-extensions)

Future SQL verification, run against the intended service:

```sql
SELECT version();
SELECT current_database(), current_user;
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name IN ('vector', 'vectorscale', 'postgis', 'pgrouting');

-- Provisioning/migration owner only, after checking availability:
CREATE EXTENSION IF NOT EXISTS vector;

SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('vector', 'vectorscale', 'postgis', 'pgrouting');
```

Add a tiny known-vector query and a real text-embedding round trip to the later smoke test. Store embedding model identity, dimensions, input normalization, and source revision. Changing the model or dimensions creates a new/rebuilt index; never compare vectors from incompatible embedding spaces. The selected model dimension must fit both the type and the selected index's limits. An application-level exact search over a bounded dataset is an explicit fallback, with its own latency evidence.

### 3.4 Pooling and migrations

Tiger supports PgBouncer session and transaction pools. Its documented examples use a different port for the pooler and a different database name for transaction mode. Copy every endpoint from the console; never derive a production port or append `_transaction` by guesswork. Pool provisioning is optional and account-dependent. [Tiger connection pooling](https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/service-management/connection-pooling)

For transaction pooling, Django requires attention to server-side cursors; use `DISABLE_SERVER_SIDE_CURSORS=True` on that connection. Avoid session-dependent behavior unless explicitly tested. Django also advises disabling persistent connections under ASGI. Do not combine an application pool, long persistent connections, and a provider pool without a capacity calculation. [Django database behavior](https://docs.djangoproject.com/en/5.2/ref/databases/)

The release workflow runs migrations once, with the direct migration URL, before compatible application promotion. API and worker startup must not race each other running migrations. Review the migration plan, take the required recovery point, apply it in staging, then check a runtime-role read/write and publication transaction. Code rollback does not reverse a database migration; prefer additive changes and maintain the documented previous-release compatibility window.

## 4. Media storage and persistence

Store original floor-plan scans, normalized bitmaps, vector exports, photos, and derived images as assets. PostgreSQL stores their keys, digests, dimensions, ownership, revision association, processing status, and structured map/scene records. Do not put base64 image bodies into ordinary JSONB map records. Published asset paths must be immutable or content-addressed so a new merge cannot change an old revision's visual evidence.

Choose one initial storage adapter:

| Option | Integration | Limitation / acceptance |
|---|---|---|
| Persistent VM media directory | `/srv/indoor-nav/shared/media` is accessible to API/worker with appropriate permissions; controlled downloads and off-VM backup | Simpler first demo, but single-host recovery and disk capacity must be tested |
| Vultr Object Storage | Private S3-compatible bucket; backend writes with Boto3/django-storages; authorized short-lived download links | Adds one managed service; test the exact supported S3 operations and bucket policies |

For object storage, select region, create separate environment bucket/prefixes, obtain the endpoint and S3 credentials, and configure HTTPS, Signature V4, bucket, region, and addressing style. The endpoint comes from the actual subscription. Keep access keys server-side, and keep uploaded drafts/captures private. Vultr documents S3 compatibility but warns that not every feature from another S3 service is present. [Vultr storage setup and security](https://docs.vultr.com/platform/security-best-practices/vultr-object-storage), [Vultr storage documentation](https://docs.vultr.com/products/storage/object-storage)

Django 5.2 uses `STORAGES` for storage-backend configuration; the S3 backend accepts endpoint, region, and addressing options. Map the project's `S3_*` variables explicitly into its `OPTIONS`. [django-storages S3 backend](https://django-storages.readthedocs.io/en/stable/backends/amazon-S3.html)

For the first spike, upload through Django with bounded file size, MIME/decoded-image validation, randomized keys, and permission checks. If direct presigned upload is later enabled, add expiration, prefix/content constraints where supported, and backend completion validation before the asset can enter a contribution. Failed DB writes must leave recoverable/quarantined assets, not a falsely published revision. Test both orphan cleanup and retention of assets referenced by historical releases.

## 5. Google OAuth 2.0 and application authorization

### 5.1 Chosen browser flow

Administrator/volunteer browser → Django login entry → Google consent → Django callback → Django session → Angular application. Google establishes identity; the database decides map membership and roles. A Google account, email domain, or client-supplied role never grants administrator powers automatically. The first administrator is assigned through a controlled setup operation; map-specific permissions are checked on every API and MCP mutation.

Public navigation remains anonymous. A visitor can read a published map and receive a narrowly scoped navigation session/capability for their captures and results. Guest session ownership and limits are enforced server-side. Google login is not a prerequisite for obtaining a route.

### 5.2 Google Cloud setup order

1. Select/create the project for the application and record its identifier. Separate development and production OAuth clients; using separate projects is also possible if the team needs complete isolation.
2. Open Google Auth Platform **Branding** and configure the app name, support/developer contacts, authorized domain, and applicable application/privacy links. Use real project-owned URLs before release.
3. Set **Audience**. Use External for a mixed team of ordinary Google accounts; Internal only fits the relevant Workspace organization. Add the intended test accounts while in Testing. Verify the project's actual audience restrictions rather than assuming a consumer and university account behave identically.
4. Under **Data Access**, request basic sign-in identity only: `openid`, `email`, `profile`. Do not request Drive, Gmail, or offline account access for this feature. Consent configuration uses Branding, Audience, and Data Access in the current console. [Google consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent), [Google sign-in setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid), [audience behavior](https://support.google.com/cloud/answer/15549945?hl=en)
5. Create a **Web application** OAuth client. Add exact redirect URIs from the table below, including scheme, hostname, port, path, and final slash. Origins, if required for the selected Google web integration, contain only scheme/host/port, not a callback path. A server-redirect flow does not require adding an unrelated JavaScript SDK.
6. Store its client ID and secret in backend configuration. The ID is an identifier; the secret is private. API keys for Maps/Gemini and OAuth client secrets are different credentials.
7. Run local and deployed OAuth tests with two identities. Test consent denial, wrong state, expired session, logout, and attempted cross-map access. Preserve only redacted traces.

Google requires redirect values to match the registered value; the authorization-code exchange belongs on the backend for this flow. [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)

| Environment | External entry | Callback registration example |
|---|---|---|
| Local backend auth spike | `http://localhost:8000` | `http://localhost:8000/accounts/google/login/callback/` |
| Local frontend proxy, if used for auth | `http://localhost:4200` | `http://localhost:4200/accounts/google/login/callback/` only if the proxy forwards the callback and preserves the intended external host |
| Deployed web application | `https://nav.example.com` | `https://nav.example.com/accounts/google/login/callback/` |

Choose one local route and keep it consistent. `localhost` and `127.0.0.1` are different registered hosts. The production callback goes to Django through the reverse proxy, even though it shares the frontend's domain. The allauth Google provider documents this callback convention. [allauth Google provider](https://docs.allauth.org/en/latest/socialaccount/providers/google.html)

### 5.3 Django/allauth implementation checklist

1. Add Django auth/session/message apps plus `allauth`, `allauth.account`, `allauth.socialaccount`, and the Google provider. Add the allauth authentication backend and account middleware as required by the installed version, and the request template context processor.
2. Include `allauth.urls` under `accounts/`; ensure the proxy forwards it to Django before the Angular SPA fallback. Apply package migrations.
3. Configure the Google provider using the settings-based `APP` configuration populated from `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`. Choose one credential source; do not also create a duplicate SocialApp for the same provider/client. Enable provider PKCE, basic scopes, and online access. [allauth quickstart](https://docs.allauth.org/en/latest/installation/quickstart.html)
4. Use the framework's CSRF-protected login/logout flow; do not invent a GET endpoint that mutates an authenticated session. Return to an allowed internal path after login; reject untrusted redirect targets.
5. Use DRF SessionAuthentication for browser protected endpoints and explicit permission classes. Login endpoints need their own CSRF protection; an anonymous API request does not automatically receive all protection from DRF's session authenticator. Test object ownership as well as role labels. [DRF authentication](https://www.django-rest-framework.org/api-guide/authentication/)
6. For same-origin Angular HTTP calls, align Angular's XSRF cookie/header names with Django, or configure the client to use `csrftoken` and `X-CSRFToken`. Provide a normal CSRF bootstrap response. The session cookie remains HttpOnly; do not make it readable to JavaScript to solve XSRF handling. [Angular XSRF configuration](https://angular.dev/api/common/http/withXsrfConfiguration), [Django CSRF integration](https://docs.djangoproject.com/en/5.2/howto/csrf/)
7. Production uses secure session/CSRF cookies, appropriate SameSite policy for the selected redirect flow, `DEBUG=False`, explicit allowed hosts, and trusted origins with scheme. Trust forwarded HTTPS headers only from the controlled reverse proxy. Verify that Django generates an HTTPS callback. [Django deployment checklist](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/)
8. Record an account-linking policy. Do not silently link an existing privileged account using an unverified email claim. Confirm that a newly created Google account has no map-management permissions until the application grants them.

### 5.4 Android boundary

The baseline APK only needs public navigation; administrator/volunteer login remains in the browser. Do not load Google's login page inside the application's ordinary embedded WebView and assume that it shares Django's browser session.

If authenticated native functions become required, select and test a separate supported Android sign-in flow. Android's current guidance uses Credential Manager with Sign in with Google. Register the Android package and signing identities as required by that flow, request a backend-audience token, verify it on the server, and exchange it for a bounded application session. Keep OAuth client secrets out of the APK. Debug and release signatures need separate verification. [Android Sign in with Google](https://developer.android.com/identity/sign-in/credential-manager-siwg)

Native authentication is a conditional extension, with app-return/cancellation/logout/expired-token tests. It does not alter the requirement that guests can navigate.

## 6. Angular/Capacitor origins and native integration

Bundle compiled frontend assets into the APK. `webDir` must point to the actual build folder containing `index.html`, not the Angular source directory. Capacitor documents `server.url` as a development/live-reload setting rather than the production packaging approach. Android defaults to a local HTTPS scheme and `localhost`, so `https://localhost` is the expected starting origin, not a guaranteed origin for every customized build. Capture the actual request `Origin` during the spike. [Capacitor configuration](https://capacitorjs.com/docs/config)

| Client | API path/configuration | Identity and request protection |
|---|---|---|
| Production browser | Relative `/api/` on `https://nav.example.com` | Same-origin Django session and CSRF for protected writes |
| Local Angular | Dev proxy to Django, or narrowly allowed development origin | Confirm cookie and CSRF behavior for the chosen method |
| Packaged Android | Absolute `https://nav.example.com/api/` | Public data plus a scoped guest session for private captures/jobs; exact CORS allowlist for WebView fetch |
| Future authenticated native client | Explicit selected auth exchange | Server-verified native identity and application token; separately tested lifecycle |

Do not copy all server variables into an Angular environment file. `PUBLIC_API_BASE_URL`, display flags, and restricted client-side Maps identifiers may be public; database URLs, OAuth secrets, signing keys, and AI keys must never be distributed. CORS is a browser transport rule, not authorization: native HTTP clients may not enforce it, so API permissions/rate limits remain mandatory.

Use the camera adapter to return a file/URI or bounded upload representation, normalize EXIF orientation, and attach capture context. The official Camera plugin notes that Android can terminate the app while a separate camera activity runs; handle `appRestoredResult` where required. Store capture data only for its declared lifecycle. [Capacitor Camera API](https://capacitorjs.com/docs/apis/camera)

Continuous frames, gyroscope/pressure readings, and AR/SLAM are separate adapters and gates. A one-shot Camera integration is not evidence that streaming frames, pose tracking, or background operation works. Never infer barometer availability from Android OS version alone.

## 7. Vultr, GoDaddy, native services, and rapid delivery

### 7.1 Prepare a deployment target

1. Select a region near the field demo and reasonably close to Tiger Cloud; measure request and DB latency rather than assuming that matching city labels imply private networking.
2. Create the later deployment record: instance type, CPU/RAM/disk, OS, region, SSH public key, firewall group, backup choice, and operator. Initial candidate: supported Ubuntu 24.04 LTS, one VM, no GPU requirement. Vultr's console supports image, SSH-key, firewall, public-IP, and backup selections. [Vultr instance provisioning](https://docs.vultr.com/products/compute/instances/cloud-compute/provisioning)
3. Use a non-root operator with SSH keys. Allow SSH only from agreed administrative sources; public TCP 80/443 reach Caddy. Bind API, MCP, and Redis to loopback or Unix sockets, and keep Caddy's administration endpoint private. Apply equivalent firewall rules to IPv6 if enabled. [Vultr firewall groups](https://docs.vultr.com/products/network/firewall-groups)
4. During implementation, prepare native Python/venv, Caddy, Redis, and systemd service units once. Record package versions and service users. System package upgrades are a separate maintenance task rather than part of every code release. Gunicorn documents virtual environments and systemd supervision. [Gunicorn deployment](https://gunicorn.org/deploy/)
5. Store runtime secrets outside releases and the repository, proposed `/etc/indoor-nav/api.env`, `worker.env`, `mcp.env`, and a separately controlled migration configuration. Generate each file from an explicit variable allowlist, restrict its permissions, and reference it from the intended service. A frontend artifact contains only approved public configuration.

### 7.2 DNS sequence

1. Confirm the authoritative nameservers for the chosen domain. If GoDaddy only registers it and another provider hosts DNS, update records at that authoritative provider.
2. Create an unused project subdomain, e.g. `nav.example.com`, with an A record to the Vultr public IPv4. Avoid changing an existing unrelated website record. GoDaddy's DNS UI uses the subdomain prefix as Name and the address as Value. Use its offered TTL, e.g. the documented one-hour default, or a shorter supported cutover value. [GoDaddy A records](https://www.godaddy.com/en-ca/help/add-or-edit-an-a-record-42546)
3. Add AAAA only when the VM, firewall, and HTTPS service are actually reachable over IPv6; otherwise omit it. A stale AAAA can make some clients fail even while IPv4 works. [GoDaddy AAAA records](https://www.godaddy.com/en-ca/help/add-an-aaaa-record-19214)
4. Check authoritative and public resolver answers, then test from phone Wi-Fi and cellular. Record resolution results and timestamps before diagnosing application errors as code defects.
5. No GoDaddy API key is required for this manual DNS workflow. Keep domain-control credentials separate from application runtime configuration.

### 7.3 Service topology and persistent paths

| Service | Exposure | Persistence / role |
|---|---|---|
| Caddy | Public 80/443 | Native service; read-only frontend/static assets; persistent certificate state |
| Gunicorn API | Proposed blue/green slots `127.0.0.1:8101` and `127.0.0.1:8102`; Unix sockets are an alternative | Explicit backend release directory and cached venv; Django/DRF; runtime DB role |
| Celery worker | No public listener | Same backend release and venv as selected by its service manifest; relevant provider keys |
| MCP service | `http://127.0.0.1:8001/mcp` only | Dedicated process/unit; short-lived signed caller delegation and per-map authorization remain required |
| Redis | `127.0.0.1:6379` | Native service with configured persistence/access; PostgreSQL remains authoritative for job status |
| PostgreSQL | Tiger Cloud external managed endpoint | No second production PostgreSQL service on the VM |

Proposed host layout:

```text
/srv/indoor-nav/releases/<release-id>/      # immutable code, web bundle, release manifest
/srv/indoor-nav/current                   # selected complete-release symlink
/srv/indoor-nav/venvs/<dependency-key>/    # environment built at this final absolute path
/srv/indoor-nav/shared/static/            # retain release/hash-qualified Django assets
/srv/indoor-nav/shared/media/             # private/published immutable assets
/srv/indoor-nav/shared/indexes/           # indexes keyed by model/map revision
/etc/indoor-nav/                          # protected per-service env/config
/run/indoor-nav/                          # ephemeral sockets/PIDs, created by service setup
```

Use explicit `WorkingDirectory` and venv executable paths in each service; never rely on an interactive shell having activated a venv. Build a new dependency-keyed venv only when the lockfile/runtime changes or a valid environment is missing. Create it at its final absolute path and mark it usable only after installation/validation finishes. Python documents virtual environments as non-portable; do not upload a Windows venv or relocate a CI venv to the server. [Python venv behavior](https://docs.python.org/3.12/library/venv.html)

The reverse proxy routes `/api/*`, `/accounts/*`, and `/admin/*` to Django before SPA fallback. Serve `/django-static/*` from persistent collected assets; the configured root is `/srv/indoor-nav/shared/static`, with release/hash-qualified content retained for active and rollback releases. Prepare a release-specific static manifest without clearing assets still used by the previous release. Serve Angular from the selected immutable frontend directory and preserve earlier hashed chunks long enough for already-open clients. Unknown API routes return API errors, not SPA HTML. Private media and private MCP never enter the generic static/public route.

Caddy's documented systemd service keeps state under `/var/lib/caddy`; retain its certificate/config state across application releases. Validate configuration and use its graceful reload for routing changes. DNS must point to the VM and required ports must be reachable before automatic HTTPS succeeds. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy native service and reload](https://caddyserver.com/docs/running)

Service ordering is not application readiness. Bound restarts, expose separate liveness/readiness checks, and handle delayed database/broker/provider availability. Long AI work belongs in Celery with bounded task deadlines. Configure stop timeouts to accommodate the declared request/task deadlines instead of forcibly terminating valid work after a generic short timeout.

### 7.4 Change-aware CI and dependency reuse

GitHub Actions is the selected planned CI host; no workflow has been implemented. Use a single required orchestrator that detects changed inputs and runs affected jobs. Separate frontend, backend, Android, and deployment artifacts. Documentation-only changes need no app rebuild. Shared schemas, generated clients, configuration interfaces, authentication, and dependency changes invalidate their dependent jobs. Skipped component jobs must have a recorded reuse decision; an unchanged directory alone is insufficient if its shared inputs changed.

| Changed inputs | Build/test decision | Deployment action |
|---|---|---|
| Angular source/style/template only | Reuse exact-key dependencies; restore Angular build cache; build/test affected frontend target | Upload frontend artifact, update release reference; no Python install or worker restart |
| Backend source/Prompt only | Reuse backend venv; selected backend/AI regression; package new source and Prompt versions | Activate affected API/worker/MCP code; no Angular build unless shared interface changes |
| Frontend lockfile/toolchain/config | Create/restore matching frontend dependency environment; run its compatibility tests and build | Deliver new frontend artifact; no unrelated Python installation |
| Backend lockfile/Python/native ABI | Create a new backend venv key, validate dependencies, run backend regression | Select new venv with new processes; preserve old venv for rollback |
| Schema migration | Check migration plan and old/new code compatibility, staging migration/rollback test | One controlled migration step; then compatible service promotion |
| Android source/plugin/navigation bundle | Reuse Gradle/npm caches where valid; sync/build/test APK | Produce identified APK artifact; website/backend do not redeploy unless affected |
| Shared contract or public build configuration | Invalidate every affected consumer, even if its own directory is unchanged | Publish a compatible component set with explicit identities |

**Dependency cache keys:** hash the component lockfile plus relevant package manifest/config, OS, architecture, runtime version, package-manager version, and install options. Exact validated `node_modules` cache hits can skip frontend installation; an npm download cache alone cannot. On a missing/invalid dependency tree run `npm ci`, which creates a clean locked installation. Python runtime environments similarly reuse only an exact compatible completed venv; cached wheels merely accelerate a necessary installation. Never reuse a partial-key environment as if exact. [GitHub cache keys and exact hits](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching), [npm clean install](https://docs.npmjs.com/cli/commands/npm-ci/)

Enable Angular's cache for CI explicitly (`cli.cache.environment` set to `ci` or `all`) and cache its configured directory. This accelerates repeated builds but does not turn arbitrary source patches into safely deployable partial bundles; emit a complete validated frontend artifact for each affected target. The exact saved artifact may be reused only when all declared build inputs match. [Angular build cache](https://angular.dev/cli/cache)

Package immutable release artifacts with checksums and a manifest containing commit, component revisions, lockfile hashes, runtime key, build/public-config identity, migration range, and reused artifact identities. Publish artifacts separately from caches: artifacts are delivery inputs, while caches are disposable performance aids. Pin reviewed CI action versions. GitHub Actions' official artifact mechanism provides upload/download and digest checking. Transfer the selected artifacts to Vultr with SSH/rsync or an equivalent checksum-verified upload. [GitHub workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)

Serialize deployment per target with one concurrency group and a server-side deployment lock. Cancel superseded build jobs if desired; never cancel an already-running migration or partially completed promotion merely because another commit arrives. An always-running aggregate check prevents path-filtered required checks from remaining unresolved. [GitHub workflow conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [deployment concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

### 7.5 Release activation, worker drain, and rollback

1. Upload only changed artifacts into a new release directory; verify their digests and attach validated references to unchanged artifacts. Do not overwrite files in the active release. Resolve the backend venv by its dependency key; unchanged dependencies skip installation.
2. Under the deployment lock, check runtime configuration, file permissions, DB/storage access, and migration compatibility. Retain the previous release/venv/static assets and record a recovery point before any destructive data change.
3. When required, run migrations once through the direct migration connection. Prefer additive migrations compatible with both old and new service processes. Destructive changes require their explicit staged migration/recovery procedure before promotion.
4. Start the candidate Gunicorn process from the explicit new release and venv, on a private candidate socket/port. Smoke-test it without sending public traffic. The candidate may temporarily coexist with the previous API if capacity permits. For a frontend-only change, skip this step and retain the existing API identity.
5. If worker code changes, stop consumption by the old worker and let running jobs finish within their configured limits. Terminate with `TERM` for warm shutdown, then start the selected worker release. Start a replacement first only when payload/schema compatibility and duplicate-delivery behavior have been validated. Keep durable job states/idempotency and late-result checks through this transition. Celery recommends supervised TERM/start rather than HUP in production. [Celery shutdown and restart](https://docs.celeryq.dev/en/stable/userguide/workers.html)
6. Restart or replace the private MCP service when its code/config changes, preserving request authorization and rejecting stale draft revisions. MCP does not receive a new public route as part of deployment.
7. Atomically replace the `current` symlink on the same filesystem and gracefully reload Caddy's validated routes to the selected frontend/API. Coordinate these steps under the deployment lock and require a compatible old/new overlap; symlink replacement and proxy reconfiguration are not one cross-process transaction. Once smoke checks pass, allow the previous Gunicorn master to finish in-flight requests and stop it with `TERM`.
8. Gunicorn supports graceful `HUP` configuration/worker reload, including application reload when preloading is disabled. Use that fast path only after proving that the selected code path is reread and the interpreter/dependency/environment inputs are unchanged. Changing a symlink alone does not prove an existing master switched working directory or venv. A changed venv, environment, or release working directory uses the fresh candidate-process path above. [Gunicorn signals](https://gunicorn.org/signals/)
9. If capacity cannot support temporary overlap, use a measured graceful stop/start of the single API with a brief controlled unavailable response. Keep this as a declared fallback and record the interruption; do not claim zero downtime without measuring it.
10. On failed smoke tests, restore the previous compatible release pointer and proxy target, and start the corresponding old API/worker/MCP processes if needed. Keep data migrations intact only if they remain compatible; otherwise use the approved database recovery path. A symlink rollback never undoes a migration or deletes completed user work.

Define per-service readiness and release identifiers. Configure service supervision so the master first receives its graceful signal and child processes are not prematurely killed; for the proposed foreground master processes, verify `KillMode=mixed`, `KillSignal=SIGTERM`, and a `TimeoutStopSec` beyond the bounded drain period. Test forced-timeout behavior separately. Confirm options against the installed Ubuntu systemd version. [systemd process termination](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml), [systemd stop timeout](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)

Retain at least the active and last verified release and every venv/assets set they reference. Cleanup occurs only after proving no running process or retained revision references the target.

### 7.6 Independent deployment and recovery experiment

Prepare the personal probe under ignored `local/`, separate from actual map/navigation logic. It contains a static release page, a DB read/write endpoint, a bounded image upload/retrieval, and one durable worker job. Add real browser OAuth, a protected dummy action, private MCP reachability/denial checks, and a tiny APK capture/upload. A real AI connectivity smoke call is separate from any deterministic worker stub.

Exercise five releases: first install; frontend-only source change; backend-only source change; dependency-lock change; and a controlled failed release followed by rollback. Evidence must show which installs/builds/services were skipped, cache keys, exact artifact identities, end-to-end deployment times, in-flight job outcomes, and user-visible interruption. Test both cache-hit and clean/cache-miss paths. No absolute deployment-speed claim is accepted without this evidence.

The probe verifies infrastructure readiness at G1, not map quality, localization, or product E2E acceptance. Save redacted personal scripts/results/logs under ignored `local/`; commit only approved shared procedures, manifests/templates, and acceptance conclusions. All source/probe downloads remain within the designated local area.

Restore a DB backup into an isolated target and restore matching media/index manifests. Verify draft/publication/reference consistency and job ownership. A VM backup alone does not cover an external Tiger database or object bucket. Backup policy includes DB, persistent assets/index metadata, release manifests, protected configuration recovery, and APK signing continuity. `pg_dump`/`pg_restore` versions and extension support must match the chosen recovery path. [PostgreSQL backup/restore](https://www.postgresql.org/docs/current/backup-dump.html)

## 8. Environment inventory and handling

The root `.env.example` is a union inventory of configuration for several consumers, not a file to inject wholesale into every service. Use per-service allowlists. Angular does not automatically load this file; its build/runtime configuration generator must copy only explicitly approved public keys. The table below explains the relevant integration groups; update this guide and the parser together when names change. Real `.env` files, certificate private keys, credential exports, and signing keystores stay outside source control.

| Group | Variables / placeholders | Consumer |
|---|---|---|
| Deployment identity | `APP_ENV`, `APP_PUBLIC_URL`, `APP_RELEASE`, `PUBLIC_API_BASE_URL`, `PUBLIC_WEB_ORIGIN`, `PUBLIC_BUILD_SHA` | Server plus explicitly selected public build values |
| Django | `DJANGO_SECRET_KEY`, `DJANGO_DEBUG`, `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `CORS_ALLOWED_ORIGINS` | Backend only; values become concrete Django settings |
| Secure browser session | Production cookie/HTTPS settings in configuration; optional explicit `DJANGO_*` toggles | Backend/proxy integration, not client configuration |
| DB runtime/migration | `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `PGSSLMODE`, `PGSSLROOTCERT`, connection/cursor/timeout settings | API/worker; migration URL only in migration runner |
| Google web sign-in | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`; basic scope configuration | Django only for this chosen redirect flow |
| Media filesystem | `MEDIA_STORAGE_BACKEND`, `MEDIA_ROOT=/srv/indoor-nav/shared/media` | API/worker |
| Media S3 | `S3_ENDPOINT_URL`, `S3_REGION_NAME`, `S3_BUCKET_NAME`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, addressing option | API/worker when S3 is selected |
| Queue | `CELERY_BROKER_URL=redis://127.0.0.1:6379/0`, queue names, job deadlines and concurrency | API enqueue/worker; no frontend access |
| Private MCP | `MCP_INTERNAL_URL=http://127.0.0.1:8001/mcp`, `MCP_INTERNAL_AUDIENCE`, required `MCP_INTERNAL_SIGNING_KEY`, `MCP_DELEGATION_TTL_SECONDS` | Server-side agent signs delegation; adapter verifies audience, expiry, actor and current permissions |
| Derived indexes | `INDEX_ROOT=/srv/indoor-nav/shared/indexes`; model/map/version identity | Worker/localization service |
| HTTPS proxy | `CADDY_DOMAIN`, `ACME_EMAIL` | Proxy only |
| Django static assets | `STATIC_ROOT=/srv/indoor-nav/shared/static`, `STATIC_URL=/django-static/` | Django collectstatic/proxy; release-specific manifests and retained hashed assets |
| Android public build | `CAPACITOR_APP_ID`, `CAPACITOR_APP_NAME`, API base URL, capability flags | Capacitor/Angular build; all values are inspectable |
| Android signing | Keystore location, alias, and protected signing passwords in the build secret store | Release build only |
| Deployment access | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY_PATH`, `DEPLOY_ROOT=/srv/indoor-nav`, `RELEASE_ID`, `API_BLUE_PORT=8101`, `API_GREEN_PORT=8102`, artifact digests and dependency keys | Operator/CI release context; no registry/image variables |
| Infrastructure control | Vultr API key or GoDaddy credential only if automation is later selected | Separate operator/CI provisioning context; absent from application runtime |

Map `APP_PUBLIC_URL` to externally visible absolute URL generation. Parse allowed-host lists separately from origin lists: hosts do not include schemes, while CSRF/CORS origins do. A comma-separated string is not automatically a Django list. Do not interpolate secrets into frontend build output or an unrestricted public configuration endpoint.

Use `.env` only for the services that require each key. Produce narrowly scoped service environment files outside the repository; the systemd environment-file syntax is not an arbitrary shell script or a promise of dotenv expansion. Verify the actual loaded settings without printing secrets. A changed environment file requires the documented new-process/restart path. Test with synthetic sentinel values that no private key appears in the Angular distribution, source maps, APK, exception page, access log, or job evidence. [systemd execution and environment settings](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)

## 9. Smoke evidence and failure triage

All rows start **Not run**. Case IDs refer to the existing catalogue, not a new claim of acceptance.

| Integration check | Required evidence | Related cases |
|---|---|---|
| Clean setup | Tool/lockfile manifest, build output, named failure for missing configuration | OPS-01 |
| Fast repeat deployment | Frontend-only/backend-only/lockfile-change cases; cache keys/hits/misses; skipped installs; component/artifact identities and elapsed times | OPS-01/02/03 |
| DB identity/TLS | Redacted endpoint profile, server/driver versions, successful hostname/chain verification, wrong-CA/host rejection | OPS-01/02/04 |
| Role grants/migrations | Migration log; runtime DML succeeds; DDL/role changes fail; grants hold after a second migration | AUTH-02/03, OPS-06 |
| Database extensions | Available/installed extension versions, tiny vector query if enabled, no assumed model dimension | OPS-01, LOC/AI tests as applicable |
| OAuth and permissions | Two identities, real deployed callback, denial/state/logout behavior, forbidden map operation with no side effects | AUTH-01/02/03/06 |
| Guest APK requests | Actual origin, preflight result, private job isolation across two guests, upload/response on physical phone | AUTH-04/05, APP-01/02/03, OPS-04 |
| DNS and HTTPS | A/AAAA answers, certificate host/validity, Wi-Fi and cellular access, HTTP-to-HTTPS behavior | OPS-02/04 |
| Worker and asset lifecycle | Restart-safe job identity/status, restored photo bytes/digest, timeout/retry and stale-result behavior | JOB cases, OPS-05/07 |
| Native service switch | Candidate readiness, atomic release-pointer selection, proxy route identity, Gunicorn graceful drain, Celery task preservation and private MCP restart | JOB cases, OPS-04/06 |
| Publication consistency | One atomic current revision and coherent assets after new release/restart | GOV-03/08, OPS-05/06 |
| Recovery | Isolated DB + media restore, previous compatible artifact rollback, time/data consequences | OPS-05/06 |
| Secret boundaries | Synthetic-secret scan of bundle/APK/logs and proof that migration credentials are not runtime-injected | OPS-01/07 |

| Symptom | First checks | Safe next action |
|---|---|---|
| DB connection timeout | Host/port, egress IP, firewall/allow list, DNS, service state | Correct the connection/network profile; preserve a finite timeout |
| TLS chain/hostname error | Service certificate readiness, libpq/system trust support, CA path/read permissions, exact hostname | Repair trust/certificate setup; retain `verify-full` |
| Connection exhaustion | API threads, worker concurrency, maintenance sessions, selected pool limits | Bound concurrency or enable a verified pool; do not multiply pools blindly |
| Missing table/permission after deploy | Migration completion and owner/default grants | Run the approved migration/grant step with the intended role |
| OAuth redirect mismatch | Registered URI versus actual scheme/host/port/path/trailing slash | Correct the exact registration/proxy URL; do not add broad unneeded callbacks |
| Login succeeds but writes fail | CSRF header/cookie names, trusted origin, session cookie flags, actual backend permissions | Fix the specific transport or permission rule; do not disable CSRF |
| Browser works, APK fails | APK API base URL, actual Origin/preflight, certificate trust, device network | Fix absolute HTTPS endpoint and exact allowlist; retry on physical device |
| API returns HTML | Reverse-proxy matcher order and SPA fallback | Route API/auth/admin before SPA |
| Images disappear after release switch | Media accidentally written inside a release directory instead of shared media/object storage | Correct persistent path and restore from the verified backup |
| Old API code after symlink switch | Running master working directory, interpreter, loaded environment, release identity | Start the explicit candidate release process; do not assume HUP changes the venv |
| Celery job lost during deployment | Stop signal, task/stop deadlines, acknowledgement policy, durable job state | Repair drain/recovery behavior and repeat the in-flight job acceptance case |
| Dependencies reinstall on every change | Component cache key, exact-hit validation, unnecessary `npm ci`/pip step, venv lifetime | Reuse the validated unchanged environment; install only on key change or cache absence/invalidation |
| S3 signature/access error | Actual endpoint, region, credentials, addressing style, object policy, system clock | Correct the adapter configuration and run a private object round trip |
| Some phones cannot reach domain | Stale AAAA, IPv6 firewall/service, DNS cache | Repair IPv6 or remove the invalid AAAA; keep proven A record |

## 10. Handoff and completion criteria

`{{PLATFORM_OWNER}}` hands over the environment manifest, redacted endpoint/configuration inventory, dependency lockfiles/cache keys, systemd/release/proxy specification, role/grant strategy, graceful worker drain and rollback procedure, database/media recovery procedure, and smoke-run evidence. `{{APP_OWNER}}` hands over the web/APK build paths, change-aware build inputs, actual Android origin, plugin/device matrix, public configuration mapping, and capture/lifecycle results.

Infrastructure integration is complete only when the clean setup, actual cloud connection, real OAuth flow, phone-to-cloud probe, restart persistence, and isolated recovery checks pass. Model accuracy and indoor navigation quality remain governed by the product test plan. Any conditional integration still disabled is recorded as **Not implemented / not claimed**, with a named owner and entry test before activation.
