# iOS photo checkpoints and routes across floors

Updated October 18, 2026. Isolated branch `experiment/gps-entrance-node19`;
original source project, photo IDs/uploads and active feature checkout are preserved.
Nothing is pushed. Android is unchanged.

## Current iPhone flow

The installed SnapWay Motion Lab app opens the photo-checkpoint screen. It does
not register/start ARKit, record video, stream camera frames or estimate position
between photos. The system photo input captures one image, which is resized to a
960-pixel JPEG, stripped of EXIF through canvas encoding and submitted once to the
existing MegaLoc service. Unknown/ambiguous results never confirm arrival.

Original Level 1 circulation 2 references cover 26 photographed nodes / 104
reference images. A supported match explicitly sets Level 1 and the original
node ID. Starting position can instead be manually selected at a known landing;
manual confirmations are labelled and never described as photographic evidence.

The destination picker contains all **86 saved destinations across Levels B–5**:
50 rooms/enclosures and 36 stair/elevator landings. Names, uncertain source labels,
doors and connector IDs come from the existing built-in project. Destinations
resolve to their existing doorway endpoints, including multiple eligible entrances;
room centroids are never used as path endpoints. Source-connected availability is
computed at export; the selected stairs/elevator preference may still have no route.

Between floors, choose Stairs or elevator, Use stairs, or Use elevators (avoid
stairs). Source normalized path costs and connector penalties are used; these are
not measured travel times or verified wheelchair accessibility. The original
shared routing engine keeps its default behavior for older maps while accepting
optional source costs and directionality. Route rendering splits at floor changes;
it never draws a diagonal between unrelated floor coordinates. Every floor has
its own original SVG and a view-floor selector. Changing the viewed floor does
not claim the user moved there.

Floor-transition instructions name the connector and source/destination floors.
After physically reaching a landing, the user can confirm it manually, which
switches the displayed map and records a manual checkpoint while preserving the
route. Photo recognition on the other floors is **not available** because no
reference embeddings for those floors are indexed. The app prevents Level 1
matching while manually located upstairs and cannot mark an upstairs destination
arrived from a Level 1 photo. For Level 1 destinations, a supported match to the
nearest reference node by same-floor graph distance supports arrival in the
vicinity only; the room sign and doorway still need physical confirmation.

Source door/connector assumptions are not field verification. All routing data is
a read-only export: no new openings, wall cuts, source access records or human
reviews are invented. Earlier 24↔29 photo-graph discrepancies remain source limits.

## Xcode installation and matching service

Open this worktree's `apps/web/ios/App/App.xcodeproj`, select the existing signing
team and physical iPhone, then Cmd+R. The after-Resources packaging hook hashes web
sources, refreshes visitor assets when changed, and copies them into the signed
app. This fixes Cmd+R previously shipping an old ARKit screen. Web compilation
failure stops the build rather than silently shipping stale assets. The app uses
`org.snapway.motionlab`; existing user signing settings are preserved.

Photo matching needs the Mac awake/online, the local CPU matcher and temporary
HTTPS tunnel running, and phone internet. The app displays an editable current
origin. A stopped/expired tunnel previously returned HTML/plain text beginning
The… and caused a parse exception. Native HTTP now requests text, explicitly
parses JSON and explains non-JSON service errors. Still-photo requests allow up
to 60 seconds for a busy CPU. Incoming photos are temporary and not retained;
there is no full video or R2 mutation in this experiment.

## Implementation

- [iPhone screen](../apps/web/src/app/features/movement-lab/ios-pose-lab.ts),
  [template](../apps/web/src/app/features/movement-lab/ios-pose-lab.html),
  [styles](../apps/web/src/app/features/movement-lab/ios-pose-lab.scss).
- [Shared route adapter/preferences](../apps/web/src/app/features/movement-lab/photo-checkpoint-route.ts),
  [existing routing engine](../apps/web/src/app/core/navigation-engine.ts),
  [optional weight/direction model](../apps/web/src/app/core/prototype.models.ts),
  [floor-aware graph types](../apps/web/src/app/features/movement-lab/movement-model.ts).
- [Read-only export generator](../scripts/export-photo-navigation.mjs),
  [building navigation bundle](../apps/web/public/experiments/photo-building-navigation.json),
  [six original SVG copies](../apps/web/public/experiments/sam-floors).
  Re-export with `node scripts/export-photo-navigation.mjs`; existing pipeline
  dependencies are reused, with no new package installation.
- [Native HTTP](../apps/web/src/app/features/movement-lab/ios-visual-match.ts),
  [JPEG endpoint](../scripts/serve_movement_lab.py),
  [CPU matching adapter](../scripts/movement_lab_matcher.py).
- [Packaging script](../scripts/prepare-ios-photo-web.mjs),
  [Node launcher](../scripts/prepare-ios-photo-web.sh),
  [Xcode phase](../apps/web/ios/App/App.xcodeproj/project.pbxproj),
  [native registration](../apps/web/ios/App/App/SnapWayViewController.swift),
  [camera description](../apps/web/ios/App/App/Info.plist).
- [Multi-floor route checks](../apps/web/src/app/features/movement-lab/photo-multifloor-route.spec.ts),
  [Level 1 doorway checks](../apps/web/src/app/features/movement-lab/photo-checkpoint-route.spec.ts),
  [transport/parse checks](../apps/web/src/app/features/movement-lab/ios-visual-match.spec.ts).

## Verification and history

Earlier commits `996f180` and `bcc0adb` contain the causal video replay and ARKit
experiment. The user subsequently replaced active AR tracking with still photos.
The source MOV is not evidence of new ARKit/IMU accuracy. Before this multi-floor
extension, the photo app passed focused tests, built and launched on Arjun's
physical iPhone through Xcode. A public JPEG request returned valid JSON with an
uncertain result (not an accuracy success), stored=false, under CPU build load.
Current multi-floor verification and installation results are recorded in ignored
`local/ACTIONS.md`; physical cross-floor routes and photo accuracy remain unverified.

Level browsing: prominent B–5 buttons above photo capture synchronize the map and destination-floor filter. All-level browsing is available; selecting a named destination opens its map. Browsing never changes the confirmed user location.
