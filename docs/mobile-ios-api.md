# Photo localization: API and plugin reference

Reference for the interfaces added on `feature/mobile-ios`. Overview, setup and decisions are
in [mobile-ios.md](mobile-ios.md); hosting is in [place-match-production.md](place-match-production.md).
Example values below are illustrative, not measurements.

## Request path

1. The iOS app captures a frame with the native `FrameCapture` plugin and stores it in the
   app sandbox (JPEG, at most 1024 px, plus a metadata JSON file).
2. On **Send** (or with auto-send on), the plugin uploads it natively, adding the token from
   the Keychain, to either:
   - the engine directly: `https://<tunnel>/v1/match` (development), or
   - the SnapWay API: `/api/navigation/localize/`, which authenticates the caller and
     forwards the frame to the engine on a private address.
3. The engine embeds the frame with MegaLoc, searches the reference index, applies the
   calibrated thresholds and, only when allowed, asks Vertex AI (with geometric verification).
4. The app shows the outcome, backend, thresholds id, raw similarities and timings. A
   "Use … as start" button appears only when a `likely_match` location id exactly names a map
   checkpoint; manual start selection always remains.

## Endpoints

| Engine (`serve-mobile`, 127.0.0.1:8790) | SnapWay API | Purpose |
| --- | --- | --- |
| `GET /v1/health` | `GET /api/navigation/localize/health/` | Backend readiness, reference set, `thresholds_id` |
| `POST /v1/match` | `POST /api/navigation/localize/` | Match one frame |
| `GET /v1/references/{set}/thumb/{reference_id}` | `GET /api/navigation/localize/references/{set}/thumb/{reference_id}` | Small JPEG of a reference photo (ids from that set only) |
| `GET /v1/references/{set}/megaloc-index` | `GET /api/navigation/localize/references/{set}/megaloc-index/` | fp16 MegaLoc vectors for future on-device search |

### Authentication

| Server | Header | Notes |
| --- | --- | --- |
| Engine | `Authorization: Bearer <MOBILE_API_TOKEN>` | Constant-time comparison; per-token sliding one-minute limit (`MOBILE_RATE_LIMIT_PER_MIN`, default 60). |
| SnapWay API | Django session cookie | Signed-in contributor. |
| SnapWay API | `Authorization: Navigation <secret>` | Active visitor `NavigationSession`; only the SHA-256 digest is stored; expired, invalidated or unpublished sessions are rejected. |
| SnapWay API | `Authorization: Bearer <PLACEMATCH_DEV_TOKEN>` | Development only: rejected unless `DEBUG` is true and the token has at least 24 characters. |

The SnapWay API uses DRF's scoped throttle `localization` (`LOCALIZATION_RATE`, default
`60/min`). Responses from it include `"caller": "user" | "navigation_session" | "dev_token"`.

### `POST` match request

Multipart form:

| Part | Type | Rules |
| --- | --- | --- |
| `image` | `image/jpeg` | JPEG only, at most 3 MB and 4096 px on the longest side |
| `meta` | JSON string | Unknown fields are rejected |

`meta` fields: `client_frame_id` (integer ≥ 0, required), `timestamp_s` (seconds since capture
start or the video's frame time), `captured_at` (ISO 8601, ≤ 40 chars), `orientation`
(`portrait`, `portraitUpsideDown`, `landscapeLeft`, `landscapeRight`, `unknown`),
`app_version` (≤ 32 chars), `source` (`camera` or `video`).

Query parameters:

| Parameter | Values | Default | Meaning |
| --- | --- | --- | --- |
| `backend` | `auto`, `megaloc`, `vertex` | `auto` | `auto` = MegaLoc first, Vertex AI only as fallback or second opinion |
| `verify` | `true`, `false` | `false` | Geometric verification of MegaLoc's top-1 (~1.2 s). Vertex always verifies when used by `auto`. |
| `second_opinion` | `true`, `false` | `false` | Ask Vertex AI when MegaLoc is `uncertain` |

Example (engine directly):

```sh
curl -sS https://<tunnel>/v1/match?backend=auto \
  -H "Authorization: Bearer $MOBILE_API_TOKEN" \
  -F 'meta={"client_frame_id":7,"timestamp_s":3.0,"orientation":"portrait","source":"camera"};type=application/json' \
  -F 'image=@frame.jpg;type=image/jpeg'
```

### Match response (200)

```json
{
  "api_version": "v1",
  "reference_set": "e2-floor1",
  "decision": {
    "outcome": "likely_match",
    "reference_id": "reference:studio-101/door.jpg",
    "location_id": "studio-101",
    "reasons": ["top-1 reference:studio-101/door.jpg cosine 0.4120", "margin over reference:lab/a.jpg: 0.0610", "at/above accept threshold 0.3309"]
  },
  "candidates": [
    {"rank": 1, "reference_id": "reference:studio-101/door.jpg", "location_id": "studio-101", "cosine": 0.412},
    {"rank": 2, "reference_id": "reference:lab/a.jpg", "location_id": "lab", "cosine": 0.351}
  ],
  "candidates_backend": "megaloc:5fe0dd6:322x322",
  "verification": null,
  "secondary": null,
  "backend_used": "megaloc",
  "fallback_used": false,
  "second_opinion_used": false,
  "thresholds_id": "sha256:3f2a9c1b7e44",
  "quality": {"blur_laplacian_var": 412.3, "mean_luma": 118.2, "dark_fraction": 0.01, "flags": []},
  "score_kind": "raw cosine similarity (not a percentage or probability)",
  "frame": {"client_frame_id": 7, "timestamp_s": 3.0, "orientation": "portrait", "source": "camera", "width": 576, "height": 1024},
  "timings_ms": {"decode": 3.1, "quality": 9.4, "embed_megaloc": 318.0, "search_megaloc": 0.4, "total": 335.2},
  "stored": false
}
```

Field notes:

- `decision.outcome`: `likely_match`, `uncertain` or `no_supported_match`. Only
  `likely_match` carries a `reference_id`/`location_id`.
- `backend_used`: `megaloc`, `vertex` or `megaloc+vertex` (second opinion). `fallback_used`
  is true only when Vertex answered because MegaLoc was unavailable.
- `candidates` are the top-5 of the backend that decided; `secondary` holds Vertex's own
  candidates, decision and verification when it ran as a second opinion. Cosines from
  different backends are never compared or combined.
- `thresholds_id` is the hash of the active `data/calibration/current.json`;
  `"uncalibrated"` means no thresholds were loaded (nothing is accepted).
- `timings_ms` keys depend on what ran: `decode`, `quality`, `embed_<backend>`,
  `search_<backend>`, `verify_<backend>`, `total` (server time; the app also reports its
  round trip).

### Health response (200)

```json
{
  "api_version": "v1",
  "reference_set": "e2-floor1",
  "locations": ["lab", "studio-101"],
  "thresholds_id": "sha256:3f2a9c1b7e44",
  "backends": {
    "megaloc": {"ready": true, "backend_key": "megaloc:5fe0dd6:322x322", "references": 42, "calibrated": true, "error": null},
    "vertex": {"ready": false, "backend_key": null, "references": 0, "calibrated": false, "error": "no vertex index for reference set 'e2-floor1'; run `placematch build-references --name e2-floor1 --backend vertex`"}
  },
  "default_order": ["megaloc", "vertex (fallback or second opinion)"]
}
```

### Errors

| Status | When | Body |
| --- | --- | --- |
| 400 | Undecodable image, bad `meta` JSON or unknown `backend` (API) | `detail` or field errors |
| 401 | Missing/invalid token, expired navigation session, dev token outside `DEBUG` | `detail` |
| 403 | Signed-in but not allowed (reserved) | `detail` |
| 404 | Unknown reference set or reference id | `detail` |
| 413 | Over 3 MB or 4096 px | `detail` |
| 415 | Not `image/jpeg` / not a JPEG | `detail` |
| 422 | Invalid `meta` fields (engine) | `detail` |
| 429 | Rate limit | `Retry-After` header |
| 502 | The API's engine token is wrong (API only) | `{"error": "engine_error"}` |
| 503 | No backend can answer, engine down, or engine not configured | `{"error": "no_backend_available" \| "unavailable" \| "not_configured"}` |

The app maps every non-200 or malformed response to an error message; it never turns one
into a location.

### MegaLoc index export

`vectors_b64` is the base64 of a little-endian float16 array with `shape` `[n, 8448]`, rows
in the order of `reference_ids`/`location_ids`, plus `backend_key`, `thresholds` and
`thresholds_id`. A client must refuse it if `backend_key` differs from its own model's key.

## Engine configuration

In the ignored `apps/place-match/.env` (or the environment):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MOBILE_API_TOKEN` | — (required, ≥ 24 chars) | Bearer token; create with `placematch mobile-token --create` |
| `MOBILE_REFERENCE_SET` | `default` | Set under `data/references/<name>/` |
| `MOBILE_RATE_LIMIT_PER_MIN` | `60` | Per-token requests per minute |
| `MOBILE_ENABLE_VERTEX` | `1` | `0` disables the Vertex slot entirely |
| `MOBILE_STORE_FRAMES` | `0` | `1` saves uploads under `runs/mobile-frames/` (development only) |
| `VERTEX_PROJECT`, `VERTEX_LOCATION` | — | Vertex AI via Application Default Credentials (see `VERTEX.md`) |

Reference sets: `data/references/<set>/images/<location_id>/...`, `manifest.json`, and
`index/<backend-key>/{vectors.npy,index.txt,meta.json}`, one index per backend.

## SnapWay API configuration

In `local/env/api.env` (development) or `/etc/indoor-nav/api.env` (server):

| Variable | Meaning |
| --- | --- |
| `PLACEMATCH_ENGINE_URL` | Engine base URL, e.g. `http://127.0.0.1:8790`; empty disables the endpoints (503 `not_configured`) |
| `PLACEMATCH_ENGINE_TOKEN` | The engine's `MOBILE_API_TOKEN` |
| `PLACEMATCH_ENGINE_TIMEOUT_S` | Forwarding timeout, default 30 |
| `PLACEMATCH_DEV_TOKEN` | Optional bearer token for the iOS debug build; ignored unless `DEBUG` |
| `LOCALIZATION_RATE` | DRF scoped throttle, default `60/min` |

## iOS plugin `FrameCapture`

Defined in `apps/web/ios/App/App/FrameCapturePlugin.swift`, typed in
`apps/web/src/app/core/frame-capture.ts`, registered by `SnapWayViewController`.

| Method | Result | Notes |
| --- | --- | --- |
| `getStatus()` | `camera`, `cameraAvailable`, `debugBuild`, `capturing`, `storedFrames` | `camera`: `notDetermined`, `authorized`, `denied`, `restricted` |
| `requestPermission()` | `camera` | Shows the system prompt only when `notDetermined` |
| `openSettings()` | `opened` | Opens the app's page in Settings |
| `start({ fps })` | `capturing`, `fps` | 0.5–5 fps; requires `authorized` and foreground |
| `stop()` | `capturing: false` | |
| `listFrames()` | `frames[]` | Metadata of stored frames (oldest first) |
| `deleteFrames()` | `deleted` | Removes every stored frame |
| `importVideo({ fps })` | `frames`, `duration_s`, `truncated`, `cancelled` | PHPicker; at most 120 frames per video |
| `uploadFrame({ clientFrameId, backend, verify, secondOpinion })` | `status`, `body`, `roundTripMs` | `body` is the raw JSON text |
| `testConnection()` | `status`, `body`, `roundTripMs` | Calls the health endpoint |
| `fetchThumbnail({ referenceSet, referenceId })` | `status`, `dataUrl`, `roundTripMs` | |
| `getDevConfig()` / `setDevConfig({ baseUrl, mode, token? })` / `clearDevConfig()` | | Debug builds only; `mode` `engine` or `snapway`; HTTPS required except `localhost` |

Events (`addListener`):

- `frame`: `client_frame_id`, `timestamp_s`, `captured_at`, `orientation`, `source`, `width`,
  `height`, `bytes`, `quality` (`mean_luma`, `blur_score`, `flags`, `method`), `preview`
  (small data URL for display only).
- `state`: `capturing`, `reason` (`started`, `user`, `background`, `interrupted`,
  `camera_error`, `thermal`).

Device quality flags are heuristics on a 64 px grey image (`blurry` below a Laplacian
variance of 30, `underexposed` below mean luma 40, `overexposed` above 225); the engine
measures quality again on its side.
