# Mobile visitor navigation UI

Updated October 18, 2026. Authenticated web `/public` now hosts this visitor journey
on `feature/merged-integration` (modes handoff from [authentication-modes.md](authentication-modes.md)).
Feature work originated on `feature/frontend-user`; implementation
commits include `a0564a9` and `ca59f45`; heading spacing and local Android packaging
notes are recorded in `1407e12`; the publication-fixture correction is in `57e8b26`.
The installed-app API connection below is pending commit.
Personal execution details remain in ignored `local/ACTIONS.md`.

The October 18 [camera-to-node integration](localization-visitor-match.md#camera-result-to-confirmed-visitor-node)
now returns a validated node object, shows its label/floor/building inside the
indoor panel and preserves that exact node through confirmation and routing.
Its API contract, changed files and validation are maintained in the linked
localization feature record; this extension is pending deployment.

## Entry points and interaction

The existing Angular/Capacitor architecture and locked dependencies are retained.
Anonymous website discovery still starts at `/map`. Signed-in Public Users land
on `/public` (same destination-first visitor journey) after Google sign-in; `/map`
and `/navigate` redirect them there. The separate Capacitor visitor build starts
at the destination-first screen and redirects `/map` and `/navigate` there. It
excludes contributor features. `/app-preview` in the web build explicitly previews
the installed-app layout for Developers; viewport width does not switch the website
into that experience.
`/app-review` remains a compatibility redirect to `/app-preview`.

**Find your destination** sits beside the existing SnapWay route mark in a single
vertically aligned header row, with the 32 px logo on the left and a 20 px heading.
The row has 12 px of additional top margin.
The two search fields remain on the same row beneath it. Each field has a separate
underline, without a filled box or rounded border. An 18 px gap separates the wider Building field from
Room. Focus strengthens the underline; the disabled room field has a muted line.
The fields use **Search building** and **Room number** as placeholders, with
Building/Room accessible names retained for assistive technology. Input text is
14 px; a 44 px field with 5 px bottom padding brings the underline closer to the
text while preserving the touch target. Each field opens matching suggestions as the
visitor types, ignoring case, spaces and punctuation. Building search accepts its
code, name or address; room search accepts the selected building's room number or
name, including a building code prefix. A suggestion must be chosen to establish a
selection; typing alone does not start navigation.

Room is disabled until a building is chosen and searches only that building's
available rooms. Editing the chosen building immediately clears the selection and
room query; the visitor chooses another building suggestion before searching rooms.
Suggestions support pointer selection, Arrow keys, Enter, Escape and Tab/blur.
The shared autocomplete has empty-result feedback and exposes combobox/listbox
relationships and the active suggestion to assistive technology. Building suggestions now come only from the database-backed directory below.
A real published room suggestion is required before navigation starts.

The Google map uses walking-scale zoom 17. The visitor's approximate-location
marker is red (`#dc3c35`); the destination building marker is blue (`#2563eb`).
Each uses its own local SVG pin with a white border/center, passed to the existing
AdvancedMarkerElement content option. Marker titles retain **Your approximate
location** and **Destination building** so meaning is available beyond color. No location question appears on initial load. Selecting a stored building enables room selection when published rooms exist;
selecting a room completes the destination.
A complete destination starts the journey and covers the map
with **Are you inside [destination building name]?**, using the selected destination's
actual building name. The search fields are replaced by a red cancel SVG button
(accessible name **Cancel navigation**) and **Finish**. The icon retains a 44 px
tap target. Cancelling returns silently to search, without a cancellation status
message. The original taller active panel is preserved (730 px high with an
89 px header at a 390 by 844 viewport). The search header is compact, with an
additional 12 px top margin requested for the logo/heading row; its map starts
12 px lower while retaining the same panel height. Map, inside/outside question and indoor photo panels share a
viewport-based height, reserving 114 px for header/footer, with a 320 px minimum
and safe-area adjustments. Footer content cannot shrink the panel. Longer footer messages remain
in the page flow rather than squeezing the panel.
There is no
second destination confirmation or disabled destination button. **Open Google Maps**
launches outdoor walking navigation. Google supplies the
outdoor route; SnapWay does not draw an invented route or claim an entrance-level
coordinate where the database supplies only a building coordinate.

**Yes, I'm inside** immediately opens the camera screen and asks for permission
if needed. The dialog is centered both horizontally and vertically, has rounded
corners on all sides, and uses up to 640 px of width with safe-area margins. Its
preview is substantially taller (up to 560 px, sized to the available viewport),
while the title, capture button and short hint remain available; short screens can
scroll the dialog. Under **Show us where you are**, the camera preview leads directly to
**Take photo**, followed by one hint: **Keep a nearby sign or landmark clearly in
view and hold your phone steady.** The photo shows the visitor's current scene to
find their starting position, not the destination room. **Take photo** captures/submits
one fresh photo; opening the camera alone does not submit a photo. **No, I'm outside** keeps the walking map available.
The bundled sample catalog and capture-only demo branch have been removed.
Every actual capture now follows the existing localization transport.

GPS is used for the outdoor map; it does not automatically reopen the question or
infer indoor entry. The previous proximity-triggered prompt was removed to follow
the contributor's destination-selection-only design. **Location options** can
manually reopen the same building-specific prompt after destination selection,
including after **Back to outdoor map**. It is hidden before a destination exists.
One photograph is submitted per
capture action. Re-center sits at the image area's bottom right and starts a fresh
photo flow. Uncertain/unmapped results never establish location; a likely result
must name a checkpoint in the selected building, then the visitor confirms
the nearby sign. The global response's node/revision identities support starting
on a different floor from the destination; recognition is the existing teammate
implementation described in [the localization handoff](localization-visitor-match.md).

The guidance renderer now consumes published route frames, reviewed reference
photos and image-relative arrow angles as described below. Missing imagery or
orientation is shown explicitly. Finishing is a user action, not automatically
verified arrival. Cancellation, recapture, background
and map changes clear guidance; background also closes capture and stops GPS.
An active outdoor walk resumes previously requested GPS when foregrounded again.

The brand/on-foot header, introductory slogan, heading/subtitle, outdoor-map badge,
demo guidance banner and indoor/outdoor instruction rows were removed at the
contributor's request. The outside footer says **Follow Google Maps. When you arrive,
continue indoors.** No welcome-back message persists when switching modes. Camera
help is condensed to the hint below Take photo; the building question has no photo
subtitle. GPS is requested only through the map's re-center control; there is no
Use/Update location action. Before a location or destination is set, the map prompts
**Tap the re-center button to find your location.** Accuracy/progress/permission
feedback remains available after a GPS request. Google default map controls
(including camera/zoom buttons) are disabled in this view, preserving map gestures and provider attribution.
One custom GPS-center control appears outdoors; only the photo re-center appears
indoors. Both are hidden while the inside/outside prompt covers the map. Cancelling
or finishing clears the destination and hides the question until another is selected.

## Published data and remaining integration

### Database-backed building directory

The visitor screen loads `GET /api/maps/public/building-directory/` from the
configured backend. The directory returns stored building names, IDs, place IDs,
slugs, addresses and coordinates, plus public floor names/codes for open map
targets. It lists buildings with an open floor map and valid stored coordinates,
including buildings whose maps have not been published. Archived-only and
unlocated seed records are excluded. Different database building IDs remain
separate records; the UI does not combine graphs by name or coordinates.

A floor without a current publication has null `publication_id`/`sequence` and
empty checkpoints/destinations. Current, noninvalidated published floors replace
that metadata row in place, supplying their actual stable node IDs and room
labels without duplicate floors. Draft nodes/geometry, room purpose/provenance,
asset keys, memberships and private map instructions remain excluded. The older
`GET /api/maps/public/buildings/` contract remains published-only for the website
map; navigation sessions/routing keep their existing publication requirements.

The visitor begins with an empty catalog, shows loading/retry/empty feedback,
and uses only the API response. There are no injected IA5061/IC101 sample rooms,
no fallback catalog and no camera demo flag/event. Selecting a building without
published rooms disables Room with **Rooms not ready** and explains **Indoor
destinations are not available for this building yet.** Suggestions show the
stored address and floor count. Database rows are not deleted or reclassified.
Historical October 17 [coordinate source evidence](assets/mobile-visitor/utsc-building-markers.source.json)
is preserved unchanged; its bundled sample entries are no longer application data.

October 18 read-only verification against the running localhost API returned
**IA** and **IA Building**, with five open-map floors and no published room
destinations. Browser evidence renders those real API records; Google Maps and
sign-in responses are disabled in that check to avoid provider requests. The
absence of published rooms is shown rather than substituted with sample rooms.
Android uses the same directory path on its configured HTTPS backend, so that
backend must receive this release before the new directory is available there.

Changed files: [directory view](../apps/api/maps/views.py), [URL](../apps/api/maps/urls.py),
[privacy/publication tests](../apps/api/tests/test_google_integration.py),
[visitor controller](../apps/web/src/app/features/visitor/visitor.ts),
[template](../apps/web/src/app/features/visitor/visitor.html),
[loading/status styles](../apps/web/src/app/features/visitor/visitor-search.scss),
[nullable publication types](../apps/web/src/app/features/visitor/visitor.models.ts),
[camera](../apps/web/src/app/features/visitor/visitor-camera.ts),
[journey tests](../apps/web/src/app/features/visitor/visitor.spec.ts) and
[camera tests](../apps/web/src/app/features/visitor/visitor-camera.spec.ts).
The `visitor-demo.ts` source catalog was deleted. Applicable commit is pending;
suggested `feat(visitor): replace demo destinations with stored buildings`.

Validation: **178 PostgreSQL backend tests**, **160 SQLite tests with 18
PostgreSQL-only skips**, and **115 frontend tests** pass. Web/visitor production
builds, Android asset sync and browser checks pass. Isolated routing checks use
synthetic data; a separate browser check reads actual localhost directory data.
Ignored artifacts are under `local/artifacts/building-directory/`. No database
writes, new dependencies, migrations, env keys/private values, deployment,
physical-device test or APK installation were performed for this change.

The browser/Android capture path uses rear-facing `getUserMedia`, creates a JPEG
at most 1024 px on its longest side, and calls the existing authenticated
`POST /api/navigation/localize/`. Android's installed Capacitor WebChromeClient
already handles browser camera and geolocation permission prompts; this change
declares the corresponding manifest permissions without adding a plugin. iOS uses
the existing FrameCapture bridge, stops after its first emitted frame, and uploads
that frame using its existing configured native transport. On camera-screen entry,
the iOS bridge takes one bounded, non-uploaded readiness snapshot for its labelled
camera check; **Take photo** captures a separate fresh frame to upload. Android and
browser show a live video preview on entry. Native capture is injected through the
existing device boundary so permission, preview and upload consent can be tested
without a phone or provider call. Camera tracks/listeners
are released and results from a closed capture screen are ignored.

Release integration is still pending:

- Review the reference images and graph connections, publish each floor and
  populate the explicit floor transfers described below. The frame adapter and
  photo-route endpoint are implemented; route preview does not verify movement.
- Apply the exact Android CORS allowance described below and verify restricted
  Google Maps credentials on the physical phone. API address routing is implemented;
  production CORS is verified. Google Maps referrer authorization and final map
  acceptance remain pending with the credential owner.
- Deploy the visitor-session bootstrap and scoped localization integration below.
  Browser and Android captures use short-lived capabilities; the existing iOS
  bridge's configured token transport remains debug-only.
- Verify Android camera/GPS, iOS capture/GPS, external Maps handoff, background/return,
  safe areas and permission recovery on actual phones. Android SDK Platform 36 is
  now installed locally; a successful asset sync alone still does not verify an APK
  build or physical-device behavior.

The single-env check passes against the current local contract. No template/private
env keys, schema version, credential values or dependency versions changed. Existing
Maps/OAuth/native transport credentials must come from the responsible owner through
the team's external private channel; this UI does not distribute them. Future API
origin or dependency changes require the requesting
member's approval under [AGENTS.md](../AGENTS.md).

## Published photo-route walkthrough

The contributor approved cross-floor graph connections on October 18, 2026.
The [architecture decision](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md#5-data-authority-and-publication)
keeps floor edges revision-scoped and reuses `Node.kind=stairs|lift`.

The visitor chooses a destination and exactly one route preference: shortest
available route, avoid stairs, or avoid elevators. After deliberate capture, the
existing MegaLoc localization must return `likely_match`; the visitor confirms
the suggested location before routing. This integration uses the returned node
and revision. It does not add a recognition algorithm or establish that a node is
physically ahead of the camera.

| API | Contract |
| --- | --- |
| `POST /api/navigation/sessions/` | `{publication_id}` for a current, noninvalidated, open map; returns a random 30-minute capability. Only its SHA-256 digest is stored. Camera keeps the secret in memory and sends `Authorization: Navigation <token>` on localization. |
| `POST /api/navigation/localize/` | Existing JPEG/meta interface. Visitor catalogs and reference/index reads are restricted to published maps in the selected building, including under DEBUG. A likely global match additionally returns a signed `localization_token` valid for 30 minutes. Camera bytes remain unretained. |
| `POST /api/navigation/photo-route/` | `{publication_id, destination_id, localization_token, preference}`; destination is the room node's stable UUID. Resolves exact start IDs, runs Dijkstra and returns ordered frames and total graph cost. Invalid/expired location, retired publication and disconnected/preference-blocked graph have explicit errors. |
| `POST /api/navigation/floor-connections/` | Signed-in administrators on both floor targets may submit `{from_node_id, to_node_id, cost, bidirectional}`. Endpoints must be matching stair/lift kinds on different floors in one building. This explicit admin operation records verified connections; direct model creation defaults to unverified. |

Only current noninvalidated publications on open targets participate. Same-floor
edges and cross-floor transfers must be open and verified. Connections are
directed; `bidirectional=true` creates both directions atomically. Publishing a
replacement floor revision requires new transfers to its exact node identities;
old connections do not silently attach to changed maps. Costs must use a common
graph-cost scale across floors and transfers; this implementation does not claim
metres or travel-time optimization for uncalibrated floor plans. Disconnected
nodes are never joined by geometric proximity.

Each path node selects a reviewed reference photo closest to the outgoing plan
bearing. R2 URLs use the existing Django storage adapter and expire after 30
minutes; no object-storage credentials reach the client. With
`capture_context.heading_frame=plan_up_clockwise`, explicit `heading_degrees`
takes precedence; otherwise `front=0`, `right=90`, `back=180`, `left=270`. In the
editor's y-down plan frame, outgoing bearing is `atan2(dx, -dy)`. The arrow rotates
by outgoing bearing minus the selected photo heading, wrapped to [-180, 180).
The previous arrow uses the current image's heading toward the previous node.
The labels are plan-relative, not a claim about geographic north or camera pose.

Different floor plans have no common planar frame: a floor transfer gives an
explicit stairs/elevator instruction and a next-photo control. Missing photos,
unknown headings and failed image loads remain visible states with accessible
previous/next controls. Photo changes reset image errors. Arrow buttons provide
hover/focus affordances without animation. Browsing a photo changes preview
index only; confirmed physical location and arrival are never advanced by a tap.
Recapture, cancellation, background and destination changes invalidate pending
route responses and clear guidance. Preference changes recompute from the last
confirmed photo location.

Before live use, deploy the code and apply
[`maps.0004_floor_connections`](../apps/api/maps/migrations/0004_floor_connections.py)
using the migration role; verify runtime permissions for the new table. Create
room destination nodes, review photos (including their headings), verify walking
edges, publish the floor maps with ready localization indexes, and create the
reviewed stair/lift transfers via the admin API. The graph editor's add-waypoint
control now supports stairs and elevators. This work does not publish maps or
mark existing data reviewed automatically.

A read-only check of Tiger DEV on October 18 found **0 active publications**, all
**15 reference photos proposed**, and all **115 walking edges unverified**. These
are live-data preparation blockers, separate from the implemented UI and APIs.
No live rows, cloud schema, deployment or private values were changed. No env
template, environment schema version, dependency or external-channel credential update is
required. Existing R2, localization and exact Android CORS settings remain needed;
real provider/device acceptance remains a deployment follow-up.

Changed implementation and evidence:

| Area | Files |
| --- | --- |
| Route algorithm and transport | [routing service](../apps/api/navigation/services/routing.py), [session/route views](../apps/api/navigation/views_routing.py), [localization integration](../apps/api/navigation/views.py), [URLs](../apps/api/navigation/urls.py), [navigation persistence description](../apps/api/navigation/models.py) |
| Floor transfers and node types | [models](../apps/api/maps/models.py), [migration/SQL guard](../apps/api/maps/migrations/0004_floor_connections.py), [authorized connection service](../apps/api/maps/services/floor_connections.py), [connection API](../apps/api/navigation/views_connections.py), [graph commands](../apps/api/maps/services/graph.py), [graph editor controller](../apps/web/src/app/features/graph-editor/graph-editor.ts), [type selector](../apps/web/src/app/features/graph-editor/graph-editor.html), [schema notes](database-schema.md) |
| Visitor integration | [controller](../apps/web/src/app/features/visitor/visitor.ts), [template](../apps/web/src/app/features/visitor/visitor.html), [preference styles](../apps/web/src/app/features/visitor/visitor-guidance.scss), [route types](../apps/web/src/app/features/visitor/visitor-route.ts), [photo renderer](../apps/web/src/app/features/visitor/guidance-photo.ts), [camera/capability](../apps/web/src/app/features/visitor/visitor-camera.ts), [global match types](../apps/web/src/app/core/place-match.ts), [entry alias](../apps/web/src/app/app.routes.ts) |
| Checks | [routing/security/PostgreSQL tests](../apps/api/tests/test_photo_routing.py), [visitor integration tests](../apps/web/src/app/features/visitor/visitor.spec.ts); ignored `local/tests/photo-route.cjs` and `local/artifacts/photo-route/` contain synthetic browser evidence. |

Validation: **135 backend tests pass on isolated PostgreSQL**; **118 pass and 17
PostgreSQL-only checks skip on SQLite**. **96 frontend tests pass**. Production
configuration/schema checks, website build and browser flow at 320/390/430 px
pass. Browser evidence uses synthetic imagery, fake camera and mocked APIs;
no live inference or R2-fetch success is claimed. Android visitor production
build and asset/plugin sync pass; migration drift, Ruff, changed-file Prettier,
whitespace and local environment-contract checks pass. No new APK was built or
installed in this task. Personal execution history is in ignored `local/ACTIONS.md`.
Applicable navigation commit: `bd1a713` (`feat(navigation): add photo-guided shortest-path routing`).

### Navigation and workspace merge reconciliation — October 18, 2026

Reconciled navigation commit `bd1a713` with workspace/authentication integration
`f6ad116` on `feature/static-image`. The [route table](../apps/web/src/app/app.routes.ts)
retains the sign-in entry, Public User routes and `/app-review` compatibility alias.
The newer [editor controller](../apps/web/src/app/features/graph-editor/graph-editor.ts)
and [template](../apps/web/src/app/features/graph-editor/graph-editor.html) keep
selection, undo, gesture commands, four-direction photos and stair/elevator node
types; the type selector is available while adding a waypoint. The reconciled
[graph service](../apps/api/maps/services/graph.py) keeps all supported waypoint
kinds, input validation and stable-ID restoration for undo.

[Migration 0007](../apps/api/maps/migrations/0007_merge_navigation_workspace.py)
joins the independent floor-connection and workspace migration branches without
rewriting either history. [Retention](../apps/api/maps/services/retention.py) removes
transfers before deleting their endpoint nodes; the other floor's graph remains
intact. [Regression coverage](../apps/api/tests/test_photo_routing.py) checks this
combined lifecycle. This reconciliation changes no architecture, dependencies,
environment template or private configuration and performs no cloud migration.

Validation: all **169 backend tests pass on isolated PostgreSQL** and all **115
frontend tests pass**. The SQLite suite passed 150 tests with 18 PostgreSQL-only
skips before the cleanup regression was added; its focused routing suite then
passed 12 with one PostgreSQL-only skip. Web production build passes with the
incoming `app.scss` size-budget warning (282 bytes over the warning threshold).
Migration drift and local environment-contract checks pass. Personal details are
in ignored `local/ACTIONS.md`; merge resolutions are pending commit.

## Installed Android API connection

The contributor approved `https://snapway.work` as the installed-app backend and
selected standard WebView HTTP with an exact CORS allowance. The bundled Android
page uses `https://localhost`; a relative `/api/client-config/` previously resolved
against those local assets instead of Django, producing **Map unavailable**.
The [visitor entry](../apps/web/src/main.visitor.ts) now registers an
[API interceptor](../apps/web/src/app/core/native-api.interceptor.ts) that prefixes
relative `/api/` requests with the HTTPS backend only inside Capacitor. Website
requests, local assets and explicitly addressed URLs keep their existing addresses.
Maps configuration, public building discovery and the existing photo-upload request
use this route. Developer login stays on the website; this adds no guest capability
issuance, shared token or cross-site credential option. Existing localization
permissions remain authoritative.

The final build does not enable Capacitor's native HTTP patch, change dependencies,
load remote application assets, allow cleartext traffic or change the local origin.
The [transport tests](../apps/web/src/app/core/native-api.interceptor.spec.ts) cover
phone configuration/discovery URLs, preserved multipart bodies, website behavior
and requests that must remain untouched. All **93 frontend tests** and both web
and visitor production builds pass; Android sync, debug assembly and APK signature
verification pass. The updated debug APK was installed on the connected phone with
app data preserved. Successful map rendering still requires the provider allowlist
update described below.

The deployment owner must add **`https://localhost`** to the existing
`CORS_ALLOWED_ORIGINS` value in `/etc/indoor-nav/api.env`, preserving other origins.
This existing host override requires no template/key/schema update; obtain or
coordinate the private configuration through the team channel. Do not enable
wildcard origins or credentialed CORS. CORS allows response reading and is not
application identity or authorization. Validate before restarting:

```bash
# The installed root-owned validator is absent on this server. Use the deployed
# validator without running release-owned code as root; private values stay piped.
sudo cat /etc/indoor-nav/api.env | python3 \
  /srv/indoor-nav/current/source/scripts/env_contract.py check \
  --template /srv/indoor-nav/current/source/.env.example \
  --file /dev/stdin --profile production
# Run only after validation succeeds; restart active API units only.
sudo systemctl try-restart 'snapway-api-*.service'
```

Verify `GET /api/client-config/` with `Origin: https://localhost` returns
`Access-Control-Allow-Origin: https://localhost` without an allow-credentials header,
then retry the map on the phone. The owner has applied the CORS change: live config
and liveness requests both return HTTP 200 with the exact origin and no
allow-credentials header. The phone confirms Android platform, native HTTP patch
disabled, and configuration/discovery requests to `https://snapway.work`.
It now reaches Google Maps, which rejects the referrer with
`RefererNotAllowedMapError`. The Maps credential owner must add
`https://localhost/*` to the browser key's website restrictions, preserving existing
website and API restrictions. Identify the active key from `maps.browser_key` in
the public client-config response and match it in Google Cloud Credentials; do
not confuse it with the server-only OAuth client. Never remove restrictions to
mask this error. Retry/reload the map after saving; provider allowlist changes
require no APK rebuild. Final map rendering remains unverified until this update.
Existing SSH admin identities were rejected; a read-only deployment-identity
check verified the release validator path. No server environment or provider
account was changed by the agent; the requesting member made the CORS update.

References: [Capacitor local origin configuration](https://capacitorjs.com/docs/config),
[Google Maps key/WebView restrictions](https://developers.google.com/maps/api-security-best-practices).

## Android CLI Java setup

The existing Capacitor 8 Android modules compile Java 21 sources. Gradle itself can
start under JDK 17, but that compiler rejects the modules with **invalid source
release: 21**. Use a complete JDK 21 for both the Gradle launcher and daemon. Set
`JAVA_HOME` in the build terminal and use `-Dorg.gradle.java.home` when needed to
make the daemon selection explicit; `gradlew.bat --version` should show Java 21
for both. These are build-tool settings, not application `local/.env` keys.

From `apps/web/android`, after selecting an installed JDK 21:

```powershell
$env:JAVA_HOME = '<complete-JDK-21-root>'
.\gradlew.bat "-Dorg.gradle.java.home=$env:JAVA_HOME" --version
.\gradlew.bat "-Dorg.gradle.java.home=$env:JAVA_HOME" --no-daemon assembleDebug
```

The expected artifact is `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`.
An incomplete Android Studio bundled runtime is not a usable JDK: verify that
`bin/java.exe`, `bin/javac.exe` and `lib/jvm.cfg` exist and that Java launches.
This machine's bundled runtime was incomplete while Android Studio was being
updated. The new Studio then selected JDK 25, which is too new for Gradle 8.14.3.
An official portable Temurin JDK 21 was downloaded into ignored `local/tools/jdk21`
and verified against its publisher-provided SHA-256. It was selected for the build
process and for the ignored `android/.gradle/config.properties` Java-home setting
used by Studio's existing `GRADLE_LOCAL_JAVA_HOME` option. Studio should be synced
after that local setting changes; no AGP/Gradle upgrade is needed. No system Java
setting, Gradle/AGP/Capacitor dependency, template or private application env value
was changed. Runtime provenance and host-specific paths remain in ignored local
history. See [Gradle Java selection](https://docs.gradle.org/current/userguide/build_environment.html)
and [Temurin downloads](https://adoptium.net/temurin/releases/?version=21&os=windows&arch=x64).

## Implementation and verification

The startup location prompt now directs visitors to the re-center button instead
of reporting unavailable location. This copy-only change passes the visitor build,
Android sync/debug assembly/signature verification, changed-file formatting and
environment/whitespace checks. The phone is disconnected, so this updated APK
has not been installed; unit tests were not rerun for the text edit.

| Area | Changed files |
| --- | --- |
| Visitor state and screen | [controller](../apps/web/src/app/features/visitor/visitor.ts), [template](../apps/web/src/app/features/visitor/visitor.html), [base styles](../apps/web/src/app/features/visitor/visitor.scss), [search layout](../apps/web/src/app/features/visitor/visitor-search.scss), [autocomplete control](../apps/web/src/app/features/visitor/visitor-destination-search.ts), [guidance styles](../apps/web/src/app/features/visitor/visitor-guidance.scss), [map prompt styles](../apps/web/src/app/features/visitor/visitor-prompt.scss) |
| Selection, location, media | [destination models](../apps/web/src/app/features/visitor/visitor.models.ts), [coordinate evidence](assets/mobile-visitor/utsc-building-markers.source.json), [walking map](../apps/web/src/app/features/visitor/walking-map.ts), [single-photo capture](../apps/web/src/app/features/visitor/visitor-camera.ts), [image/arrow renderer](../apps/web/src/app/features/visitor/guidance-photo.ts) |
| Entry points | [Capacitor entry](../apps/web/src/main.visitor.ts), [web preview route](../apps/web/src/app/app.routes.ts), [fullscreen preview shell](../apps/web/src/app/app.ts) |
| Native permissions | [Android manifest](../apps/web/android/app/src/main/AndroidManifest.xml), [iOS usage text](../apps/web/ios/App/App/Info.plist) |
| Published discovery | [public view](../apps/api/maps/views.py), [privacy/publication tests](../apps/api/tests/test_google_integration.py) |
| Frontend coverage and related record | [journey tests](../apps/web/src/app/features/visitor/visitor.spec.ts), [camera permission/lifecycle tests](../apps/web/src/app/features/visitor/visitor-camera.spec.ts), [existing frontend feature record](frontend-iteration.md) |

Latest 12 px heading-margin adjustment: visitor production build, Android asset
sync, changed-file formatting, whitespace and env-contract checks pass; browser
and unit suites were not rerun for this one-line CSS edit.

Prior validation: the autocomplete implementation passed **89 frontend tests**.
This presentation-only refinement passes web/visitor production builds, Android
asset/plugin sync, browser acceptance at four phone widths, changed-file Prettier, local env
contract and Git whitespace checks; unit tests were not rerun for these
presentation-only changes.
Earlier backend validation passed **7 focused tests**;
backend code is unchanged here. Earlier iOS sync, Ruff and plist checks are recorded
for the original implementation, not rerun for this Android-facing refinement.

PostgreSQL CI regression: the [public discovery test](../apps/api/tests/test_google_integration.py)
previously inserted room content into an already frozen, published revision,
triggering `Frozen revision content is immutable`. The fixture now populates the
draft before freezing, approval and publication. The existing assertions still
verify published destinations and exclude private room fields and draft nodes.
The original failure was reproduced on isolated local PostgreSQL; production
guards and CI's aggregate `required` gate remain unchanged.
After correction, the full backend suite passes on PostgreSQL (**119 passed**)
and SQLite (**103 passed, 16 PostgreSQL-only tests skipped**). Changed-file Ruff
lint/format, environment-contract and Git whitespace checks pass. GitHub CI
must rerun after this correction is committed and pushed; no deployment was performed.

Android packaging now passes: Gradle 8.14.3 assembled the debug APK using
Temurin 21.0.12.1+1; Android SDK apksigner verifies its v2 signature, and APK
metadata identifies `org.snapway.app`, version 1.0, target SDK 36. The 4,591,471-byte
archive passes CRC checks and contains the manifest, DEX and bundled visitor
entry. This is a debug-signed APK, not a release-signing or physical-device
acceptance result. No deployment was performed.

Browser acceptance passes consistent panel bounds across search/prompt/indoor/outdoor
states at the original taller height, a centered camera with a larger preview,
the red accessible cancel icon, logo/heading alignment, clearer placeholders and
building/room searches on the same row with separate underlines, matching suggestions,
disabled/reset room selection, the fullscreen journey,
single-photo upload, location confirmation, re-center/cancel/finish, and
building-specific inside/outside prompts only after room selection, automatic camera
opening from **Yes**, automatic journey start on room selection, and mutually exclusive
GPS/photo controls. It confirms no upload before **Take photo**, no initial prompt,
no premature prompt for either building before room selection, and no automatic GPS-triggered prompt.
Historical October 17 checks (superseded by demo removal above): with an empty discovery response, the former harness selected both actual-location demos and checked
both coordinate-based walking URLs and captures a demo photo without a localization
request or confirmed position. There is no horizontal
overflow at 320/375/390/430 px. The check uses
isolated published-building fixtures, synthetic GPS and fake camera media, with
Google services deliberately unconfigured; it does not mutate shared maps or call
paid providers. Search, camera and outdoor screenshots were inspected visually. Real
Google navigation handoff and GPS remain physical-device acceptance work. A separate
local check supplies a mock Maps runtime and synthetic GPS to verify both rendered
marker colors and labels, including a subsequent GPS update; it makes no provider
calls.

Official references: [Google Maps walking/navigation URLs](https://developers.google.com/maps/documentation/urls/get-started),
[Capacitor web/native API boundary](https://capacitorjs.com/docs/core-apis/web),
[Capacitor geolocation permissions](https://capacitorjs.com/docs/apis/geolocation),
[Google Maps control options](https://developers.google.com/maps/documentation/javascript/controls),
[custom Advanced Marker content](https://developers.google.com/maps/documentation/javascript/advanced-markers/html-markers).
