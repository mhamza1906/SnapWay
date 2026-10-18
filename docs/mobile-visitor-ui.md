# Mobile visitor navigation UI

Updated October 17, 2026. Feature work on `feature/frontend-user`; implementation
commits include `a0564a9` and `ca59f45`; heading spacing and local Android packaging
notes are recorded in `1407e12`; the publication-fixture correction is in `57e8b26`.
The installed-app API connection below is pending commit.
Personal execution details remain in ignored `local/ACTIONS.md`.

## Entry points and interaction

The existing Angular/Capacitor architecture and locked dependencies are retained.
The website still starts at `/map`, including on phone browsers. The separate
Capacitor visitor build starts at the new destination-first screen and redirects
`/map` and `/navigate` there. It excludes contributor features. `/app-preview` in
the web build explicitly previews the installed-app layout; viewport width does
not switch the website into that experience.

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
relationships and the active suggestion to assistive technology. Published
destinations are supplemented by the two bundled demos below. Both require a room
suggestion before navigation starts.

The Google map uses walking-scale zoom 17. The visitor's approximate-location
marker is red (`#dc3c35`); the destination building marker is blue (`#2563eb`).
Each uses its own local SVG pin with a white border/center, passed to the existing
AdvancedMarkerElement content option. Marker titles retain **Your approximate
location** and **Destination building** so meaning is available beyond color. No location question appears on initial load. Selecting
either building enables room selection; selecting IA5061 or IC101 completes the
destination.
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
For a bundled demo, Take photo exercises capture locally without uploading to the
localization API or claiming a recognized location; completion feedback explains
that demo location matching is not connected and never claims a position.

GPS is used for the outdoor map; it does not automatically reopen the question or
infer indoor entry. The previous proximity-triggered prompt was removed to follow
the contributor's destination-selection-only design. **Location options** can
manually reopen the same building-specific prompt after destination selection,
including after **Back to outdoor map**. It is hidden before a destination exists.
One photograph is submitted per
capture action. Re-center sits at the image area's bottom right and starts a fresh
photo flow. Uncertain/unmapped results never establish location; a likely result
must name a checkpoint on the selected published floor, then the visitor confirms
the nearby sign. Checkpoint matching reuses the existing exact normalized matcher.

The guidance renderer accepts an image URL, accessible description, instruction
and explicit straight/left/right/back arrow direction. Its adapter currently has
no route frames to supply, so the UI shows a waiting state. A recognized checkpoint
or a reference photo alone does not establish a travel direction. Finishing is a
user action, not automatically verified arrival. Cancellation, recapture, background
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

### Bundled campus demos

The visitor build and `/app-preview` include these two **Demo** entries from
[visitor-demo.ts](../apps/web/src/app/features/visitor/visitor-demo.ts). They are
available immediately, including when discovery is empty or unavailable. Matching
published buildings (by slug or name) take precedence. They are not inserted into
the database or returned as publications by the public website's discovery API.
No credentials, network lookup, schema migration or configuration flag is needed
to select them. Embedded Google tiles still require the existing Maps configuration;
the walking-navigation URL can open Google Maps independently.

| Demo destination | Address | Latitude | Longitude | University map location / marker |
| --- | --- | --- | --- | --- |
| Sam Ibrahim Building (IA), IA5061, 5th floor | 1050 Military Trail, Scarborough, ON M1C 1G9 | 43.788609 | -79.191116 | 959718 / 723740 |
| Instructional Centre (IC), IC101 (fictional demo room) | 1095 Military Trail, Scarborough, ON M1C 5J9 | 43.786816 | -79.189484 | 493695 / 363654 |

Coordinates were read on October 17, 2026 from the **Buildings** category (48600)
of the [University of Toronto campus map](https://map.utoronto.ca/?id=1809).
The [source snapshot](assets/mobile-visitor/utsc-building-markers.source.json)
contains the two original public marker objects with fields/values unchanged;
only JSON formatting and selection from the full catalogue differ. The complete
original response is retained in ignored local research. No map-service key is
included in the snapshot or app data. These are building markers, not surveyed
entrances, room coordinates, floor plans or localization checkpoints.

[UTSC Health & Wellness](https://www.utsc.utoronto.ca/hwc/) independently confirms
IA5061, the fifth floor and 1050 Military Trail. Addresses/postcodes retain the
requesting contributor's supplied text; the university map supplied the coordinates.
An older OSM record used the general campus mailing address for IA, so it was not
used as the address or coordinate authority. IC101 and its first-floor grouping are
fictional test data added at the contributor's request, not verified university
room records. Both demo floors use empty publication IDs, sequence 0 and no
checkpoints. Building options retain a compact Demo label; no persistent demo
banner takes space from navigation.

Demo capture emits only a local completion event. Android/browser does not upload
or retain the captured JPEG; iOS uses its existing app-sandbox frame storage and
skips matching credentials/network calls. Demo results cannot confirm an indoor
position. Published destinations retain the existing authenticated matching path.

`GET /api/maps/public/buildings/` adds building `slug` and per-floor `destinations`
(`id`, `label`, `name`) and `checkpoints` (`id`, `label`). IDs are stable node IDs
from the current, non-invalidated publication of an open target. Draft geometry,
internal room purpose/provenance, asset paths, memberships and private instructions
remain excluded. No migration is required. Existing clients can ignore the new
fields. Selection exposes unavailable-room/retry states for unavailable live data while retaining
the two labelled demos for visitor UI testing.

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

- Supply reviewed guidance images and a route/publication-aware frame adapter to
  the typed renderer. No uploaded images, route-generation endpoint, turn sequence
  or automatic step advancement is implemented by this UI task.
- Apply the exact Android CORS allowance described below and verify restricted
  Google Maps credentials on the physical phone. API address routing is implemented;
  production CORS is verified. Google Maps referrer authorization and final map
  acceptance remain pending with the credential owner.
- Provide the existing authorized localization session/capability. There is no
  public visitor-session issuance endpoint yet, and the iOS bridge's configured
  token transport remains debug-only. Anonymous browser captures may be denied;
  this change does not bypass that authorization boundary or embed a shared token.
- Verify Android camera/GPS, iOS capture/GPS, external Maps handoff, background/return,
  safe areas and permission recovery on actual phones. Android SDK Platform 36 is
  now installed locally; a successful asset sync alone still does not verify an APK
  build or physical-device behavior.

The single-env check passes against the current local contract. No template/private
env keys, schema version, credential values or dependency versions changed. Existing
Maps/OAuth/native transport credentials must come from the responsible owner through
the team's external private channel; this UI does not distribute them. Future API
origin/guest-session architecture or dependency changes require the requesting
member's approval under [AGENTS.md](../AGENTS.md).

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
| Selection, location, media | [destination models](../apps/web/src/app/features/visitor/visitor.models.ts), [demo catalogue](../apps/web/src/app/features/visitor/visitor-demo.ts), [coordinate evidence](assets/mobile-visitor/utsc-building-markers.source.json), [walking map](../apps/web/src/app/features/visitor/walking-map.ts), [single-photo capture](../apps/web/src/app/features/visitor/visitor-camera.ts), [image/arrow renderer](../apps/web/src/app/features/visitor/guidance-photo.ts) |
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
With an empty discovery response it also selects both actual-location demos, checks
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
