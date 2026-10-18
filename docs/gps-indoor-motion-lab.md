# GPS, original-node video replay and live camera experiment

Updated October 18, 2026. Isolated local branch `experiment/gps-entrance-node19`,
based on feature `bc69e49`; first motion-only implementation `dcc634a`. No push,
production change, original photo edit, DB write or active feature-preview change.

[Open the browser test](https://f63b-138-51-70-213.ngrok-free.app/movement-lab).
The computer and tunnel must stay online. Local fallback is
<http://localhost:4300/movement-lab>. The new camera test is browser-only; the
active native apps/camera flow are unchanged. Older experimental native builds
have motion sensors but do not include the new browser endpoint wiring.

## Original reference nodes

The experiment restores the original exported Level 1 circulation 2 graph:
**26 photographed points, 104 directional photos, 88 vertices and 96 open edges**.
Original node UUIDs and coordinates are preserved, including user-confirmed entry
Point 19 at (713,142). Previously removed empty stops 5,6,23,30 remain absent;
the 14 later stops 31–44 have no reference images and are excluded. Support
vertices describe corridors only. No new camera coordinates are invented.

The original SVG remains byte-identical. An optional reference layer uses tiny
true-position dots and only one selected label; zoom to 4× and scroll/pan. The
normal map hides graph points. Nearby places and measured motion calibration
remain available. Reference density alone cannot improve visual evidence.

## What the video supports

All 366 cached query vectors from the 182.883-second original `IMG_1275.MOV` were
replayed against 104 cached reference vectors. Four directions stay separate;
maximum directional cosine gives each old node's score. Different-node margin,
frame quality and graph consistency determine whether to abstain. Reference
vectors are not recomputed and video frames never enter the reference gallery.

| Time | Old point candidate | Independently inspected scene |
|---|---|---|
| 0:54 | 25 | Elevator bank/control pillar |
| 1:18 | 27 | Recessed doors/cabinet below purple wall |
| 2:06 | 19 | Glass vestibule, mat and blue opener |
| 2:36 | 15 | Black/green/blue bins |

Earlier geometric overlap checks support 54/78/156 seconds; 126 seconds is
inconclusive. These are scene candidates, not surveyed poses. The opening also
resembles Point 19, conflicting with the recalled Point 1 start. The blurred
endpoint alternates around 11/12 rather than proving 10/22. Hints never force
predictions or relabel photos.

The defensible scene sequence is lobby/reception → elevator/service alcove →
purple-door corridor → event-table/green seating → entrance → reverse past
seating → bins → atrium railing. Exact nearby nodes often remain ambiguous.
Point 24→29 has a 460.7-plan-unit graph detour despite only 35 units straight-line
separation: passage geometry or photo labels need checking. No shortcut is added.

The new tracker is forward-only, with decaying graph history and a conservative
relative-spacing jump guard. It never reads future frames or upgrades weak visual
evidence. Stale reacquisition breaks the trail. It infers no metric speed.
Observed raw candidates changed nodes 141 times, causal candidates 65 times.
Of 366 samples, 155 meet transferred thresholds and the graph guard, 129 are
uncertain and 82 unsupported. **These are not accuracy counts.** Consecutive
supported pairs have a maximum 28-plan-unit graph jump versus 520.8 for raw
candidates; uncertain diagnostic candidates may still jump.

Tap **Load video route evidence**, play and inspect the candidate. Only past
observations are eligible. The local 10-fps compressed preview contains original
video content without overlays/audio; embeddings/timestamps come from the original
MOV. Replay never automatically changes the live position.

## Live browser matching

Tap **Allow rear camera & start matching** in Safari/Chrome on the HTTPS page.
It sends one JPEG at a time, waiting 1.25 seconds after each response. There is no
frame queue, full-video/audio recording, incoming-frame cache, reference mutation
or DB write. Temporary JPEG files are deleted after inference. Model and original
reference vectors stay in RAM; CPU uses eight threads and existing pinned weights.
No downloads, provider calls, private service tokens or env files are exposed.
Sessions are isolated/expiring; only one inference slot runs at a time.

Candidates remain separate from the green step estimate. Only explicit user
confirmation of a current supported candidate re-anchors it, followed by fresh
calibration. Ambiguous, unknown or stale observations cannot move the cursor.
Stop, hiding and destruction release the camera and abort requests. Native
Capacitor builds direct this new camera experiment to the HTTPS browser.

## GPS, motion and accuracy recommendation

GPS still opens Level 1 at Point 19 after two fresh accurate readings at least two
seconds apart. The entire accuracy circle must fit the radius. Default
43.78838,-79.19103 is the provisional OSM building centre, radius70m, not a
surveyed entrance. UTSC lists Health & Wellness at IA5061 on floor5 of Sam
Ibrahim Building; this test neither locates the clinic door nor detects floors.
Native CMPedometer/Core Motion, Android step/rotation sensors and browser motion
estimates remain opt-in. Confirm an anchor, enter measured corridor distance and
calibrate facing. Steps follow existing edges only. Re-anchor after interruptions
or pose changes. Nearby distances and drift allowance are heuristic estimates.

Best immediate method: original photographed nodes, periodic verified visual
corrections, calibrated steps/yaw between them, graph constraints and an unknown
state. Capture distinctive extra views at ambiguous existing nodes. Check passage
geometry/labels and validate on separate, independently labelled recordings.

For more accurate continuous 2D movement, register native visual-inertial camera
pose to the SVG with measured anchors, then correct drift with verified visual
references or surveyed markers. ARKit/ARCore combine camera and IMU information.
This is a recommendation, not implemented native VIO. The MOV has no synchronized
sensor log, surveyed poses or metric ground truth. Physical accuracy is untested.

## Reproduce and inspect

Use the existing pinned Python runtime; no new dependency/env contract changes.
From repository root:

```sh
python3 scripts/export_movement_reference_plan.py --manifest ../Hack_The_valley/MegaLoc-Video-Test/reference-manifest.json
PYTHONPATH=apps/place-match ../SnapWay/apps/place-match/.venv/bin/python -m placematch.ops.causal_point_tracking --run ../Hack_The_valley/MegaLoc-Video-Test --output local/old-node-replay
# From apps/web: npm run build:visitor
PYTHONPATH=apps/place-match ../SnapWay/apps/place-match/.venv/bin/python scripts/serve_movement_lab.py --run ../Hack_The_valley/MegaLoc-Video-Test --model-cache ../SnapWay/apps/place-match/data/models/megaloc --video local/old-node-replay/source-preview.mp4
```

The replay CLI writes ignored artifacts. The reviewed browser JSON is copied to
`apps/web/public/experiments/old-node-replay.json`, with video src
`/experiments/source-video.mov`. Video/model/index bytes stay local; only the
explicit preview video has ranged read-only playback. No application API,
pipeline or account endpoints are proxied.

- [Causal tracker](../apps/place-match/placematch/causal_tracking.py),
  [replay CLI](../apps/place-match/placematch/ops/causal_point_tracking.py),
  [five tracker tests](../apps/place-match/tests/test_causal_tracking.py).
- [Reference exporter](../scripts/export_movement_reference_plan.py),
  [CPU matcher](../scripts/movement_lab_matcher.py),
  [isolated server](../scripts/serve_movement_lab.py).
- [Lab UI](../apps/web/src/app/features/movement-lab/movement-lab.ts),
  [template](../apps/web/src/app/features/movement-lab/movement-lab.html),
  [styles](../apps/web/src/app/features/movement-lab/movement-lab.scss),
  [camera](../apps/web/src/app/features/movement-lab/camera-lab.ts),
  [UI tests](../apps/web/src/app/features/movement-lab/movement-lab.spec.ts),
  [camera lifecycle tests](../apps/web/src/app/features/movement-lab/camera-lab.spec.ts).
- [Old plan](../apps/web/public/experiments/entrance-node19.json),
  [replay evidence](../apps/web/public/experiments/old-node-replay.json),
  [unchanged SVG](../apps/web/public/experiments/sam-level1-clean.svg).
- [Earlier video study/source evidence](sam-ibrahim-video-localization.md),
  [canonical MegaLoc architecture](localization-megaloc.md).

Minimal checks: five tracker, four UI and two camera lifecycle tests; visitor
build; cached-vector replay; actual held-out JPEG inference, ranged playback and
endpoint smoke checks. No full-suite or physical accuracy claim. Detailed evidence
and action history remain under ignored `local/`.

Sources: [Apple world tracking](https://developer.apple.com/documentation/arkit/understanding-world-tracking),
[ARCore concepts](https://developers.google.com/ar/develop/fundamentals),
[UTSC location](https://utsc.utoronto.ca/grad-edu/health-counselling-services),
[OSM outline](https://www.openstreetmap.org/way/1265894595).
