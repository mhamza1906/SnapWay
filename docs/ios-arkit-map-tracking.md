# iOS ARKit registration and visual correction experiment

October 18, 2026. Isolated branch `experiment/gps-entrance-node19`, continuing
`996f180`. User explicitly requested the ARKit extension on iOS only. No Android
native files, package dependencies, environment keys, active feature checkout,
original map/photo records or production services are changed. Nothing is pushed.

## What is implemented

A new app-local Capacitor `IndoorPose` plugin runs ARKit world tracking with gravity
alignment, yielding session-local camera position in metres at up to 10 JS events/s.
The iOS app opens `/ios-pose-lab`; Android retains `/movement-lab`. The old GPS and
browser experiment remains accessible from the iOS screen. This is native iOS:
Safari and the iOS simulator cannot perform the physical ARKit tracking experiment.

The user confirms two **original stored Level 1 circulation 2 points** on one
straight corridor, at least 2 m apart according to ARKit. Point 19 is the default
first point. The two measurements establish map rotation, translation and uniform
scale. No map north, surveyed scale, absolute location or compass heading is
invented. No cursor moves as a registered estimate before the second anchor.

The horizontal ARKit pose is transformed to the original SVG and constrained to
nearby reachable corridor segments. Connected travel budget and 1.5 m lateral
limit prevent snapping to a nearby disconnected corridor or distant graph loop.
These are conservative display constraints, not proof of a correct map/doorway.
Tracking loss, stale data, session epoch changes, implausible horizontal jumps and
vertical changes beyond 1.5 m invalidate registration. User must register again.
The relative horizontal jump guard is `max(2 m, 4 m/s × elapsed + 0.5 m)`; it is a
walking-experiment rejection heuristic, not a measured accuracy guarantee.

No floor change or fifth-floor clinic arrival is inferred. The known 24↔29 graph
passage/label discrepancy from the video study remains unresolved. Corridor snapping
can hold at that inconsistency; ARKit does not repair source geometry.

## Camera lifecycle and optional MegaLoc correction

The same ARSession supplies optional upright JPEGs, their capture pose and original
monotonic frame time. There is no second camera session, audio, full-video recording,
world-map persistence, local frame file or automatic upload. Start requests camera
permission explicitly; unsupported/denied devices fail with a clear message.
Backgrounding/inactivity, interruption, failure or Stop pauses the session and
invalidates its epoch. New starts use distinct ARSession instances; callbacks and
encoded frames verify generation/session identity to reject obsolete work.

After registration, the user may enable occasional JPEG matching to the displayed
HTTPS test service, initially the existing temporary preview. The new native helper
uses CapacitorHttp JSON, an ephemeral matching-session capability, bounded JPEG size,
redirect refusal and network timeouts. No private engine token, developer cookie or
secret key is copied into the app. Pose/GPS coordinates stay on device; only JPEG
and monotonic capture seconds are sent. Server temporary JPEGs are deleted after
inference, as in the existing browser experiment.

Each correction is explicitly confirmed. It must be a supported known old node,
from the same AR epoch, captured no more than 3 seconds ago, while the latest pose
is normally tracked and fresh. The captured historical pose updates translation
only; the latest pose is then reprojected, preserving movement since capture,
scale and rotation. A late response never teleports the user back to capture time.
Ambiguous matches do not correct the estimate. The UI retains one frame in RAM for
inspection and clears it on Stop. Core native HTTP cannot cancel a running socket;
stopped-run responses are ignored and bounded by transport timeouts.

## Run on an iPhone

Use this separate worktree's `apps/web/ios/App/App.xcodeproj` and the existing
`org.snapway.motionlab` / **SnapWay Motion Lab** identity. Existing installed
SnapWay and the active browser preview are not replaced.

1. Build visitor assets from `apps/web`: `npm run build:visitor`.
2. Copy **only iOS**: `npx cap copy ios`. No Android sync/build is required.
3. Open the Xcode project, choose your development team and physical iPhone, then
   sign and Run. An unsigned `.app` cannot be installed directly from Safari.
4. Allow camera, wait for normal tracking, confirm Point 19 or your actual known
   first point, walk straight to a second known stored point, and register.
5. Walk while keeping visible features in view. Enable optional visual checks if
   the local HTTPS CPU matching service is running; confirm distinctive landmarks.

The temporary matching service still needs this computer awake and online. The
native ARKit motion/registration itself runs locally on the iPhone and does not
need the service. No physical installation or field accuracy validation is claimed.
A prerecorded MOV without synchronized ARKit camera poses/IMU data cannot validate
new VIO accuracy retroactively. Existing video evidence supports scene candidates
only; see [the video study](sam-ibrahim-video-localization.md).

## Implementation and focused verification

- [Native ARKit bridge](../apps/web/ios/App/App/IndoorPosePlugin.swift),
  [registration](../apps/web/ios/App/App/SnapWayViewController.swift),
  [Xcode source membership](../apps/web/ios/App/App.xcodeproj/project.pbxproj),
  [camera usage text](../apps/web/ios/App/App/Info.plist).
- [Native session adapter](../apps/web/src/app/features/movement-lab/indoor-pose.ts),
  [registration/corridor model](../apps/web/src/app/features/movement-lab/ios-pose-model.ts),
  [native HTTP helper](../apps/web/src/app/features/movement-lab/ios-visual-match.ts).
- [Screen](../apps/web/src/app/features/movement-lab/ios-pose-lab.ts),
  [template](../apps/web/src/app/features/movement-lab/ios-pose-lab.html),
  [styles](../apps/web/src/app/features/movement-lab/ios-pose-lab.scss),
  [platform routing](../apps/web/src/app/mobile.routes.ts),
  [web inspection route](../apps/web/src/app/app.routes.ts),
  [web fullscreen shell](../apps/web/src/app/app.ts).
- [Optional JSON endpoint](../scripts/serve_movement_lab.py),
  [capture-clock-aware CPU matcher](../scripts/movement_lab_matcher.py).
- Tests: [7 geometry/pose cases](../apps/web/src/app/features/movement-lab/ios-pose-model.spec.ts),
  [3 session lifecycle cases](../apps/web/src/app/features/movement-lab/indoor-pose.spec.ts),
  [3 transport cases](../apps/web/src/app/features/movement-lab/ios-visual-match.spec.ts).

Focused tests cover transformed scale/rotation, corners, graph disconnections,
staleness, epochs, floor/jump rejection, historical corrections, camera ownership,
permission cancellation and late HTTP replies. The JSON endpoint smoke checks
also cover base64/time validation and preservation of browser JPEG transport.
Validation passed: all 13 focused checks, the visitor production build, iOS asset
copy, and an unsigned ARM64 physical-device Xcode build. The real JSON endpoint
smoke returned an uncertain match after 9.95 s under host load; the app rejects
such stale corrections. Detailed build results are in ignored local/ACTIONS.md.
No Android build or broad regression suite is run for this iOS-only change.

Source references: [ARWorldTrackingConfiguration](https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration),
[ARCamera transform](https://developer.apple.com/documentation/arkit/arcamera/transform),
[Apple world tracking](https://developer.apple.com/documentation/arkit/understanding-world-tracking),
[Capacitor native HTTP](https://capacitorjs.com/docs/apis/http).
