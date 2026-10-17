# iOS visitor app (Capacitor) and photo localization

Shared feature record for the iPhone visitor app and its camera-based place matching.
Work lives on branch `feature/mobile-ios` (cut from `main` at `71f24ab`, `main` merged at
`2dfd1ef`). Personal execution history is in ignored `local/ACTIONS.md`. The brief is
[`apps/place-match/IOS_AGENT_PROMPT.md`](../apps/place-match/IOS_AGENT_PROMPT.md).

## Approved scope

The [architecture plan](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
lists native iOS as outside the present scope. Arjun requested this branch (2026-10-17),
the camera/matching work, and committing `apps/place-match` here; team agreement is still
needed before merging into `main`.

- Same Angular visitor entry and UI that Android ships, with a phone layout.
- Dependencies: `@capacitor/ios` **8.4.3** (pinned like core/android/cli). The camera
  plugin is app-local Swift (no npm or Swift package). The Django gateway uses only
  existing packages (Pillow, DRF, drf-spectacular, standard-library HTTP). The engine's
  mobile API uses FastAPI/uvicorn already in `apps/place-match/pyproject.toml`.
- Bundle identifier `org.snapway.app`, the same as Android.

## Non-goals

- On-device MegaLoc (Core ML), the parity check, licence review (§6 of the brief)
- Real-phone validation set and recalibrated thresholds (§8)
- Signing, TestFlight, App Store; iOS CI; any cloud resource (see the
  [production plan](place-match-production.md), nothing provisioned)
- Persisting frames or results in `navigation.Capture`/`LocalizationResult` (both need a
  stored image asset; frame retention is not approved)

## How it fits together

```text
iPhone (Angular visitor UI) ──FrameCapture (Swift)──► HTTPS ─┬─► place-match engine  /v1/*          (dev, via ngrok)
                                                             └─► SnapWay API /api/navigation/localize/* ──► engine (private)
engine: MegaLoc local (default) → Vertex AI only as fallback / verified second opinion
```

| Piece | Path |
| --- | --- |
| Camera plugin | [`apps/web/ios/App/App/FrameCapturePlugin.swift`](../apps/web/ios/App/App/FrameCapturePlugin.swift), registered by [`SnapWayViewController.swift`](../apps/web/ios/App/App/SnapWayViewController.swift) |
| Visitor UI | [`live-locate.*`](../apps/web/src/app/features/navigation/), [`frame-capture.ts`](../apps/web/src/app/core/frame-capture.ts), [`place-match.ts`](../apps/web/src/app/core/place-match.ts) |
| Django gateway | [`apps/api/navigation/`](../apps/api/navigation/) `views.py`, `authentication.py`, `permissions.py`, `services/placematch.py` |
| Engine mobile API | [`apps/place-match/placematch/mobile_api.py`](../apps/place-match/placematch/mobile_api.py), [`mobile_decide.py`](../apps/place-match/placematch/mobile_decide.py), [`reference_sets.py`](../apps/place-match/placematch/reference_sets.py) |

### Capture (iOS)

- Permission: status checked before any capture; explanation screen before
  `requestAccess`; denied/restricted show **Open Settings**, **Import a video** and
  manual start. No microphone, location or photo-library permission is requested.
- `AVCaptureSession` (back wide camera, 1280×720) with `AVCaptureVideoDataOutput`;
  0.5–5 fps (default 1) selected by presentation timestamp; frames made upright with
  `RotationCoordinator` (iOS 17+) or device orientation; JPEG ≤ 1024 px at quality 0.9
  encoded off the main thread; per-frame `client_frame_id`, `timestamp_s`,
  `captured_at`, orientation and device brightness/blur flags.
- Video import via `PHPickerViewController` (no library permission);
  `AVAssetImageGenerator` with zero tolerance records each frame's actual time.
- Stops on background, interruption, camera error or serious thermal state. Frames live
  in Application Support (excluded from backup), at most 30 kept, with **Delete captured
  frames**. Uploads happen only per tap or with the labelled auto-send toggle.

### Matching rules (engine)

MegaLoc decides first. Vertex AI runs only when MegaLoc is unavailable or, with **second
opinion** on, when MegaLoc is `uncertain`; it always runs geometric verification and
can only report `likely_match` with verification passing (and, as a second opinion, at
MegaLoc's top-1 `location_id`). Disagreement is `uncertain`; no backend is HTTP 503,
never a guess. Responses carry `backend_used`, `fallback_used`, `second_opinion_used`,
`thresholds_id` (hash of `data/calibration/current.json`), raw cosines labelled
"similarity" (never %), verification and per-stage `timings_ms`.

### Authentication

- Engine (`serve-mobile`, 127.0.0.1:8790): `Authorization: Bearer <MOBILE_API_TOKEN>`,
  per-token rate limit, JPEG ≤ 3 MB and ≤ 4096 px, no frame storage (unless
  `MOBILE_STORE_FRAMES=1`), no token/image logging. The UI server (8777) is never tunnelled.
- SnapWay API (`/api/navigation/localize/`): a signed-in user, an active visitor
  `NavigationSession` (`Authorization: Navigation <secret>`, digest stored), or
  `PLACEMATCH_DEV_TOKEN` as a bearer token **only while `DEBUG` is true**; scoped throttle
  `LOCALIZATION_RATE`.
- iPhone: server address and token are entered in the debug-only settings screen; the
  token goes to the Keychain (`WhenUnlockedThisDeviceOnly`) and never to JavaScript.
  Release builds hide the screen and cannot upload until visitor sessions exist.

## Arjun's setup steps (not done by the agent)

1. Engine, from `apps/place-match`:
   ```sh
   uv run placematch build-references --references <folder with location subfolders> --name <set>
   uv run placematch build-references --references <same folder> --name <set> --backend vertex --dry-run   # then with --limit N
   uv run placematch mobile-token --create        # prints the token once
   MOBILE_REFERENCE_SET=<set> uv run placematch serve-mobile
   ```
2. Install ngrok (`brew install ngrok`), create the account and run
   `ngrok config add-authtoken …` yourself, then `ngrok http 127.0.0.1:8790`. Only that
   port is forwarded. **While the tunnel runs, the endpoint is reachable from the
   internet and frames you send leave the phone. Stop it when not testing.**
3. On the iPhone (Debug build from Xcode): **Locate with camera** → settings icon →
   paste the `https://…ngrok-free.app` address and the token → **Test** → **Save**.
4. Optional SnapWay API path: set `PLACEMATCH_ENGINE_URL=http://127.0.0.1:8790`,
   `PLACEMATCH_ENGINE_TOKEN` (= `MOBILE_API_TOKEN`) and `PLACEMATCH_DEV_TOKEN` in
   `local/env/api.env`; choose "SnapWay API" in the app.

## How to run the app

From `apps/web` with Node 24.15+ and npm 11: `npm ci`, `npm run ios:sync`,
`npx cap open ios`, then Run in Xcode (simulator or a signed iPhone; Xcode 26+).

## Verification

- Engine: `pytest` 94 passed, 10 skipped (data/weights absent), including 11 new offline
  mobile tests (decision rules, auth, validation, rate limit, thumbnails, index export);
  `ruff check` and `ruff format --check` clean.
- API: root `pytest` 56 passed, 16 skipped (7 new localization tests); `ruff` clean;
  `manage.py check --deploy` has no drf-spectacular warnings; no migrations needed.
- Web: `npm test` 61/61; `npm run build` and `build:visitor` without budget warnings;
  Prettier clean. Xcode Debug and Release builds compile.
- **Not tested** (by request, and no device was used): camera permission flows, frame
  orientation and timestamps on a physical iPhone, video import, uploads through ngrok,
  latency over Wi-Fi/cellular, MegaLoc/Vertex on real phone frames. Thresholds come
  from dataset images and must be re-validated on iPhone captures before being trusted.
- Earlier visitor-layout checks (browser 390×844, iPhone 17e/SE simulators) still apply.

## Changed files

- iOS: `apps/web/ios/App/App/{FrameCapturePlugin,SnapWayViewController}.swift`,
  `Base.lproj/Main.storyboard`, `App.xcodeproj/project.pbxproj`, `Info.plist` (camera text)
- Web: `src/app/core/{frame-capture,place-match,place-match.spec}.ts`,
  `src/app/features/navigation/{live-locate.*,navigation.ts,navigation.html}`, plus the
  earlier phone shell (`index.visitor.html`, `styles.visitor.scss`, `angular.json`,
  `capacitor.config.ts`, `package.json`)
- API: `apps/api/navigation/{authentication,permissions,views,urls}.py`,
  `navigation/services/placematch.py`, `config/settings/base.py`, `config/urls.py`,
  `tests/test_localization.py`, `.env.example`
- Engine: `apps/place-match/` (first commit) with new `mobile_api.py`, `mobile_decide.py`,
  `reference_sets.py`, CLI commands and `tests/test_mobile_api.py`
- Docs: this file, [place-match-production.md](place-match-production.md),
  [visual-place-matching.md](visual-place-matching.md)

## Commits

- `4dd1045` feat(ios): add Capacitor iOS visitor app with phone layout
- `75870f6` Merge origin/main into feature/mobile-ios
- Camera capture and MegaLoc-first matching: recorded after its commit.
