# Outdoor GPS and indoor movement experiment

Updated October 18, 2026. Local branch `experiment/gps-entrance-node19`, based on
`feature/map-authoring-pipeline` commit `bc69e4986bb0620a0eb3918aca0783a4b3c83906`.
No push or deployment is part of this experiment. The active feature checkout,
saved walks, photo IDs, uploads, pipeline and backend are unchanged.

## Test entry and isolation

Open `/movement-lab` on the separate static test server. The temporary HTTPS URL
for this local run is <https://f63b-138-51-70-213.ngrok-free.app/movement-lab>.
It works while the computer, local server and tunnel remain running. The existing
phone preview continues on its own port and tunnel. This server proxies no API,
serves no private environment files, and performs no database or media writes.

The user explicitly confirmed **Sam Ibrahim · Level 1 circulation 2 · Point 19**
as the entry anchor. A read-only snapshot contains 102 vertices and 110 edges,
including the 40 saved photo stops. All snapshot vertices are connected to Point
19. The original Level 1 vector SVG is copied byte-for-byte, with its source hash
recorded in the JSON; graph markers are not baked into the SVG. Only the estimated
current position and optional recent trail are overlaid.

UTSC lists Health & Wellness at **IA5061, floor 5, Sam Ibrahim Building, 1050
Military Trail**. Point 19 is the designated building entry, not a surveyed clinic
door. This prototype tracks only the saved Level 1 circulation; it does not infer
floor changes or guide to the clinic on floor 5.

## Outdoor handoff

Tap **Start outdoor GPS** and allow foreground location. iOS uses Core Location,
Android uses LocationManager GPS/network providers, and the browser uses
`navigator.geolocation.watchPosition` with high accuracy and no cached fix.
Two increasing, fresh timestamps at least two seconds apart must have accuracy
20 m or better, and the entire accuracy circle must fit the arrival radius.
A long gap or a fix outside the accuracy/radius bounds resets arrival dwell.

The editable initial coordinate **43.78838, -79.19103** is an approximate building
centre from OpenStreetMap way 1265894595, verified against its original node
coordinates. It is **not a surveyed entrance coordinate**. The default radius is
70 m. GPS proximity opens the indoor map at Point 19; it cannot establish that a
person actually passed through the door. Confirm the reference point on site.
Google Maps outdoor directions open via its standard external URL; this experiment
does not add an SDK dependency or expose a new API key.

## Indoor estimation and calibration

1. Confirm your known point, initially Point 19.
2. Tap **Allow motion & heading**. Keep the phone facing along the direction you walk.
3. Select a connected reference point. The nearest reachable photo stop is the
   default. Enter the **measured corridor walking distance**, not straight-line
   distance, to that point.
4. While standing at the starting reference point, face the first corridor segment
   toward the destination and calibrate. This sets metres per SVG unit and a heading
   offset; neither map north nor scale is assumed from the original file.
5. Walk with a suitable estimated stride (default 0.72 m). Re-anchor regularly.

The estimate consumes step distance only along existing connected graph edges,
selecting a compatible corridor heading. At an unmatched turn it holds position.
It never creates a shortcut edge or changes pathfinding. Nearby places are the
four closest saved landmarks by straight-line map distance, not doorway routes.
Before scale calibration, numerical nearby distances are hidden. Displayed drift
allowance is a heuristic, not a measured confidence interval.

Native iOS uses `CMPedometer` and relative Core Motion rotation. Native Android
prefers `TYPE_STEP_DETECTOR`, falls back to `TYPE_STEP_COUNTER` with a fresh
session baseline, and uses the rotation vector for magnetic heading. Browser
steps use a conservative acceleration peak detector and orientation events;
they are estimates, not a hardware pedometer API. Explicit motion permission is
requested where supported. No audio, video or camera matching is used here.

Stale/malformed headings and step events are ignored. Real position cannot advance
before confirmation, calibration and a fresh heading. Screen hiding, stopping,
route destruction or screen orientation changes stop sensors and require new
confirmation/calibration. Native lifecycle hooks also stop background sensors.
No sensor readings are persisted or uploaded. There is no background geofence.
Compass interference, phone pose changes and stride errors can cause drift;
physical-device and on-site accuracy have **not** been validated.

The separately labelled simulation uses synthetic GPS, heading and map scale;
it does not request real sensors. Try arrival, DEMO calibration, steps and turns.
Stop simulation before starting real GPS. Simulation success is not evidence of
physical localization accuracy.

## Run and native builds

From `apps/web`, with the repository's Node 24 toolchain and pinned dependencies:

```sh
npm run build:visitor
```

From the repository root:

```sh
python3 scripts/serve_movement_lab.py
```

Open <http://localhost:4300/movement-lab>. A remote phone requires HTTPS; a
separate tunnel may point to `127.0.0.1:4300`. Do not replace the existing test
tunnel. The server exposes static built assets only and blocks API/pipeline paths.

Native test identity is **org.snapway.motionlab**, displayed as **SnapWay Motion
Lab**, so installing it later can coexist with the regular app. Its root route
opens the experiment; the earlier chooser is preserved under `/app-home`.
After the visitor build, run `npx cap sync android` / `npx cap sync ios` from
`apps/web`. Use Android Studio or Xcode for physical-device installation. Nothing
was installed on a connected device by this task; unsigned simulator builds do
not provide iPhone installation/signing.

## Files and checks

- [Model and GPS gate](../apps/web/src/app/features/movement-lab/movement-model.ts),
  [model tests](../apps/web/src/app/features/movement-lab/movement-model.spec.ts).
- [UI](../apps/web/src/app/features/movement-lab/movement-lab.ts),
  [template](../apps/web/src/app/features/movement-lab/movement-lab.html),
  [styles](../apps/web/src/app/features/movement-lab/movement-lab.scss),
  [UI tests](../apps/web/src/app/features/movement-lab/movement-lab.spec.ts).
- [Sensor adapter](../apps/web/src/app/features/movement-lab/navigation-sensors.ts),
  [adapter tests](../apps/web/src/app/features/movement-lab/navigation-sensors.spec.ts).
- [iOS plugin](../apps/web/ios/App/App/NavigationSensorsPlugin.swift), registered in
  [controller](../apps/web/ios/App/App/SnapWayViewController.swift) and
  [project](../apps/web/ios/App/App.xcodeproj/project.pbxproj); motion description in
  [Info.plist](../apps/web/ios/App/App/Info.plist).
- [Android plugin](../apps/web/android/app/src/main/java/org/snapway/app/NavigationSensorsPlugin.java),
  [registration](../apps/web/android/app/src/main/java/org/snapway/app/MainActivity.java),
  [permissions](../apps/web/android/app/src/main/AndroidManifest.xml).
- Isolated identity: [Capacitor config](../apps/web/capacitor.config.ts),
  [Android build](../apps/web/android/app/build.gradle),
  [Android labels](../apps/web/android/app/src/main/res/values/strings.xml).
- [Web routes](../apps/web/src/app/app.routes.ts),
  [native routes](../apps/web/src/app/mobile.routes.ts),
  [web fullscreen shell](../apps/web/src/app/app.ts).
- [Snapshot](../apps/web/public/experiments/entrance-node19.json),
  [clean SVG](../apps/web/public/experiments/sam-level1-clean.svg),
  [static server](../scripts/serve_movement_lab.py).

Focused checks: 19 tests across model, sensor adapter, UI and existing app chooser;
production web and visitor bundles; Swift typecheck and Android Java compilation;
plist/project validation; HTTP 200 for page/JSON/SVG and API 404 on the static lab.
Android debug APK and unsigned iOS simulator app builds both passed. The APK
is available for this run at [Download the separate Android test app](https://f63b-138-51-70-213.ngrok-free.app/experiments/snapway-motion-lab.apk).
It is also at `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`.
The iOS simulator bundle is `/tmp/snapway-motion-lab-build/Build/Products/Debug-iphonesimulator/App.app`; a real iPhone still requires Xcode signing/install.
No native app was installed. The initial Android build encountered pre-existing
iCloud duplicate resource files in shared dependencies. The successful build
used a filtered dependency copy and Gradle init override under ignored `local/`,
without deleting or editing the original dependencies. A fresh pinned install
on another machine should use the normal build path. Detailed commands and
results are recorded in ignored `local/ACTIONS.md`. No package
or environment contract changes were required. Local action history also records
the read-only snapshot export and isolation verification.

## Primary references

- [UTSC Health & Wellness location](https://utsc.utoronto.ca/grad-edu/health-counselling-services)
- [UTSC student resource listing](https://www.utsc.utoronto.ca/acm/student-resources)
- [OSM building outline](https://www.openstreetmap.org/way/1265894595)
- [Apple CMPedometer](https://developer.apple.com/documentation/coremotion/cmpedometer)
- [Android motion sensors](https://developer.android.com/develop/sensors-and-location/sensors/sensors_motion)
