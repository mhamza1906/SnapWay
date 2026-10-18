# Frontend iteration: Google Maps, sessions and Developer workspace

Subsequent packaged-app UI work is maintained in the single
[mobile visitor UI record](mobile-visitor-ui.md). It replaces the visitor entry's
default map with a dedicated journey screen; the website retains `/map`.

Updated October 17, 2026. Active branch: `feature/frontend-iteration`.
The latest [authentication modes](authentication-modes.md) update defines the new
`/sign-in` card entry, direct Developer workspace/Public User placeholder landing,
retained `/welcome` account page, session-mode API and controlled administrator
provisioning. It supersedes the earlier login-entry behavior recorded
below. The active [Developer workspace](developer-workspace.md) now replaces the
prototype menus/storage with Explore, My maps, role-aware authoring, administrator
contribution review, pinned editing snapshots and server-owned exports.
Merged remote main through PR #10 (`67db1fe`, graph editor / R2 media) into this
branch after the earlier PR #9 single-env baseline. Main's later schema-map
commit `7c8ea30` was also merged without conflicts as `e753f57`. Personal execution history
remains in ignored `local/ACTIONS.md`.

Implementation commit:
[`1f6f7cc`](https://github.com/mhamza1906/SnapWay/commit/1f6f7cc)
(included in this branch's Google integration merge).

Merge preparation preserves `feature/frontend-iteration` for subsequent work.
Integration PR: [#11](https://github.com/mhamza1906/SnapWay/pull/11), with the
current CI and merge status available there. Multi-floor discovery fixtures now
set explicit `Floor.sort_order` values and verify that order, avoiding accidental
dependence on randomly generated target UUIDs across database/OS profiles.
The incoming [schema renderer](assets/database-schema/render.py) needed import
sorting and long-string wrapping to pass the existing root Ruff gates. Its AST
is equivalent after import-order normalization; all saved catalog/DOT/SVG/HTML
artifacts remain unchanged. No diagram regeneration or database access was used.

Main has automatic production deployment enabled. The production owner must
reconcile `/etc/indoor-nav/api.env` to contract `2026-10-17.6` and the appropriate
production Google credentials/restrictions before activating this release. A
local credential check is not evidence of a synchronized server env. The existing
deployment gate must remain enabled; an old server contract must block activation
rather than accepting missing configuration. PR checks and production activation
are separate outcomes.

### Merge and production verification

PR [#11](https://github.com/mhamza1906/SnapWay/pull/11) merged into main as
[`a0e6d79`](https://github.com/mhamza1906/SnapWay/commit/a0e6d79). All seven PR
checks passed in [run 39064393074](https://github.com/mhamza1906/SnapWay/actions/runs/39064393074),
including Linux, Windows and PostgreSQL. The retained iteration branch was
fast-forwarded to that merge; subsequent acceptance notes continue here.

Main [run 39064525583](https://github.com/mhamza1906/SnapWay/actions/runs/39064525583)
passed all checks, packaging and automatic production activation. Independent
HTTPS checks confirmed the exact new release, database readiness and both new
public endpoints return HTTP 200. The public config currently reports **no Maps
browser key** and **Google OAuth disabled**; discovery has zero published buildings.
Deployment success therefore does not establish working production Google services.

The deployment owner must populate `PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY`,
`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the existing protected
`/etc/indoor-nav/api.env`, reconcile the full `.6` contract, and restart the active
Django service through the operations process. Use a production website-restricted
Maps key and register the HTTPS OAuth callback listed below. Obtain values through
the external private channel; do not blindly upload the laptop env or replace
production database/Django secrets. Reload the browser after restart and run a
production map/login smoke test. The remote private env was not inspected or
modified during this merge. Local credentials remain only in ignored `local/.env`.

Production OAuth follow-up at the time of diagnosis: the contributor reported credentials on the
server, and the Console screenshot includes the correct HTTPS callback. Public
checks still return `google_enabled: false` and HTTP 500 at
`/accounts/google/login/`. The failure occurs before a Google consent round trip.
Check the running API unit's `EnvironmentFiles` path, the exact
`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` key names and nonempty
values, then restart the running API unit after any private-file edit. Production
settings depend on systemd-injected variables; they do not read a release-local
`.env` or `local/.env`. Do not print the private file or process environment.
If failure persists, inspect the server traceback privately; its exception type
and sanitized stack are needed to establish the cause of HTTP 500. File presence
alone does not prove the current process loaded its values. No remote shell
session or server configuration change was performed in this check.
The contributor subsequently confirmed repair; a fresh public configuration check
now reports Google login and Maps enabled. No remote configuration was changed by
this frontend authentication iteration.

## Scope

Follow the [architecture](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
and [single-env contract](environment-sync.md). No new dependency or identity
provider is required. [Django allauth](backend-oauth.md) owns Google identity and
sessions; database membership owns authorization. Maps uses an independent
restricted browser key. The application now opens a real Google map by default
and uses the real Django session for Google sign-in, account display and logout.
Ordinary email/password registration with verified email remains future work;
the current backend enables social login only. No new dependency was introduced.

## Connected application behavior

Local recovery/navigation correction: a running Django process returned 500 from
`/api/client-config/` because its loaded settings lacked
`PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY`, despite the current source defining it.
Restarting the verified project Django process restored HTTP 200 directly and
through the Angular proxy on both localhost and 127.0.0.1. Restart Django after
branch changes affecting settings rather than relying only on its autoreloader.
No private env value or backend API contract was changed for this repair.

The map header's **Open workspace** now enters `/overview` and its complete
sidebar instead of bypassing it for the fullscreen graph editor. That editor
also provides **Back to workspace**. Existing target, contribution, AI authoring,
review, activity, settings and help routes were preserved and individually opened
through their visible navigation links. They retain their documented prototype
versus backend-connected boundaries. The existing map regression test now checks
the workspace destination; all 70 frontend tests and the web build pass.

Design iteration direction: the requesting contributor's explicit page and
interaction requirements govern the next redesign, preserving existing API
contracts. The optional personal `frontend-design` and `angular-developer`
downloads under ignored `local/skills/` are inactive references and should not
be proactively loaded unless explicitly requested again. They were never
registered for automatic skill discovery; this is a workflow preference, not
an application dependency change.

- `/` redirects to `/map`: a public Google map, building/address search, clickable
  published-building markers, floor summaries and Google Maps walking directions.
  Only buildings with a current, non-invalidated publication on an open target
  and a valid stored coordinate pair are exposed. Prototype buildings never
  become geographic markers. Multiple published floors share one building marker.
- Without location permission, the map shows published building bounds or an
  explicitly labeled Toronto default area. **Use my location** requests browser
  Geolocation; an already-granted permission can recenter automatically. Accuracy,
  denial, timeout and unavailable-device states are handled. No GPS cookie or
  localStorage value is written, and SnapWay does not upload/save location.
  Centering Google Maps necessarily sends viewport/map requests to Google.
- `/welcome` offers Google sign-in and a public visitor path. Its same-origin
  CSRF-protected form POST starts existing allauth OAuth with PKCE. The callback
  returns through `/auth/complete`, verifies the session, and restores a validated
  local return path. Cancellations and provider errors have recovery links.
- Contributor routes check the server session before entry. Profile and membership
  labels use `/api/auth/me/`; role switches have been removed from the shell and
  Settings. Successful logout clears the server session via CSRF-protected POST.
  Browser storage does not establish identity or grant a backend role.
- Existing local authoring/review/overview pages remain labeled workspace previews.
  Their prototype data is not migrated, published or cleared by this integration.
  The connected graph editor continues to use its existing backend API. Its
  existing create/resume demo draft behavior can create an owned target and grant
  that target's creator membership; ordinary Google login alone does not.

### Additive API surfaces

Existing graph/auth/navigation API payloads remain unchanged. No schema migration
is required. The two new read-only endpoints are:

| Endpoint | Public response and boundary |
| --- | --- |
| `GET /api/client-config/` | `{maps: {browser_key, map_id}, auth: {google_enabled}}`; exact allowlist, no-store, no OAuth client secret, database URL or environment dump |
| `GET /api/maps/public/buildings/` | `{buildings: [{id, name, address, latitude, longitude, floors: [{target_id, name, code, publication_id, sequence}]}]}`; no draft geometry, source images, creator identities, memberships or private instructions |

`GET /api/auth/me/` now also ensures Django's CSRF cookie and prohibits caching;
its JSON shape is preserved. Angular's existing default XSRF names already match
Django (`XSRF-TOKEN` / `X-XSRF-TOKEN`). Public endpoints do not require a login.

### Current acceptance and remaining boundaries

- Live browser acceptance passed on `http://127.0.0.1:4200`: root-to-map routing,
  real Google tiles, server-session profile, logout, anonymous route guard,
  Google-button sign-in, Google callback and return to requested `/settings`.
  No shared building, draft or publication was created for these checks.
- The real public API currently returns **zero** eligible buildings. The honest
  empty state is verified. Marker selection, stored-coordinate usage, floor
  details, search and walking-link construction use isolated test fixtures, not
  fabricated shared data. A map owner must populate real Building coordinates and
  publish reviewed content before live building-marker acceptance.
- Location success/accuracy and denial are covered offline. The real desktop
  browser location button was exercised and returned the unavailable/timeout
  recovery message, without a location fix. Successful live GPS remains pending
  the contributor's device test. Coordinates are not included in reports.
- Outdoor walking directions currently open Google Maps using its official URL
  interface. In-app route polylines/turn instructions still require the planned
  Routes API integration; straight lines are not presented as real routes.
- Public floor summaries are connected; indoor photo/camera route playback is a
  separate navigation workstream, not falsely linked to local sample maps.
- The visitor bundle opens the public map and retains `/navigate` as an explicitly
  labeled navigation preview; contributor modules are excluded. Native Capacitor
  API origin, mobile Google credentials/referrer handling and device permissions
  require platform acceptance. A localhost web test does not prove native or
  deployed production connectivity.
- This work does not deploy the feature or update the production env. Ordinary
  email/password signup, email verification and recovery await the backend auth
  contract and mail delivery; no simulated success is offered.

Verification: 70 frontend tests pass; web and visitor production builds, Prettier
and Android asset/plugin sync pass. The focused backend/env/probe suite passed 28
tests; the repository API/MCP/infra suite passed 126 with 16 PostgreSQL-only skips.
The six Google integration tests were rerun after strengthening multi-floor
fixtures and passed. PostgreSQL itself was not rerun locally. Node pipeline tests
passed 152 with 18 optional-fixture skips. Ruff lint/format, Django system check,
no-new-migrations check, env validation, all 14 original-document inventories and
10 immutable audit artifacts pass. On this Windows checkout, 26 pre-existing
frontend files required line-ending normalization for Prettier; Git normalization
confirmed no additional committed content changes for those untouched files.
Graph protocols, provider behavior and dependencies were preserved.

Default map evidence, captured before the GPS attempt with the account header
excluded: [map homepage](assets/2026-10-17-google-integration/map-home.png).

## Google Cloud Console steps

Select the dedicated SnapWay project in the top project selector. Confirm its
linked billing account is active. Then complete the following setup.

### Maps

1. Open [API Library](https://console.cloud.google.com/apis/library), search
   **Maps JavaScript API**, open it and select **Enable** (or **Manage** if enabled).
2. Open [Credentials](https://console.cloud.google.com/apis/credentials), select
   **Create credentials > API key**, edit it and name it `snapway-web-dev`.
3. Under **Application restrictions > Websites**, add:

   ```text
   http://127.0.0.1:4200/*
   http://localhost:4200/*
   http://127.0.0.1:4201/*
   http://localhost:4201/*
   ```

4. Under **API restrictions > Restrict key**, select only **Maps JavaScript API**,
   then **Save**. Restrictions may take time to propagate.
5. Copy the key to `PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY` in `local/.env`. Keep
   `GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID` for the first advanced-marker test. A custom ID
   can later be created under **Google Maps Platform > Map Management > Create
   Map ID**, type **JavaScript**. A map ID is not an API key or project ID.

Production uses a separate browser key restricted to `https://snapway.work/*`
(and `https://www.snapway.work/*` only if served), stored under the same env key
on the server. Browser Maps keys necessarily reach the browser; restrict both
websites and allowed APIs. Never expose OAuth secrets or other server settings.

GPS uses browser Geolocation permission, requiring HTTPS or a trusted local
origin. It does not require a cookie or Google Geolocation API. Markers at known
coordinates need neither Places nor Geocoding. Later outdoor route calculation
needs **Routes API** and a separate server credential; Places API (New) is needed
only for place lookup/autocomplete. Neither is required for this probe. A browser
test does not validate future native mobile key restrictions.

### Existing OAuth client

1. Open [Google Auth Platform > Clients](https://console.cloud.google.com/auth/clients)
   and select the existing **Web application** client. Google sign-in does not
   need an additional OAuth API key, Firebase, Identity Platform or People API.
2. Under **Authorized JavaScript origins**, add `http://127.0.0.1:4200` and
   `http://localhost:4200` without paths or wildcards. This server-side flow
   primarily depends on exact redirect URIs; origins alone do not authorize them.
3. Under **Authorized redirect URIs**, add:

   ```text
   http://127.0.0.1:4200/accounts/google/login/callback/
   http://localhost:4200/accounts/google/login/callback/
   http://127.0.0.1:8000/accounts/google/login/callback/
   http://localhost:8000/accounts/google/login/callback/
   https://snapway.work/accounts/google/login/callback/
   ```

   Add a www callback only if login is served there. Preserve trailing slashes,
   host and port. Do not mix localhost and 127.0.0.1 within one login attempt.
4. **Save**. Check [Branding](https://console.cloud.google.com/auth/branding) for
   app name, support email and developer contact. Check
   [Audience](https://console.cloud.google.com/auth/audience) for the intended
   account population; for External/Testing, add participating accounts under
   **Test users > Add users** when applicable. Internal organization-only clients
   cannot serve unrelated external teammates.
5. Review [Data Access](https://console.cloud.google.com/auth/scopes): only
   `openid`, email and profile are needed. No Maps scopes are needed.
6. Copy the Client ID and Client secret to `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET` in `local/.env`. Keep the secret server-side.

## Private configuration handoff

Main's contract **2026-10-17.4** already added the seven `S3_*` object-storage
fields (63 keys). This branch's contract **2026-10-17.5** adds two Maps fields
(65 total keys): `PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY=` and
`GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID`. Existing OAuth fields are reused. This machine
is aligned with all previous private values preserved; other members and
production await owner confirmation.
Distribute the template through Git and real values through the external private
channel. Local/production restricted Maps keys and map IDs may differ by host;
OAuth client differences require an explicit named exception.

Current contract is **2026-10-17.6**, still **65 keys**. It also correctly classifies
`S3_ENDPOINT_URL` and `S3_BUCKET_NAME` as private account/resource identifiers with
blank public placeholders, instead of forcing configured values to equal empty
shared defaults. All this machine's real values were retained unchanged, and
`env_contract.py check` now passes. Obtain the matching commit/template and schema
version through Git; real changed credentials, if any, come only through the
external channel. No credential rotation is needed for this classification fix.
Production owners must align its schema before promotion and restart Django so
the new browser-config view/settings are loaded.

The two old root Google templates are retired. `python scripts/env_contract.py
migrate` consolidates `local/env/web.env` and `local/env/google-auth.env`, maps
`PUBLIC_GOOGLE_OAUTH_CLIENT_ID` to `GOOGLE_OAUTH_CLIENT_ID`, and rejects conflicting
values before removing old files. Known scaffold origin/scopes and blank unused
project/callback settings are discarded. Nondefault retired settings require
private review. Django derives callbacks from the request and scopes from code.

Validate with `python scripts/env_contract.py check`. Restart Django after OAuth
changes and reload the probe after Maps changes. Review shell overrides by key
name: they take precedence. Deployment owners must align the same template/key
set in `/etc/indoor-nav/api.env`, validate its production profile and restart
affected services through the deployment process. No live server was changed.

## Smoke test and acceptance

Run from the repository root:

```sh
python scripts/env_contract.py check
python scripts/google_maps_smoke.py --check
python scripts/google_maps_smoke.py
# In another terminal, after reviewing database readiness:
python scripts/dev.py api
```

Open `http://127.0.0.1:4201/`, select **Load Google Map** once, verify real tiles,
the explicit Toronto test marker and its click popup. Select **Use my location**,
approve browser permission and inspect accuracy. Reload/deny once to check the
failure message. The test point is not a published building; GPS is not persisted.

Open `http://127.0.0.1:8000/accounts/google/login/`, confirm the local form and
complete Google consent personally. In the same browser session verify
`/api/auth/me/` reports the linked account without unexpected staff/membership.
Repeat through port 4200 only with Angular and its proxy running. Logout requires
a CSRF-protected POST. Review pending migrations first: a successful first login
can create account/session rows. Do not reset or migrate a shared database blindly.

The initial preparation had empty credentials; the contributor has since supplied
Google credentials and run live probes. Prior local Maps evidence records rendered
tiles and a visible marker; marker interaction and GPS acceptance remain incomplete.
The contributor reports database SELECT 1, liveness and readiness passing, and an
anonymous session response before sign-in. These do not prove completed OAuth.

### Observed OAuth blocker: exact callback registration

The Google error page was independently inspected in the existing browser tab.
Its **error details** reports `Error 400: redirect_uri_mismatch` with:

```text
redirect_uri=http://127.0.0.1:8000/accounts/google/login/callback/
```

Register this exact URL under **Google Auth Platform > Clients > the Web
application matching the running client ID > Authorized redirect URIs > Add URI >
Save**. Adding it only to JavaScript origins or Maps referrers cannot fix this
error. A port-4200 callback or localhost callback does not cover 127.0.0.1:8000.
After propagation, begin a fresh login from the local login page rather than
refreshing the old Google error/callback URL. Then inspect `/api/auth/me/` on the
same host for `authenticated: true`. The registration error alone does not
validate the client secret; the final session result below completes this check.
No OAuth client setting or credential was modified during diagnosis.

Retest after the contributor saved the callback registration: a fresh local
login confirmation now reaches Google's **Choose an account** screen for
**SnapWay Development**, replacing the previous redirect mismatch. Account
selection and consent were completed by the contributor. Independent HTTP
checks returned 200 for `/api/health/live/` and `/api/health/ready/`, with
`checks.database: ok`. These health results do not substitute for a completed
login. No credential or Console setting was changed during the retest.

Final local OAuth acceptance: after Google returned to
`http://127.0.0.1:8000/api/auth/me/`, the browser displayed **HTTP 200 OK** with
`authenticated: true`, `is_staff: false`, `is_superuser: false` and an empty
membership list. The agent independently verified these fields and reloaded the
page, confirming the authenticated session persisted. This completes the local
direct-Django Google login smoke test, including a successful callback/session;
private codes, tokens and account identifiers were not recorded in this document.
No map role or administrator privilege was granted. Angular proxy login on port
4200, production/native login and live logout remain unverified; the current
session was retained for further development. Maps interaction/GPS acceptance
remain separate from this OAuth result.

Subsequent frontend diagnosis inspected another live Google error: its rejected
callback was `http://localhost:4200/accounts/google/login/callback/`. The earlier
successful frontend session used `127.0.0.1:4200`; that registration does not cover
`localhost:4200`. Add the exact localhost callback to the same running OAuth
client's **Authorized redirect URIs**, preserve the existing entries, save, and
start a fresh login from `http://localhost:4200/welcome`. Alternatively, keep
development on the already validated `http://127.0.0.1:4200/` origin. These hosts
also have separate browser sessions. No application, env-template, private-env or
Console setting was changed during this diagnosis. The contributor subsequently
confirmed the callback configuration was repaired and authorized pushing and
merging these updates. This is contributor-reported resolution; the previously
recorded agent-observed login acceptance remains specific to 127.0.0.1.

The earlier local env validator separately reported shared-default drift for
`S3_ENDPOINT_URL` and `S3_BUCKET_NAME`. Values were not printed or overwritten.
The `.6` classification fix above resolves this false-positive drift while
preserving actual values. It was separate from Google's callback rejection; no
OAuth credential rotation was needed.

Maps uses usage billing without requiring an optional subscription. Budget alerts
do not cap spending. Restrict keys, set available per-API quotas and avoid repeated
map loads. Stopping local development does not revoke a key or stop deployed callers.

## Changed files and official references

Implementation: [template](../.env.example), [migration](../scripts/env_contract.py),
[probe server](../scripts/google_maps_smoke.py), [probe page](../scripts/google_maps_smoke.html),
[probe checks](../apps/api/tests/test_google_maps_smoke.py),
[env checks](../apps/api/tests/test_env_contract.py),
[web onboarding](../apps/web/README.md), [env handoff](environment-sync.md).

| Connected behavior | Actual implementation |
| --- | --- |
| Session, guard and Google form | [auth service](../apps/web/src/app/core/auth.service.ts), [auth tests](../apps/web/src/app/core/auth.service.spec.ts), [login page](../apps/web/src/app/features/welcome/welcome.ts), [login styling](../apps/web/src/app/features/welcome/welcome.scss), [callback page](../apps/web/src/app/features/welcome/auth-complete.ts) |
| Public map and discovery | [component](../apps/web/src/app/features/map/map.ts), [template](../apps/web/src/app/features/map/map.html), [styles](../apps/web/src/app/features/map/map.scss), [tests](../apps/web/src/app/features/map/map.spec.ts), [SDK loader](../apps/web/src/app/core/google-maps.service.ts), [runtime config client](../apps/web/src/app/core/client-config.service.ts) |
| App entry and identity | [routes](../apps/web/src/app/app.routes.ts), [shell](../apps/web/src/app/app.ts), [shell template](../apps/web/src/app/app.html), [shell tests](../apps/web/src/app/app.spec.ts), [settings](../apps/web/src/app/features/settings/settings.ts), [settings template](../apps/web/src/app/features/settings/settings.html), [visitor entry](../apps/web/src/main.visitor.ts), [graph editor return link](../apps/web/src/app/features/graph-editor/graph-editor.html) |
| Server config and public metadata | [settings](../apps/api/config/settings/base.py), [config view](../apps/api/config/views.py), [config URL](../apps/api/config/urls.py), [building view](../apps/api/maps/views.py), [building URL](../apps/api/maps/urls.py), [integration tests](../apps/api/tests/test_google_integration.py) |
| Session CSRF and OAuth recovery | [session view](../apps/api/accounts/views.py), [provider error](../apps/api/accounts/templates/socialaccount/authentication_error.html), [cancelled login](../apps/api/accounts/templates/socialaccount/login_cancelled.html) |

Official references reviewed October 17, 2026:
[Maps setup](https://developers.google.com/maps/documentation/javascript/get-api-key),
[key restrictions](https://developers.google.com/maps/api-security-best-practices),
[advanced markers](https://developers.google.com/maps/documentation/javascript/advanced-markers/start),
[browser location](https://developers.google.com/maps/documentation/javascript/geolocation),
[walking-direction URLs](https://developers.google.com/maps/documentation/urls/get-started),
[OAuth web flow](https://developers.google.com/identity/protocols/oauth2/web-server),
[Maps billing](https://developers.google.com/maps/billing-and-pricing/overview).
