# iOS visitor app (Capacitor) and photo localization

Shared feature record for the iPhone visitor app and its camera-based place matching.
Work lives on branch `feature/mobile-ios` (cut from `main` at `71f24ab`, `main` merged at
`2dfd1ef`). Personal execution history is in ignored `local/ACTIONS.md`. The brief is
[`apps/place-match/IOS_AGENT_PROMPT.md`](../apps/place-match/IOS_AGENT_PROMPT.md).

## Approved scope

The [architecture plan](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
lists native iOS as outside the present scope. Arjun requested this branch (2026-10-17),
the camera/matching work, committing `apps/place-match` here, and merging it into `main`
(2026-10-17, pull request without other team review).

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
   uv run placematch mobile-token --create        # writes shared token; does not print it
   MOBILE_REFERENCE_SET=<set> uv run placematch serve-mobile
   ```
2. Install ngrok (`brew install ngrok`), create the account and run
   `ngrok config add-authtoken …` yourself, then `ngrok http 127.0.0.1:8790`. Only that
   port is forwarded. **While the tunnel runs, the endpoint is reachable from the
   internet and frames you send leave the phone. Stop it when not testing.**
3. On the iPhone (Debug build from Xcode): **Locate with camera** → settings icon →
   paste the `https://…ngrok-free.app` address and the token → **Test** → **Save**.
4. Optional SnapWay API path: set `PLACEMATCH_ENGINE_URL=http://127.0.0.1:8790`,
   `PLACEMATCH_ENGINE_TOKEN` (the same canonical token the engine reads) and `PLACEMATCH_DEV_TOKEN` in
   `local/.env`; choose "SnapWay API" in the app.

## How to run the app

From `apps/web` with Node 24.15+ and npm 11: `npm ci`, `npm run ios:sync`,
`npx cap open ios`, then Run in Xcode (simulator or a signed iPhone; Xcode 26+).

On a physical iPhone: Xcode › Settings › Accounts with your Apple ID, target **App** ›
Signing & Capabilities › your Personal Team (change the bundle id if `org.snapway.app` is
taken), connect the phone, enable Developer Mode, Run, then on the phone trust the
certificate under Settings › General › VPN & Device Management. Free provisioning
expires after 7 days. The simulator has no camera: use **Import a video** there.

Endpoint, request/response and plugin details: [mobile-ios-api.md](mobile-ios-api.md).

## Physical-device test checklist (§9 of the brief)

Not yet run. Record each result (device, iOS version, build, date) in `local/ACTIONS.md`
and summarize here.

| Area | Check | Expected |
| --- | --- | --- |
| Permission | First open of **Locate with camera** | Explanation screen, no system prompt until **Allow camera** |
| | Deny, then reopen | Blocked screen with **Open Settings**, **Import a video**, manual start |
| | Screen Time camera restriction | "restricted" text, no Settings button |
| | Re-enable in Settings, return | Capture view after reopening the sheet |
| Capture | 0.5 / 1 / 2 / 5 fps for 30 s | Frame count ≈ fps × 30; `timestamp_s` increases evenly |
| | Portrait, both landscapes, upside down | Preview and uploaded JPEG upright; `orientation` matches |
| | Dark room, fast pan | `underexposed` / `blurry` flags; engine `quality.flags` agree |
| | Lock the phone / switch app / incoming call | Capture stops with the matching message |
| | 31+ frames | Only the newest 30 kept; **Delete captured frames** removes all |
| Video | 10 s and 2 min clips, HEVC and H.264 | Frames at the chosen fps, `source: "video"`, stops at 120 |
| Upload | Wi-Fi and cellular through ngrok | 200 with outcome, backend, thresholds id; note round trip |
| | Airplane mode | "Offline" note, nothing sent, no location |
| | Wrong token / stopped engine / stopped tunnel | Error message (401 / 503 / connection), never a location |
| Matching | Standing at each reference location | `likely_match` at the right `location_id`, or `uncertain` — never a wrong accept |
| | Unmapped corridor | `uncertain` or `no_supported_match` |
| | Second opinion on, MegaLoc uncertain | `backend_used: "megaloc+vertex"`; accepts only with verification |
| Start | `likely_match` on a mapped checkpoint | "Use … as start" sets the route start; manual choice still works |

Latency to note per frame: app round trip vs. `timings_ms.total`, `embed_megaloc`,
`verify_*`. Expect ~0.3 s MegaLoc on the M3 plus network; verification adds ~1.2 s.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Use an https:// address" when saving | Plain `http://` to a LAN or tunnel address | Use the `https://…ngrok-free.app` address; `http` is accepted only for `localhost` in the Simulator |
| **Test** fails with a connection error | Tunnel or `serve-mobile` not running, or campus Wi-Fi isolates devices | Check `curl https://<tunnel>/v1/health -H "Authorization: Bearer …"` from the Mac; use cellular or a Personal Hotspot |
| HTTP 401 | Token mismatch, or the dev token used with `DEBUG` off | Paste the token again (Settings › Clear, then Save); for SnapWay mode check `PLACEMATCH_DEV_TOKEN` and `DEBUG` |
| HTTP 502 (SnapWay mode) | `PLACEMATCH_ENGINE_TOKEN` differs from the engine's `MOBILE_API_TOKEN` | Copy the engine token into `local/.env` and restart the API |
| HTTP 503 `not_configured` | `PLACEMATCH_ENGINE_URL` empty | Set it to `http://127.0.0.1:8790` |
| HTTP 503 `no_backend_available` | No index for the set, or MegaLoc weights missing and Vertex disabled | **Test** lists ready backends; run `build-references` for the missing backend |
| Always `uncertain` | `thresholds_id: "uncalibrated"` or iPhone frames differ from the calibration images | Check `data/calibration/current.json`; recalibrate on iPhone captures (§8) |
| HTTP 429 | Rate limit | Lower fps or turn off auto-send; raise `MOBILE_RATE_LIMIT_PER_MIN` only for local tests |
| "The server returned an unexpected response." | Ngrok free-tier interstitial or a wrong address (native requests normally skip the interstitial) | Check the address; if it persists, the plugin would need an `ngrok-skip-browser-warning` header (not added) |
| Camera never starts | Permission denied, simulator, or another app holds the camera | Blocked screen explains; use a device or **Import a video** |
| "Developer App Certificate is not trusted" | First install with a Personal Team | Settings › General › VPN & Device Management › trust |
| Settings icon missing | Release build | Run the Debug scheme; Release cannot upload until visitor sessions exist |

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
- Docs: this file, [mobile-ios-api.md](mobile-ios-api.md),
  [place-match-production.md](place-match-production.md),
  [visual-place-matching.md](visual-place-matching.md), README pointers

## Commits

- `4dd1045` feat(ios): add Capacitor iOS visitor app with phone layout
- `75870f6` Merge origin/main into feature/mobile-ios
- `03ea4da` feat(ios): camera capture and MegaLoc-first place matching
- docs(ios): API/plugin reference, device test checklist, troubleshooting
