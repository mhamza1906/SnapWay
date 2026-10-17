# Mobile visitor navigation UI

Updated October 17, 2026. Feature work on `feature/frontend-user`; implementation
is uncommitted. Suggested commit: `feat(mobile): add dedicated visitor navigation UI`.
Personal execution details remain in ignored `local/ACTIONS.md`.

## Entry points and interaction

The existing Angular/Capacitor architecture and locked dependencies are retained.
The website still starts at `/map`, including on phone browsers. The separate
Capacitor visitor build starts at the new destination-first screen and redirects
`/map` and `/navigate` there. It excludes contributor features. `/app-preview` in
the web build explicitly previews the installed-app layout; viewport width does
not switch the website into that experience.

Search supports building selection followed by room selection, or a direct room
query such as `IA5061`. Matching ignores spacing/case and also accepts the building
slug prefixed to a room number. Published destinations are supplemented by the
two bundled demo entries below. IC is selectable as a building-level destination;
no IC room or floor is invented. Both kinds use the same destination-specific
inside/outside prompt and camera flow.

The Google map uses walking-scale zoom 17, an approximate-location marker and the
selected building marker. No location question appears on initial load. For IA,
selecting the building opens room selection; selecting IA5061 completes the
destination. Selecting IC completes its building-level destination immediately.
A complete destination starts the journey and covers the map
with **Are you inside [destination building name]?**, using the selected destination's
actual building name and room label. Search is replaced by **Cancel** and **Finish**.
There is no
second destination confirmation or disabled destination button. **Open Google Maps**
launches outdoor walking navigation. Google supplies the
outdoor route; SnapWay does not draw an invented route or claim an entrance-level
coordinate where the database supplies only a building coordinate.

**Yes, I'm inside** immediately opens the camera screen and asks for permission
if needed. It names the destination building and asks the visitor to aim at a room
number, corridor sign or distinctive landmark, keep the sign readable and hold the
phone steady. **Take photo** captures/submits one fresh photo; opening the camera
alone does not submit a photo. **No, I'm outside** keeps the walking map available.
For a bundled demo, Take photo exercises capture locally without uploading to the
localization API or claiming a recognized location; the screen explicitly reports
that indoor guidance is not available yet.

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

The introductory slogan, heading/subtitle and outdoor-map badge were removed at
the contributor's request. Google default map controls (including camera/zoom
buttons) are disabled in this view, preserving map gestures and provider attribution.
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
| Instructional Centre (IC), building arrival | 1095 Military Trail, Scarborough, ON M1C 5J9 | 43.786816 | -79.189484 | 493695 / 363654 |

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
used as the address or coordinate authority. IC has no room/floor supplied here.
The IA floor uses an empty publication ID, sequence 0 and no checkpoints; IC has
no floor records. A demo label and guidance-unavailable message remain visible.

Demo capture emits only a local completion event. Android/browser does not upload
or retain the captured JPEG; iOS uses its existing app-sandbox frame storage and
skips matching credentials/network calls. Demo results cannot confirm an indoor
position. Published destinations retain the existing authenticated matching path.

`GET /api/maps/public/buildings/` adds building `slug` and per-floor `destinations`
(`id`, `label`, `name`) and `checkpoints` (`id`, `label`). IDs are stable node IDs
from the current, non-invalidated publication of an open target. Draft geometry,
internal room purpose/provenance, asset paths, memberships and private instructions
remain excluded. No migration is required. Existing clients can ignore the new
fields. Search exposes empty/retry states for unavailable live data while retaining
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
- Configure and validate installed-app HTTPS API transport, the actual Capacitor
  origin and restricted Google Maps credentials. Current relative public API calls
  retain the existing same-origin contract; bundled localhost assets alone cannot
  reach Django. No permissive CORS or remote live-reload server was introduced.
- Provide the existing authorized localization session/capability. There is no
  public visitor-session issuance endpoint yet, and the iOS bridge's configured
  token transport remains debug-only. Anonymous browser captures may be denied;
  this change does not bypass that authorization boundary or embed a shared token.
- Verify Android camera/GPS, iOS capture/GPS, external Maps handoff, background/return,
  safe areas and permission recovery on actual phones. Android SDK is unavailable
  on this machine, so sync is not an APK build or signed installable artifact.

The single-env check passes against the current local contract. No template/private
env keys, schema version, credential values or dependency versions changed. Existing
Maps/OAuth/native transport credentials must come from the responsible owner through
the team's external private channel; this UI does not distribute them. Future API
origin/guest-session architecture or dependency changes require the requesting
member's approval under [AGENTS.md](../AGENTS.md).

## Implementation and verification

| Area | Changed files |
| --- | --- |
| Visitor state and screen | [controller](../apps/web/src/app/features/visitor/visitor.ts), [template](../apps/web/src/app/features/visitor/visitor.html), [base styles](../apps/web/src/app/features/visitor/visitor.scss), [search styles](../apps/web/src/app/features/visitor/visitor-search.scss), [guidance styles](../apps/web/src/app/features/visitor/visitor-guidance.scss), [map prompt styles](../apps/web/src/app/features/visitor/visitor-prompt.scss) |
| Search, location, media | [models/search](../apps/web/src/app/features/visitor/visitor.models.ts), [demo catalogue](../apps/web/src/app/features/visitor/visitor-demo.ts), [coordinate evidence](assets/mobile-visitor/utsc-building-markers.source.json), [walking map](../apps/web/src/app/features/visitor/walking-map.ts), [single-photo capture](../apps/web/src/app/features/visitor/visitor-camera.ts), [image/arrow renderer](../apps/web/src/app/features/visitor/guidance-photo.ts) |
| Entry points | [Capacitor entry](../apps/web/src/main.visitor.ts), [web preview route](../apps/web/src/app/app.routes.ts), [fullscreen preview shell](../apps/web/src/app/app.ts) |
| Native permissions | [Android manifest](../apps/web/android/app/src/main/AndroidManifest.xml), [iOS usage text](../apps/web/ios/App/App/Info.plist) |
| Published discovery | [public view](../apps/api/maps/views.py), [privacy/publication tests](../apps/api/tests/test_google_integration.py) |
| Frontend coverage and related record | [journey tests](../apps/web/src/app/features/visitor/visitor.spec.ts), [camera permission/lifecycle tests](../apps/web/src/app/features/visitor/visitor-camera.spec.ts), [existing frontend feature record](frontend-iteration.md) |

Validation: all **87 frontend tests** and **7 focused backend tests** pass. Web and
visitor production builds pass without budget warnings. Android and iOS asset/plugin
sync, changed-file Prettier, Ruff lint/format, plist parsing, local env contract and
Git whitespace checks pass. Android SDK/physical devices are unavailable; there is
no signed APK, native runtime or deployed release acceptance in these results.

Browser acceptance passes building-first/direct-room search, the fullscreen journey,
single-photo upload, location confirmation, re-center/cancel/finish, and
building-specific inside/outside prompts only after room selection, automatic camera
opening from **Yes**, automatic journey start on room selection, and mutually exclusive
GPS/photo controls. It confirms no upload before **Take photo**, no initial prompt,
no premature prompt during IA room selection, and no automatic GPS-triggered prompt.
With an empty discovery response it also selects both actual-location demos, checks
both coordinate-based walking URLs and captures a demo photo without a localization
request or confirmed position. There is no horizontal
overflow at 320/375/390/430 px. The check uses
isolated published-building fixtures, synthetic GPS and fake camera media, with
Google services deliberately unconfigured; it does not mutate shared maps or call
paid providers. Destination and indoor screenshots were inspected visually. Real
Google navigation handoff and GPS remain physical-device acceptance work.

Official references: [Google Maps walking/navigation URLs](https://developers.google.com/maps/documentation/urls/get-started),
[Capacitor web/native API boundary](https://capacitorjs.com/docs/core-apis/web),
[Capacitor geolocation permissions](https://capacitorjs.com/docs/apis/geolocation),
[Google Maps control options](https://developers.google.com/maps/documentation/javascript/controls).
