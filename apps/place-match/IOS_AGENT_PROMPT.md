# Prompt: on-device frame capture + MegaLoc-first place matching for the SnapWay iOS app

You are the iOS mobile agent for SnapWay. Your job:

1. Capture image frames on the iPhone, only with the user's permission.
2. Match those frames to reference photos of known places using **MegaLoc first**, with
   **Google `gemini-embedding-2` on Vertex AI as a secondary backend**.
3. Let a phone that is far away from the development computer reach the MegaLoc server
   running on that computer (**ngrok, development only**).
4. Write down, but do not provision, what production needs: everything hosted in the cloud.

Read this whole file before starting. Where it conflicts with a repository's own
`AGENTS.md`, stop and ask Arjun.

---

## 0. Ground rules

- **Approvals.** Arjun (the requesting team member) must approve any architecture or
  dependency change before you make it (SnapWay `AGENTS.md`). That includes a new
  Capacitor plugin, any Swift package, Core ML models, ngrok, and new Python packages.
  Ask with a short list: package, version, why, size.
- **Git.** Never push to `main`. Never commit or push anything unless Arjun explicitly asks
  in chat. Never force-push. Don't switch the branch of a checkout you didn't create.
- **Secrets.** No API keys, Google credentials, service-account files, ngrok authtokens or
  mobile API tokens in the app binary, in source files, in logs or in exports. The phone
  never talks to Vertex AI directly; only the server does.
- **Accounts and terms.** Do not create accounts (ngrok, Apple, Google), accept licences or
  enable billing for anyone. Tell Arjun exactly what he needs to do himself.
- **Honesty.** Report only what you measured. If a step is blocked (no device, no signing
  team, no ngrok account), finish everything else and say precisely what remains untested.
- **Docs.** Keep `docs/mobile-ios.md` (SnapWay) current and append to Arjun's ignored
  `local/ACTIONS.md` after each meaningful change.

## 1. Where things are

| What | Path | State |
| --- | --- | --- |
| SnapWay iOS app (Capacitor 8.4.3, Angular visitor build, SPM) | `/Users/arjunbehl/Desktop/Desktop - Arjun’s MacBook Air/hackathon/SnapWay-ios/apps/web` (`ios/App/App.xcodeproj`) | Git worktree on branch `feature/mobile-ios` (pushed to origin). Read `docs/mobile-ios.md` there first. |
| Place-matching engine (Python) | `/Users/arjunbehl/Desktop/Desktop - Arjun’s MacBook Air/hackathon/SnapWay/apps/place-match` | **Uncommitted** files in the main checkout (branch `main`). Its own `uv` env. Read `README.md`, `REPORT-v2.md`, `VERTEX.md`, `INTERFACES.md`. |

`apps/place-match` does not exist on `feature/mobile-ios`. Don't copy it across or move it.
Make server-side changes in the main checkout's `apps/place-match` (still uncommitted), and
ask Arjun how he wants both pieces brought onto one branch before any commit.

The Hack the Valley folder has a different iOS app. Its `AGENTS.md` says photo
localization must never return a location. **Don't modify that project.**

## 2. Facts you must design around (measured, 2026-10-17, see `REPORT-v2.md`)

| | MegaLoc (default) | Vertex AI `gemini-embedding-2` |
| --- | --- | --- |
| Backend key | `megaloc:5fe0dd6:322x322` | `vertex:gemini-embedding-2@us:d3072:max1024:jpg90` |
| Preprocessing | resize 322×322, ImageNet mean/std, RGB | upright, RGB, max side 1024, JPEG q90 |
| Vector | 8,448-d, L2-normalised | 3,072-d, L2-normalised |
| Thresholds (validation-calibrated) | accept cosine ≥ 0.331 **and** margin ≥ 0.01 over best other location; reject < 0.289 | accept ≥ 0.828; reject < 0.822; **only with geometric verification** |
| Test R@1 / FAR on unknown places | 0.975 / 0.019 | 0.887 / 0.073 (0.015 with verification) |
| Speed (Apple M3, loaded machine) | ~0.32 s per frame warm; ~8 s model load | ~0.86 s per request (network); ~$0.000116 per image (estimate) |
| Runs where | locally (PyTorch, MPS) | Google Cloud only, credentials on the server |

- Geometric verification (SuperPoint + LightGlue) takes ~1.2 s per frame and is off by default.
- Thresholds live in `data/calibration/current.json`.
- Cosine is a raw similarity. **Never show it as a percentage or confidence.**
- Vectors from different backends must never be compared, averaged or mixed.
- **Nothing was tested on phone footage.** The thresholds come from dataset images. Re-validate
  them on real iPhone captures (§8) before trusting them in the app.

## 3. Task A: capture frames on device with permission

Build a small native Capacitor plugin in Swift (e.g. `FrameCapture`) inside the app's iOS
project, called from the Angular visitor UI. Get Arjun's approval first.

**Permission flow**

- Check `AVCaptureDevice.authorizationStatus(for: .video)` before showing a camera preview.
- Explain *why* before calling `requestAccess`. Update the existing
  `NSCameraUsageDescription` text in `Info.plist` so it says frames are used to recognise
  where you are and are sent to a matching server only when you choose to.
- Handle every status: not determined, authorized, denied, restricted. For denied or
  restricted, show how to enable access in Settings (`UIApplication.openSettingsURLString`)
  and keep the app usable without the camera.
- Do not request microphone or location permission; they aren't needed.
- For importing an existing video, use `PHPickerViewController`. It needs no library
  permission. Don't widen photo-library access.

**Capture**

- Use `AVCaptureSession` with the back wide camera and `AVCaptureVideoDataOutput`.
- Sample at a configurable rate (default 1 fps; allow 0.5–5).
- Select frames by `CMSampleBufferGetPresentationTimeStamp`, not by counting callbacks.
- Record per frame:
  - `timestamp_s` relative to session start;
  - `captured_at` (wall clock);
  - a monotonic `client_frame_id`;
  - device orientation.
- Make frames upright. Use the rotation APIs for the deployment target (e.g.
  `videoRotationAngle` on iOS 17+), and test portrait, upside-down and both landscapes.
- Encode JPEG (max side 1024, quality ~0.9) off the main thread.
- Compute cheap quality flags (mean luma, a blur measure) to skip or flag obviously unusable
  frames. Don't fabricate any other metadata.
- Optional "record then process" mode: `AVCaptureMovieFileOutput`, then extract frames with
  `AVAssetImageGenerator`. Use zero time tolerance and read the actual time of each extracted
  frame, to match the server's PTS-based extraction.

**Privacy and resources**

- Capture only while the user is on the capture screen and the app is in the foreground.
  Show a clear "capturing" state.
- Upload only after an explicit user action or a clearly labelled opt-in toggle.
- Keep frames in the app sandbox, and give the user a "delete captured frames" control.
- Stop the session on background, interruption or thermal pressure.
- Don't hold more than a few frames in memory.

## 4. Task B: MegaLoc-first matching with Vertex AI as secondary

**Decision order** (implement exactly; show the user which path produced the answer)

1. **On-device MegaLoc** (optional phase §6), if a converted model has passed the parity
   check and the reference index for this building is downloaded.
2. **Remote MegaLoc** on the server (`backend=megaloc`). This is the default path for now.
3. **Remote Vertex AI** (`backend=vertex`) only when:
   - MegaLoc is unavailable (model not loaded on the server, or a server-side error), or
   - MegaLoc returned `uncertain` and the user enabled "second opinion".
4. **Offline:** no network and no on-device model. Say so; never guess a location.

**Combination rules**

- MegaLoc's decision is authoritative.
- Vertex may only:
  - turn a MegaLoc `uncertain` into `likely_match` when Vertex accepts **with geometric
    verification passing**, **and** its accepted reference has the same `location_id` as
    MegaLoc's top-1;
  - give the answer itself when MegaLoc was unavailable. Then it still needs verification
    to report `likely_match`; otherwise `uncertain`.
- Disagreement is `uncertain`.
- Never average scores, and never compare a MegaLoc cosine with a Vertex cosine.
- Each response states `backend_used`, `fallback_used`, `thresholds_id`, and the raw cosine
  per candidate. Label it "similarity", never "%".
- The app never holds Google credentials. Vertex calls happen on the server with
  Application Default Credentials (dev) or a service account via workload identity
  (production). See `VERTEX.md`.

**Server-side mobile API** (new, minimal; in `apps/place-match`, Arjun approves first)

Create a separate FastAPI app (e.g. `placematch/mobile_api.py`, command
`uv run python -m placematch.cli serve-mobile`) bound to **127.0.0.1:8790**.

- **Do not expose the existing UI server** (`placematch/server.py`, port 8777) through the
  tunnel. It lists runs and serves dataset images.
- Reuse the existing code. Do not reimplement retrieval:
  - `placematch.backends.get_backend("megaloc" | "vertex")`;
  - `EmbeddingIndex` (`placematch/backends/base.py`) for a prebuilt reference index;
  - `placematch.decide` with `data/calibration/current.json`;
  - `placematch.verify.verify_pair` for optional verification.
- Load models and the index once at startup.
- Add a command that builds a named reference set from a folder of reference photos
  (subfolders = `location_id`), separate indexes per backend:
  `placematch build-references --references DIR --name <set> [--backend megaloc|vertex]`.
  It must show expected Vertex requests and respect `--limit`, as `embed` already does.

Endpoints (JSON, versioned, all require `Authorization: Bearer <MOBILE_API_TOKEN>`):

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/health` | Backends ready/configured, reference set name, `thresholds_id`. No secrets. |
| `POST /v1/match` | Multipart: `image` (JPEG only, ≤ 3 MB, ≤ 4096 px) + `meta` JSON (`client_frame_id`, `timestamp_s`, `captured_at`, `orientation`, app version). Query: `backend=auto\|megaloc\|vertex` (default `auto` = §4 order), `verify=false\|true`, `second_opinion=false\|true`. Returns `decision` (`likely_match` / `uncertain` / `no_supported_match`, `reference_id`, `location_id`, `reasons`), top-5 candidates (`reference_id`, `location_id`, `cosine`), `verification` when run, `backend_used`, `fallback_used`, `timings_ms` (decode, embed, search, verify, total), `thresholds_id`. |
| `GET /v1/references/{set}/thumb/{reference_id}` | Small JPEG for display; only ids from that set. |
| `GET /v1/references/{set}/megaloc-index` | (§6) fp16 vectors + ids + location ids + backend key + thresholds, for on-device search. |

Server rules:
- Validate content type and size; reject anything else with a clear error.
- Don't store uploaded frames unless a dev flag is on.
- Never log tokens, images or EXIF.
- Add a simple per-token rate limit.
- Add offline tests (fake backend) in `apps/place-match/tests/`.

## 5. Task C: reach the computer from a phone far away (development only)

- Arjun creates the ngrok account and runs `ngrok config add-authtoken …` himself. You
  never see or store his ngrok token. Get his approval to install ngrok (e.g.
  `brew install ngrok`).
- Generate a random `MOBILE_API_TOKEN` (e.g. `python -c "import secrets;print(secrets.token_urlsafe(32))"`)
  into the git-ignored `apps/place-match/.env`. Arjun enters it on the phone in a **debug-only
  settings screen**, stored in the iOS Keychain, never in source or `capacitor.config`.
- Run the mobile API on 127.0.0.1:8790, then `ngrok http 127.0.0.1:8790`.
  - Forward **only** that port.
  - Use HTTPS (no App Transport Security exceptions).
  - Optionally add ngrok's own access control (basic auth / traffic policy) on top of the
    bearer token.
- The tunnel URL changes on free plans. Make it a dev setting, not a constant.
- **Debug builds only.** Release builds must not contain the ngrok URL field.
- Tell Arjun plainly: while the tunnel runs, the endpoint is reachable from the internet, and
  frames he sends leave the phone. Stop the tunnel when not testing.
- Measure and report over Wi‑Fi and cellular:
  - per-frame round-trip latency (median and p95) at 1 fps for MegaLoc and Vertex, each
    with and without verification;
  - dropped or late frames;
  - what the server was doing at the time.

## 6. Optional phase: MegaLoc fully on the phone (after A–C work)

- **Before anything:** check the MegaLoc repository licence and DINOv2's licence for
  shipping weights inside an app, and report it.
- Export the exact model the server uses (`data/models/megaloc/…`, commit `5fe0dd6`) to
  Core ML (coremltools) at fp16. The DINOv2 backbone usually converts; the aggregation's
  iterative Sinkhorn step may need care.
- **Parity gate:** on ≥ 200 benchmark images, Core ML vs PyTorch vector cosine ≥ 0.999 and
  identical top-1 against the reference index. If it fails, don't ship on-device inference.
- Report model size, cold-load time, per-frame latency on a **physical** iPhone (the
  simulator is not representative), and thermal/battery behaviour over 10 minutes at 1 fps.
- Download the per-building index from `/v1/references/{set}/megaloc-index`. Refuse to use
  it if its backend key differs from the on-device model's.
- Quantisation beyond fp16 changes vectors: only with a new parity check and re-calibrated
  thresholds.

## 7. Production plan (write it down; do not provision anything)

Produce `docs/place-match-production.md` (SnapWay) proposing a cloud deployment in the
existing Google Cloud project (`project-7f487f13-1ed3-42d7-a46`, or another Arjun names):

- **Mobile API:** a container (MegaLoc weights baked in or pulled from Cloud Storage) on
  Cloud Run (CPU vs GPU options with expected latency per frame and cost per 1,000 frames),
  or a Vertex AI custom endpoint. Compare them.
- **Data:** reference sets and indexes in Cloud Storage.
- **Credentials:** Vertex calls via a service account with workload identity, no key files.
- **Auth:** users authenticated through SnapWay's backend (it already has Google OAuth via
  allauth) instead of a shared bearer token. TLS everywhere, rate limits, logging without
  images.
- **Data handling:** retention and deletion for uploaded frames.
- **Operations:** monitoring, and rollback by pinning model and threshold versions.
- **Before anything is created:** list what Arjun must approve and enable (billing, APIs,
  quotas).
  - Do not raise quotas.
  - Do not create cloud resources.
  - Do not deploy anything without his explicit approval in chat.

## 8. Validation before trusting the app

- With Arjun's consent, capture a small real iPhone validation set in a building whose
  reference photos exist, plus walks through places **without** references.
- Label it honestly (agent-only inspection is labelled as such), and evaluate with the
  existing tools (`placematch calibrate` on validation only, `placematch evaluate`).
- Report recall, false accepts on unknown places, and latency.
- If thresholds change, freeze them by hash as done for `baselines/bench-v2-final/`, and keep
  a separate untouched set for the final check.

## 9. Done means

- Permission flows work on a physical iPhone (granted, denied, restricted), and frames have
  correct timestamps and orientation.
- The mobile API passes its tests and serves MegaLoc-first decisions with the §4 rules.
- A phone on cellular reaches it through ngrok with the token, and the results show
  backend, fallback and timings.
- Measured latencies are reported; untested items are listed.
- `docs/mobile-ios.md`, `docs/place-match-production.md` and `local/ACTIONS.md` are
  updated.
- Nothing is committed or pushed unless Arjun asked.
