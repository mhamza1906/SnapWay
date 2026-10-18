# Main integration and shared mobile live matching

Updated October 18, 2026. Work remains on `feature/map-authoring-pipeline`.
Implementation: [ab0c726](https://github.com/mhamza1906/SnapWay/commit/ab0c726).
Review: [draft PR #22](https://github.com/mhamza1906/SnapWay/pull/22).
Merged main at [db168a3](https://github.com/mhamza1906/SnapWay/commit/db168a3)
into the existing feature work; Git main is unchanged. The local recovery branch
is `backup/map-authoring-before-mobile-main-20261018`. Personal execution history
and private backup locations remain in ignored `local/ACTIONS.md`.

## Experiences and preserved collection work

The website starts with main's Developer / Public User sign-in choices. Developer
mode retains this branch's shell, authoring tools, Sam Ibrahim project, 40-stop
ceiling, capture tools and R2 PDF links. Main's visitor experience is available at
`/public`, with its existing publication and routing rules. Main's newer workspace
pages remain additional routes. Server-owned modes and membership permissions
remain authoritative; Google identity does not grant map roles.

Saved `/graph-editor?target=...&mode=photos` links select the preserved phone walk
screen through [GraphEditorEntry](../apps/web/src/app/features/graph-editor/graph-editor-entry.ts).
Other editor links use main's advanced editor. OAuth and explicit experience
switching retain safe saved targets. Both native apps offer a visitor entry and
a developer option that opens the existing HTTPS website in the system browser.
Contributor code is excluded from the bundled visitor build.

After a consistent local database backup, merged migrations through maps 0008
were applied locally. All 11 Sam walks still report **302 active stops and 156
uploaded directions**. Existing node/photo identities, collection queue and
retired point numbers remain intact. Original SVG/PDF sources are unchanged.
The preserved architecture baseline was restored to its recorded hash; main's
approved published cross-floor extension remains documented in
[the visitor record](mobile-visitor-ui.md#published-photo-route-walkthrough).

Implementation: [shell](../apps/web/src/app/app.ts),
[template](../apps/web/src/app/app.html), [styles](../apps/web/src/app/app.scss),
[routes](../apps/web/src/app/app.routes.ts),
[auth/guards](../apps/web/src/app/core/auth.service.ts),
[sign-in](../apps/web/src/app/features/sign-in/sign-in.ts),
[callback](../apps/web/src/app/features/welcome/auth-complete.ts),
[experience switch](../apps/web/src/app/features/welcome/welcome.ts),
[native entry](../apps/web/src/app/features/mobile-entry/mobile-entry.ts),
[native routes](../apps/web/src/app/mobile.routes.ts),
[native bootstrap](../apps/web/src/main.visitor.ts).
The unchanged authoring implementation remains in
[authoring/](../apps/web/src/app/features/authoring/), while the preserved collector
and its tests/styles live in [photo-walk-editor/](../apps/web/src/app/features/photo-walk-editor/).
Main's [advanced editor](../apps/web/src/app/features/graph-editor/graph-editor.ts)
and [editor template](../apps/web/src/app/features/graph-editor/graph-editor.html)
remain separate from collection. The merged [graph client](../apps/web/src/app/core/graph-api.service.ts)
retains optimistic editing plus phone photo metadata; duplicate
[icon](../apps/web/src/app/shared/icon.ts) definitions were reconciled.

## Live matching on Android, iOS and the website

The shared [camera component](../apps/web/src/app/features/visitor/visitor-camera.ts)
supports a single photo and explicit Start / Stop live matching. The rear camera
supplies bounded JPEG frames; native sampling is 0.8 fps and browser sampling
waits at least 1.25 seconds after each result. This leaves headroom under the
existing 60/minute API budget. Only one request runs at a time; surplus native
frames are discarded. Browser samples carry monotonic elapsed timestamps.

Visitors bootstrap a scoped NavigationSession and use the existing Django
localization API. Release builds do not require an engine/developer token.
Results remain uncertain unless the matcher supports them. Main's
[visitor controller](../apps/web/src/app/features/visitor/visitor.ts) and
[template](../apps/web/src/app/features/visitor/visitor.html) keep live capture open,
show the latest supported suggestion, and require confirmation before routing.
There is no automatic route progress or continuous-position accuracy claim.

Camera permission is requested on opening capture, never on the landing screen.
Denied permission offers settings recovery. Capture stops on background,
interruption, offline state, serious thermal state, Stop and Close. Native cleanup
is serialized before restart, including encoder drain and temporary frame deletion.
Late results and stale native callbacks cannot restart capture or move selection.
No microphone permission, full-video recording or incoming-video retention was
added. The [route reuse policy](../apps/web/src/app/core/editor-route-reuse.ts)
destroys phone collection views on navigation so a hidden camera cannot remain active.

Native implementation: [shared bridge](../apps/web/src/app/core/frame-capture.ts),
[Android Camera2 plugin](../apps/web/android/app/src/main/java/org/snapway/app/FrameCapturePlugin.java),
[Android registration](../apps/web/android/app/src/main/java/org/snapway/app/MainActivity.java),
[Android permissions](../apps/web/android/app/src/main/AndroidManifest.xml),
[iOS plugin](../apps/web/ios/App/App/FrameCapturePlugin.swift).
Existing Capacitor 8 dependencies are reused; no package/lock changes were needed.

## Native networking and Google Maps

[Capacitor configuration](../apps/web/capacitor.config.ts) enables the existing
core CapacitorHttp transport for fetch/XHR, including multipart JPEG uploads.
[The native interceptor](../apps/web/src/app/core/native-api.interceptor.ts) keeps
API traffic on the existing HTTPS deployment without relying on developer cookies.
Direct WebView CORS preflights are a separate path; the bundled transport does not
need a wildcard CORS exception. See the
[official HTTP documentation](https://capacitorjs.com/docs/apis/http).

Native outdoor maps use a narrowly scoped hosted HTTPS map page, so the Maps
JavaScript SDK uses the restricted website key on its intended website origin.
Only public Maps configuration enters that page. Location updates use checked
parent/source/origin/channel messages and finite coordinate validation. Locations
and tokens never go in the iframe URL. Native Retry reloads the map document.
The browser map loader explicitly loads the marker library.

Implementation: [walking map](../apps/web/src/app/features/visitor/walking-map.ts),
[Google loader](../apps/web/src/app/core/google-maps.service.ts),
[hosted view](../apps/api/maps/views_mobile_map.py),
[hosted template](../apps/api/maps/templates/maps/mobile_map.html),
[URL](../apps/api/maps/urls.py). Website keys can fail for opaque/local native
origins; see [Google's key guidance](https://developers.google.com/maps/api-security-best-practices).
Actual Maps rendering and key restrictions still require physical-phone validation.

## Saved indexes and cloud boundary

Two owned photo-walk indexes are now registered and stored in R2: 104 Level 1
vectors and 52 Level 2 vectors, each 8,448 dimensions. The local CPU engine loads
them into RAM; repeated builds skip unchanged photos and catalog sync reuses loaded
indexes. The collector now exposes index status and an explicit camera test for
ready indexes. Draft tests do not publish the map or change graph geometry.

Photo-walk uploads declare walking-relative directions, preserving the meaning of
Front/Right/Back/Left without inventing absolute map bearings. Main's ordinary
editor retains plan-frame behavior. Source-raster dimensions do not overwrite
the imported SVG coordinate frame. Index status reads no longer acquire write
locks or alter edit versions, including on PostgreSQL.

Details, R2 hashes, eligibility and production gaps are recorded once in
[cloud readiness](cloud-integration-readiness.md). Backend changes:
[graph access](../apps/api/maps/services/graph.py),
[photo service](../apps/api/maps/services/references.py),
[transport](../apps/api/maps/views_graph.py),
[index status](../apps/api/maps/services/reference_index.py),
[importer](../apps/api/maps/management/commands/import_photo_walks.py).

The optional [runtime package](cloud-runtime-packaging.md) includes existing Node,
MegaLoc and Sam source components with reviewed unit templates. It installs or
enables nothing. An opt-in read-only GitHub Actions cloud audit uses existing CI
Vultr credentials; no contributor's local SSH key is required. Existing main-only
production deployment gates remain unchanged. Tiger Data is still the production
metadata target; local map records have not been copied there. Publishing inferred
Sam connections or exposing the standalone Node API is not an integration shortcut.

The local env consolidation stopped safely on the undocumented
`NAVIGATION_SESSION_RATE` key. Original private files/values remain unchanged after
a private backup. Reconcile that unused key with the external configuration owner
against schema `2026-10-17.6`, then rerun the existing env migration/check. No new
secret, env key or schema version was introduced.

## Validation

- 217 frontend tests pass; production website and visitor builds pass.
- 234 tests pass on an isolated local PostgreSQL database, including real database
  constraints. SQLite passes 215 cases with 19 expected PostgreSQL skips.
- 233 pipeline tests pass, with 18 optional-fixture skips; 41 Sam project tests pass.
- 38 cloud packaging/controller/audit tests pass, including Windows Git Bash
  selection and committed-byte preservation with `core.autocrlf=true`.
- Android Java compilation, lint and debug APK build pass; unsigned iOS simulator
  build passes. Both platforms receive the final visitor bundle and native HTTP config.
- Ruff, formatting, 14 preserved-document checks and 10 immutable audit checks pass.
- Real HTTP checks confirm 11 walks / 302 stops / 156 uploaded directions, two ready
  indexes, read-only index status, hosted map HTTP 200 and a real-engine signed
  node match for an exact existing reference. This is transport integrity, not a
  held-out localization accuracy measurement.

Regression coverage includes [routes](../apps/web/src/app/app.routes.spec.ts),
[entry selection](../apps/web/src/app/features/graph-editor/graph-editor-entry.spec.ts),
[native landing](../apps/web/src/app/features/mobile-entry/mobile-entry.spec.ts),
[OAuth](../apps/web/src/app/core/auth.service.spec.ts),
[callback](../apps/web/src/app/features/welcome/auth-complete.spec.ts),
[mode switch](../apps/web/src/app/features/welcome/welcome.spec.ts),
[camera](../apps/web/src/app/features/visitor/visitor-camera.spec.ts),
[visitor flow](../apps/web/src/app/features/visitor/visitor.spec.ts),
[hosted map bridge](../apps/web/src/app/features/visitor/walking-map.spec.ts),
[route lifecycle](../apps/web/src/app/core/editor-route-reuse.spec.ts),
[hosted map headers](../apps/api/tests/test_mobile_map.py),
[photo/import](../apps/api/tests/test_node_media.py),
[direction frames](../apps/api/tests/test_editor_gestures.py),
[read-only index status](../apps/api/tests/test_reference_index.py),
[package](../infra/tests/test_package_release.py) and
[CI audit](../infra/tests/test_cloud_readiness.py).

No computer/browser automation was used. Physical camera permission, orientation,
background/restart, cellular transport, Maps display and independent live location
accuracy remain device acceptance checks. No production release, production data
transfer, new cloud resource, paid AI call or model download occurred locally.

The read-only GitHub Actions cloud audit succeeded without a local SSH key; see
[the observed runtime/capacity results](cloud-integration-readiness.md#deployment-work-still-required).
