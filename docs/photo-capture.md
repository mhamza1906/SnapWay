# Photo capture mode (mobile browser)

**Status (October 18, 2026):** mobile photo-walk UI and four reference views per point are implemented on `feature/map-authoring-pipeline`. A temporary HTTPS preview reaches the app/API, Google accepts its callback, and a real synthetic R2 write/read/signed-URL test passed. Sam Ibrahim's saved collection walks are installed in the local API. No physical-phone camera test or completed human Google sign-in was performed by the agent; computer use was disabled at the user's request. Earlier test counts below document previous checkpoints.

Changed files:
[capture-points.js](../apps/pipeline/shared/building/capture-points.js),
[capture-map-routes.js](../apps/pipeline/server/capture-map-routes.js),
[capture-fixture.js](../apps/pipeline/server/capture-fixture.js),
[server/index.js](../apps/pipeline/server/index.js),
[capture-points.test.js](../apps/pipeline/tests/capture-points.test.js);
[apps/api/capture/](../apps/api/capture/),
[settings/base.py](../apps/api/config/settings/base.py),
[settings/development.py](../apps/api/config/settings/development.py),
[urls.py](../apps/api/config/urls.py),
[test_capture_api.py](../apps/api/tests/test_capture_api.py);
[features/capture/](../apps/web/src/app/features/capture/),
[app.routes.ts](../apps/web/src/app/app.routes.ts),
[app.ts](../apps/web/src/app/app.ts),
[icon.ts](../apps/web/src/app/shared/icon.ts),
[index.html](../apps/web/src/index.html) (`viewport-fit=cover`),
[package.json](../apps/web/package.json) (`start:phone`, `cert:phone`),
[scripts/phone_https.mjs](../scripts/phone_https.mjs),
[database-schema.md](database-schema.md), [pipeline/api.md](pipeline/api.md).

Live test map: Sam Ibrahim Building **Level 3** (library key
`copy-sam-ibrahim-building-27687113`, floor `floor-4`, no verified scale, so
manual point placement). Calibrated test map: `synthetic-capture-fixture`
floor `capture-fx-1` (labelled synthetic, 20 px/m).

A map contributor opens `/capture` in Chrome on a phone, picks a building,
floor, corridor and walking direction, walks to numbered capture points along
the corridor centreline, confirms each position and takes reference photos in
four directions. Every photo is stored with its confirmed position and its
map-relative viewing angle for later visual localization (localization models
and 3D generation are out of scope).

## Parts and ownership

| Part | Where | Owns |
| --- | --- | --- |
| Map and planner | `apps/pipeline` (Node, port 5175, proxied as `/pipeline`) | corridor chains, capture-point planning, snapping, synthetic fixture |
| Storage and auth | `apps/api` (Django + DRF, port 8000, proxied as `/api`) | sessions, points, photos, images, membership checks, review flags |
| Capture screen | `apps/web` (Angular, `/capture`) | map, bottom sheet, camera, upload queue (IndexedDB) |

Capture points are **not** routing vertices: they are stored in Django and only
reference pipeline edges and nodes by ID.

## Conventions

- **Map frame:** pixel coordinates of the floor's map image (`x` right, `y` down),
  the same frame as the pipeline floor geometry.
- **Map revision:** the pipeline floor's integer `revision`. Every point and
  photo stores the revision it was planned and captured on.
- **Viewing angle** (`viewingAngleDeg`): map-relative, degrees in `[0, 360)`,
  `0` = facing `+x` (right on the plan), increasing **clockwise on screen**
  (`90` = facing `+y`, down on the plan). It is `atan2(dy, dx)` in the map frame.
  It is not a compass bearing.
- **Slots:** `forward` = the local corridor direction in the selected walking
  direction (`forwardAngleDeg`), `right` = forward + 90, `backward` = forward + 180,
  `left` = forward + 270 (mod 360). `extra` is any additional photo.
- **Reference segment:** forward is taken from the outgoing corridor segment in
  the walking direction (`referenceEdgeId`); at the last point, the incoming
  segment. At junctions the plan names the reference edge explicitly.
- **Sources:** `positionSource` is `planned`, `contributor-confirmed` (contributor
  says they stand on the planned point), `contributor-adjusted` (moved along the
  corridor) or `manual` (placed by tap on an uncalibrated map).
  `directionSource` is always `manual-confirmed` (the arrow is the requested
  direction; the phone's orientation is not measured). There is no GPS or
  live tracking.
- **Scale:** metres (`distanceM`, spacing) only when the floor's scale is
  verified (`geometry.scale.pixelsPerMetre` set). Otherwise metre fields are
  `null` and points are placed manually.

## Pipeline map API (`/pipeline/api/capture-map`)

Implemented in `apps/pipeline/server/capture-map-routes.js` (routes) and
`apps/pipeline/shared/building/capture-points.js` (pure planner); tests in
`apps/pipeline/tests/capture-points.test.js`. All endpoints are read-only.

`GET /buildings` → `[{ id, name, floors: [{ id, label, revision, scaleVerified }] }]`
(library buildings with a built graph, plus the labelled synthetic fixture).
`id` is the **building-library key** (for example
`copy-sam-ibrahim-building-27687113`), not `building.id`, because two library
files can hold the same building. Only floors with corridor edges are listed.
The SYNTHETIC TEST FIXTURE is `synthetic-capture-fixture` with floors
`capture-fx-1` (20 px/m, auto mode) and `capture-fx-2` (same layout, no scale,
manual mode); it is built in memory and never written to the library.

`GET /buildings/:buildingId/floors/:floorId` →
```
{ buildingId, floorId, floorLabel, revision, width, height,
  scale: { verified, pixelsPerMetre | null },
  svg,                       // designed floor render, no embedded images
  corridors: [{ id, label, lengthPx, lengthM | null,
               path: [{x,y}],          // whole chain, forward orientation
               segments: [{ edgeId, reversed, startPx, endPx }],
               nodeIds: [..] }],
  nodes: [{ id, kind: "junction"|"door"|"end", label, x, y }],
  landmarks: [{ kind: "room"|"door", id, label, x, y }] }
```
`404` for an unknown building or floor.
A corridor is a chain of graph edges with `traversal: "corridor"` joined
through nodes with exactly two corridor edges (doorway edges do not count);
chains end at junctions (three or more corridor edges), real door vertices,
stair/lift landings and dead ends. They run through analytical joins between
segmented corridor pieces (`coverage-open-*` or `decomposition-join`).
Corridor `id` is `corridor-` + the first 12 hex digits of SHA-256 of the
chain's sorted edge IDs (stable while the graph is unchanged). `label` is the
walkable space the chain runs through longest; chains through the same space
are `"<label>, part n"` in reading order (top to bottom, then left to right).
Forward orientation runs +x for mostly horizontal chains, +y otherwise.

`POST /plan` `{ buildingId, floorId, revision, corridorId, direction: "forward"|"reverse", spacingM = 2 }` →
```
{ revision, scaleVerified, mode: "auto"|"manual",
  spacingM | null,                       // the spacing used (null in manual mode)
  path: [{x,y}] (walking order),
  points: [{ planId, order, x, y, edgeId, nodeId | null, referenceEdgeId,
             fraction,            // along edgeId's stored polyline (from→to), 0..1
             corridorDistancePx,  // along the walking path
             distanceM | null, forwardAngleDeg,
             reason: "start"|"spacing"|"turn"|"junction"|"door"|"end",
             nearby: [{ kind, id, label, distancePx }] }] }
```
Auto mode: points every `spacingM` metres measured along the whole polyline,
plus turns, junctions and important doors, merged when closer than half the
spacing, with no duplicates at shared endpoints. Manual mode (no verified
scale): only start, end, junction and turn suggestions, `distanceM: null`.
`409` when `revision` is not the floor's current revision (body
`{ error, currentRevision }`); `400` for an unknown corridor, a bad direction
or `spacingM` outside 0.5–50.

Planner details:
- **Same points both ways.** Positions are computed on the forward chain
  (spacing measured from the forward start), so `reverse` returns the same
  points in reverse order; `corridorDistancePx` and `distanceM` are measured
  from the walking start. `planId` is `<corridorId>:<f|r>:<forward distance ×10>`.
- **Reasons.** Priority when merging: chain ends > `junction` > `door` >
  `turn` > `spacing`. A chain end is `junction` when three or more corridor
  edges meet there, `door` (auto mode only) at a real door vertex, otherwise
  `start`/`end`. Both ends are always kept. Important doors are doors of rooms
  whose doorway edge joins a vertex of the chain; the point is that vertex
  (`nodeId`). Turns are bends over 30° measured over a short window
  (auto: min(spacing/4, 0.75 m); manual: half the merge distance).
- **Edge and angle.** At a vertex shared by two edges, `edgeId` and
  `referenceEdgeId` are the outgoing edge in the walking direction (incoming at
  the last point), so `fraction` is 0 or 1 there. `forwardAngleDeg` comes from
  the outgoing walking segment, skipping segments shorter than max(0.5 m, 8 px)
  (manual: 1% of the floor diagonal), which are corner chamfers on raster
  centrelines. On straight stretches reverse = forward + 180; at a turn vertex
  each direction uses its own outgoing segment.
- **Manual mode** merges suggestions closer than 1% of the floor diagonal.
- **`nearby`**: doors (midpoint) and rooms (polygon) within 3 m (manual: 2.5%
  of the floor diagonal), nearest first, at most 6.

`POST /snap` `{ buildingId, floorId, revision, corridorId, direction, x, y }` or
`{ …, corridorDistancePx }` → one point object as in `/plan` (reason
`"adjusted"`, `planId: null`, `order: null`) on the corridor centreline, so a
point always stays in walkable space. `x, y` snaps to the nearest centreline
point; `corridorDistancePx` (walking distance) is clamped to the corridor.
`400` if the corridor is unknown or neither form is given; `409` on a stale
revision as for `/plan`.

## Django capture API (`/api/capture`)

Implemented in [`apps/api/capture/`](../apps/api/capture/) (models, views, URLs,
images, seed command) with tests in
[`apps/api/tests/test_capture_api.py`](../apps/api/tests/test_capture_api.py).

**Auth.** Django session authentication with CSRF. The CSRF cookie is
`XSRF-TOKEN` and the header is `X-XSRF-TOKEN` (the project-wide setting in
`config/settings/base.py`, Angular's default, so `HttpClient` sends it
automatically). `GET /me` sets the cookie. Since the merge with main
(October 18, 2026), contributors sign in with the app's Google sign-in
(allauth, `AuthService.signIn('/capture')`, which returns to `/capture`); the
capture-only password login page was removed. `GET /me` still returns a
`loginUrl` (`/accounts/login/?next=…`) for clients without the web app. Not signed
in → `401` (`WWW-Authenticate: Session`); signed in without access → `403`;
bad input → `400`; conflicts → `409`; image over 20 MB → `413`. Error bodies
are `{ "detail": "…" }` or DRF field errors `{ "field": ["…"] }`.

**Authorization.** Every read and write needs an active (not revoked) `admin`
or `volunteer` `Membership` on an open (not archived) `MapTarget`. A session,
its points and photos are readable by its contributor and by target admins,
and writable only by its contributor. Revoking a membership or archiving the
target cuts off access to existing data too. A MapTarget is linked to one
pipeline floor through `CaptureMapLink`, so `/me` lists exactly the floors a
contributor may capture, and a session's `mapBuildingId`/`mapFloorId` must
match its target's link (`400` otherwise).

IDs of sessions, points and photos are client-generated UUIDs, so every write
is an idempotent `PUT` (safe to retry). Paths take an optional trailing slash.
Timestamps are UTC ISO-8601 (`…Z`).

- `GET /me` → `{ authenticated, username, loginUrl, targets: [{ id, title, role, mapBuildingId, mapFloorId }] }`
  (sets the `XSRF-TOKEN` cookie; anonymous: `authenticated: false`, `targets: []`;
  `?next=/path` changes the `next` in `loginUrl`).
- `PUT /sessions/:id` `{ targetId, mapBuildingId, mapFloorId, mapRevision, corridorId, direction, spacingM | null }`
  → `201` session (created) or `200` (updated). Session JSON:
  `{ id, targetId, contributor, mapBuildingId, mapFloorId, mapRevision, corridorId, direction, spacingM, createdAt, updatedAt }`.
  Target, building and floor are fixed (`409` on change); corridor and
  direction are fixed once the session has points (`409`).
- `GET /sessions?targetId=&mapFloorId=` → `{ sessions: [session…] }`, the signed-in
  contributor's own sessions on targets they can still access, latest first
  (`403` for a `targetId` without membership).
- `GET /sessions/:id` → `{ …session, points: [point…], photos: [photo…] }` (points by
  `order`; photos include replaced ones, filter on `reviewStatus`).
- `PUT /sessions/:id/points/:pointId` `{ order, planId | null, mapRevision, edgeId, nodeId | null, referenceEdgeId, fraction, corridorDistancePx, distanceM | null, forwardAngleDeg, plannedX, plannedY, confirmedX | null, confirmedY | null, positionSource, reason }`
  → `201` (created) or `200` point:
  `{ id, sessionId, …the input fields, status, reviewReason | null, createdAt, updatedAt }`.
  `reason` is one of the planner reasons or `adjusted`/`manual`;
  `forwardAngleDeg` in `[0, 360)`; `fraction` in `[0, 1]`.
  Moving a point that already has photos is refused (`409`, with
  `fields: [changed field names]`): add another point instead. "Moving" is a
  change to any of `mapRevision`, `edgeId`, `nodeId`, `referenceEdgeId`,
  `fraction`, `corridorDistancePx`, `distanceM`, `forwardAngleDeg`, planned or
  confirmed coordinates or `positionSource`; `order`, `planId` and `reason` may
  still change. A point without photos may be changed freely; re-planning it
  on another `mapRevision` clears its `needs-review` flag.
- `DELETE /sessions/:id/points/:pointId` → `204` (also when already gone);
  `409` if it has photos.
- `PUT /points/:pointId/photos/:photoId` (multipart: `image` file + `metadata` JSON
  `{ slot, viewingAngleDeg, directionSource, positionSource, capturedAt, clientSha256 }`)
  → `201` created or `200` when this photo ID already exists with the same
  SHA-256 (retry); `409` on a different image for the same ID. A new photo for a
  slot that already has one marks the older one `replaced` (never deleted;
  `replacedBy` names the new photo). `extra` photos never replace each other.
  Validation: `slot` ∈ `forward|right|backward|left|extra`; `viewingAngleDeg`
  in `[0, 360)` and, for the four fixed slots, within 1° of the point's
  `forwardAngleDeg` + slot offset; `directionSource` must be
  `manual-confirmed`; `clientSha256` (optional) must match the received bytes;
  the image must decode with Pillow as JPEG, PNG or WebP, ≤ 20 MB
  (`CAPTURE_MAX_UPLOAD_BYTES`). Photo JSON:
  `{ id, pointId, sessionId, slot, viewingAngleDeg, directionSource, positionSource, positionX, positionY, mapRevision, capturedAt, sha256, contentType, byteSize, width, height, uploadStatus, reviewStatus, reviewReason | null, replacedBy | null, thumbnailUrl, displayUrl, createdAt }`.
  `positionX/Y` and `mapRevision` are copied from the point at upload
  (confirmed position, else planned); `width`/`height` are upright.
- `GET /photos/:id/thumbnail` and `/photos/:id/display` → JPEG bytes
  (`Cache-Control: private`; same read rule as the session).
- `POST /sessions/:id/revision-check` `{ currentRevision }` → points and photos
  on an older revision become `needs-review` with reason `map revision changed`;
  their coordinates and stored revision are kept. Replaced photos are left
  alone. Response `{ currentRevision, flaggedPoints, flaggedPhotos, session: {…detail} }`
  (counts of newly flagged rows; repeating the call flags nothing new).

Point `status`: `empty`, `partial` (some of the four slots), `complete` (all
four uploaded), `needs-review`. It is recomputed from uploaded, non-replaced
photos in the four fixed slots after every upload, except that `needs-review`
stays until reviewed or re-planned. Photo `uploadStatus` is `uploaded` (server
confirmed) and `reviewStatus` is `pending`, `needs-review`, `accepted`,
`replaced`. The client adds `captured-locally` and `upload-pending` before
the server confirms.

Images: EXIF orientation is applied (`ImageOps.exif_transpose`), the original
bytes are kept unchanged, a display copy (long edge at most 2560 px, never
upscaled or shrunk below that, JPEG quality 90 with 4:4:4 chroma so room signs
stay readable) and a 320 px (long edge) JPEG thumbnail are stored in
**Cloudflare R2 only, never on the server's disk**
([`capture/photo_store.py`](../apps/api/capture/photo_store.py)): signed
S3-compatible requests (SigV4 via httpx, no SDK) to a private bucket under
`<R2_PREFIX>/capture/<target>/<session>/<photo>/<variant>.<ext>`, with
`Asset.storage_key = "r2:<key>"`. The image endpoints above check access,
then fetch the object from R2 and return the bytes; bucket URLs and
credentials never reach the browser. Configure `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (and optionally
`R2_PREFIX`, default `snapway`) in the API's server env (`local/env/api.env`).
Without them an upload returns `503` and nothing is stored. Tests use an
in-memory store (`CAPTURE_PHOTO_STORE = "memory"`).

**Photo offer.** Selecting a point that has no photos yet shows an optional
offer to take up to four photos there (front, right, back, left). "Take photos"
confirms the position if needed and opens the camera; any slot can be skipped
and "Done" closes it at any time. "Not now" hides the offer for that point
until the screen is reloaded.

### Storage model

| Table | Holds |
| --- | --- |
| `capture_capturemaplink` | `target` (one-to-one `MapTarget`) ↔ pipeline `map_building_id` + `map_floor_id` (unique pair) |
| `capture_capturesession` | client UUID, `target`, `contributor`, map building/floor/revision, `corridor_id`, `direction`, `spacing_m` |
| `capture_capturepoint` | client UUID, `session`, `order`, `plan_id`, `map_revision`, edge/node/reference-edge IDs, `fraction`, `corridor_distance_px`, `distance_m`, `forward_angle_deg`, planned and confirmed `x`/`y`, `position_source`, `reason`, `status`, `review_reason` |
| `capture_capturephoto` | client UUID, `target`, `session`, `point`, `uploaded_by`, `slot`, `viewing_angle_deg`, `direction_source`, `position_source`, `position_x/y`, `map_revision`, `captured_at`, original/display/thumbnail `Asset`s, `sha256`, `client_sha256`, `content_type`, `byte_size`, upright `width`/`height`, `upload_status`, `review_status`, `review_reason`, `replaced_by` |

All have `created_at`/`updated_at`. Each image file is a `maps.Asset`
(kind `photo`, target-scoped `storage_key`, SHA-256, size, dimensions,
`provenance.variant` = `original`/`display`/`thumbnail`); display and
thumbnail assets point to the original through `source_asset`. Assets stay
append-only. Database checks cover enum values, angle and fraction ranges,
paired confirmed coordinates, review reasons and at most one current photo per
point and fixed slot. Migration `capture/0002_postgresql_integrity` adds
PostgreSQL composite keys (photo, session, point and assets share one target)
and a trigger requiring `photo` assets; SQLite skips it.

### Seed and run (development)

```sh
# once: locked environment, private local/env/api.env (scripts/bootstrap.py creates it), migrations
uv run --locked --extra ai --extra geometry --extra mcp python apps/api/manage.py migrate
# demo users + targets; repeatable; IDs are pipeline building/floor IDs
uv run --locked --extra ai --extra geometry --extra mcp python apps/api/manage.py \
  seed_capture_demo copy-sam-ibrahim-building-27687113 floor-4 \
  --unjoined-floor floor-3 --building-name "Sam Ibrahim Building"
uv run --locked --extra ai --extra geometry --extra mcp python apps/api/manage.py \
  seed_capture_demo synthetic-capture-fixture capture-fx-1 capture-fx-2
```

`seed_capture_demo <mapBuildingId> <mapFloorId>… [--unjoined-floor ID]… [--building-name N] [--role volunteer|admin]`
creates (or reuses) a Building, one Floor/MapTarget/CaptureMapLink per floor,
the contributor `capture-demo` with a `volunteer` Membership on each listed
floor, and `capture-outsider` with no membership. `--unjoined-floor` creates
and links a target without a demo membership (floor-isolation checks).
Passwords are random, written only to the git-ignored
`local/capture-demo-credentials.json` (mode 600) and reused on later runs;
they are never printed.

Run Django with `python scripts/dev.py api` (127.0.0.1:8000). When port 8000
is taken by another project, run
`uv run --locked --extra ai --extra geometry --extra mcp python apps/api/manage.py runserver 127.0.0.1:8001`
and point the web proxy's `/api`, `/admin` and `/accounts` entries at 8001.

## Capture screen (`/capture`)

Phone-first layout: zoomable and pannable plan, selected path, numbered points
in walking order, progress, and a bottom sheet with nearby landmarks and
"I'm at this point", "Adjust position", "Start capture". Guided camera with
rear-camera live preview (`getUserMedia`), file-input fallback, mini map with
the confirmed point and requested-direction arrow, four slots, preview, retake
and save. Camera access stops on leaving capture. Pending photos are queued in
IndexedDB and retried; nothing shows as uploaded before the server confirms.

## Running and phone testing

The camera preview uses `getUserMedia`, which exists only in a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
HTTPS, or `http://localhost` / `127.0.0.0/8`. On plain `http://<LAN-IP>:4200`
`navigator.mediaDevices` is `undefined`
([MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)),
so the screen falls back to the file input. WebKit (Safari, and every iOS
browser including Chrome, which uses WebKit) also requires HTTPS for camera
access ([WebKit](https://webkit.org/blog/7763/a-closer-look-into-webrtc/)).

### Start the three servers (separate terminals, from the repository root)

```sh
python scripts/dev.py api                      # Django on 127.0.0.1:8000 (run scripts/bootstrap.py once first)
(cd apps/pipeline && npm run prod)             # pipeline on 127.0.0.1:5175; `npm run dev` also works
(cd apps/web && npm start)                     # desktop: http://127.0.0.1:4200/capture (loopback only)
(cd apps/web && npm run start:phone)           # phone: https://<LAN-IP>:4443/capture (0.0.0.0, HTTPS)
```

The capture-map API makes no model calls, so the pipeline's provider keys
(read server-side from its env files; never commit or print them) are not
needed for capture. Restart the pipeline after its route files change. Port
8000 must be free for Django: another local project listening on 8000 makes
`/api`, `/admin` and `/accounts` reach the wrong server (`/api/health/live/`
must return `{"service":"snapway-api",…}`).

`npm run start:phone` runs [`scripts/phone_https.mjs`](../scripts/phone_https.mjs):
it creates a certificate in the git-ignored `local/certs/` for `localhost`,
`127.0.0.1`, `::1` and every current LAN IPv4, then runs
`ng serve --host 0.0.0.0 --port 4443 --ssl --ssl-cert … --ssl-key … --proxy-config proxy.conf.json`
([Angular `ng serve`](https://angular.dev/cli/serve)) and prints the phone
URLs. It uses `mkcert` when installed, otherwise `openssl` creates a local CA
(`local/certs/snapway-dev-ca.crt`, key `snapway-dev-ca-key.pem` kept private)
and a 397-day server certificate signed by it (RSA 2048, SAN, `serverAuth`, as
[Apple requires](https://support.apple.com/en-us/103769)). The certificate is
re-issued when the LAN IP changes; the CA is reused. Options:
`--port N`, `--ip A.B.C.D`, `--host H`, `--proxy-config F`;
`npm run cert:phone` only refreshes the certificate. Nothing is installed into
any trust store. Only `start:phone` listens on all interfaces, so the dev
server and everything it proxies (including Django admin with `DEBUG`) are
reachable from the network: use it on a trusted network and stop it after
testing.

Vite allows IP-address hosts by default and skips the host check over HTTPS
([Vite `allowedHosts`](https://vite.dev/config/server-options.html#server-allowedhosts)),
so no `allowedHosts` change is needed for LAN IPs. The proxy keeps the
original `Host` header (no `changeOrigin`) and talks plain HTTP to Django, so
Django sees an `http` request for host `<LAN-IP>:4443` while the browser sends
`Origin: https://<LAN-IP>:4443`. Django's CSRF origin check compares the Origin
with `request.is_secure()` scheme plus host, then `CSRF_TRUSTED_ORIGINS`
([Django CSRF](https://docs.djangoproject.com/en/5.2/ref/csrf/)). The
development settings (`config/settings/development.py` only; production is
unchanged) therefore add `DEV_EXTRA_ORIGINS` to `CSRF_TRUSTED_ORIGINS` and its
hosts to `ALLOWED_HOSTS`. The default is `https://localhost:4443`,
`https://127.0.0.1:4443` and `https://<primary LAN IPv4>:4443`, detected
when Django starts (restart Django after the network changes;
`DEV_PHONE_PORT` changes the port). Set
`DEV_EXTRA_ORIGINS=https://a,https://b` to replace the list, for example for a
tunnel. Session and CSRF cookies stay non-`Secure` in development, which
browsers accept over HTTPS too.

Verified from the Mac (October 17, 2026, LAN IP `100.102.93.140`, Django on a
scratch database): `https://100.102.93.140:4443/capture` served the app with
the certificate validating against the local CA; `/pipeline/api/health`,
`/api/health/live/`, `/api/health/ready/` and `/api/capture/me` were proxied
over HTTPS; a form `POST /accounts/login/` with
`Origin: https://100.102.93.140:4443` passed CSRF (credentials rejected, no
403) and a header-token `POST /accounts/logout/` (`X-XSRF-TOKEN`) returned 302;
an untrusted Origin and a missing token were refused with 403. An
authenticated capture upload over this route and any physical phone have not
been tested yet.

### Phone routes (best first)

1. **Android Chrome over USB (`adb reverse`, no certificate).** Enable
   Developer options and USB debugging
   ([adb](https://developer.android.com/tools/adb)), connect the cable, then
   on the Mac run `adb devices` and `adb reverse tcp:4200 tcp:4200`, start
   `npm start`, and open `http://localhost:4200/capture` in Chrome on the
   phone. `localhost` is a secure context and the request is same-origin for
   Django, so no extra settings are needed. `chrome://inspect/#devices` →
   Port forwarding does the same and adds remote DevTools
   ([Chrome](https://developer.chrome.com/docs/devtools/remote-debugging/local-server)).
   Remove with `adb reverse --remove-all`. Not available for iPhone.
2. **LAN HTTPS with a trusted local CA** (phone and Mac on the same Wi-Fi;
   campus or guest networks often isolate clients, then use route 1 or 4).
   Run `npm run start:phone` and install the CA it prints on the phone (the
   `.crt`/`rootCA.pem` only, never a `*-key.pem`). With mkcert instead of the
   built-in openssl CA: `brew install mkcert`, run `npm run cert:phone`, and use
   `$(mkcert -CAROOT)/rootCA.pem`; `mkcert -install` is only needed to trust it
   on the Mac itself and changes the Mac's trust store, so run it yourself if
   wanted ([mkcert](https://github.com/FiloSottile/mkcert)).
   - **iPhone (Safari or Chrome):** AirDrop the CA file to the phone, then
     Settings → General → VPN & Device Management → install the profile, then
     Settings → General → About → Certificate Trust Settings → enable full
     trust for "SnapWay local dev CA"
     ([Apple](https://support.apple.com/en-us/102390)).
   - **Android Chrome:** copy the file (for example
     `adb push local/certs/snapway-dev-ca.crt /sdcard/Download/`), then
     Settings → Security → Encryption & credentials → Install a certificate →
     CA certificate (menu names vary by vendor). Chrome loads user-added roots
     as trust anchors
     ([Chromium trust_store_android.cc](https://chromium.googlesource.com/chromium/src.git/+/main/net/cert/internal/trust_store_android.cc));
     other Android apps may not ([Android](https://developer.android.com/privacy-and-security/security-config)).
   - Open `https://<LAN-IP>:4443/capture`; no warning should appear. Remove the
     CA from the phone when testing ends.
3. **Self-signed click-through** (no CA install). Open
   `https://<LAN-IP>:4443/capture` and accept the warning (Chrome: Advanced →
   Proceed; Safari: Show Details → visit this website). The page is still an
   `https` origin, but neither Chrome nor WebKit documents camera access after
   a certificate-error bypass, and permissions may not be remembered. Check
   `window.isSecureContext` and whether the camera prompt appears; if not, use
   route 1, 2 or 4. Android Chrome alternative without HTTPS:
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with
   `http://<LAN-IP>:4200` (needs `npm start` reachable on the LAN, which the
   default loopback binding is not)
   ([Chromium](https://www.chromium.org/Home/chromium-security/deprecating-powerful-features-on-insecure-origins/)).
4. **Tunnel (public HTTPS, works on iPhone and Android, any network).** ngrok
   3 is installed on this Mac (cloudflared is not; Tailscale is installed but
   stopped). Run `npm start`, then
   `ngrok http 4200 --host-header=rewrite` and start Django with
   `DEV_EXTRA_ORIGINS=https://<subdomain>.ngrok-free.app python scripts/dev.py api`.
   Not exercised here. The tunnel URL is public: anyone with it reaches the dev server and its
   proxied Django admin, so stop it right after testing.

Browser device emulation and desktop webcams check layout and the code path
only; they are not physical-device camera verification. Camera behaviour,
rear-camera selection, EXIF orientation and upload retries must be checked on
a real phone.


## Authoring photo points and graph transfer

In `/authoring`, open a building and floor, select one corridor/lobby under **Regions**, then choose **Photo points for …**. The **Photo points** tab lists the numbered positions and supports selecting on the map, hiding/showing markers, removing points and relabelling. These plans are temporary UI state. Changing floors or reloading edited building data clears them, selected points and stale exported-draft links; a late planning response from the old floor is discarded.

The default is now an **adaptive count with a ceiling of 30 photo stops per circulation area**, requested by the user on 2026-10-18 after the earlier 12/20-stop defaults. Change **Photo-stop ceiling per circulation** (2–30) and press **Update photo stops** to regenerate. The denser count uses walking-network length divided by four candidate-spacing intervals (previously six), plus one endpoint allowance and up to four additional stops for turns/junctions; it is bounded by available candidates and the chosen ceiling. Weighted farthest-point selection distributes those stops along the paths. Small and simple areas get fewer stops; longer networks reach 30. This is a geometry-based starting heuristic, not a measured optimum for visual localization. With no verified scale, the spacing is relative to the plan rather than a claimed distance in metres. Walking paths, door openings and cross-floor routing are unchanged.

Current Sam Ibrahim collection counts (each stop has four directional photos):

| Floor | Stops per saved circulation |
| --- | --- |
| Level B | 30, 5, 1 |
| Level 1 | 30 |
| Level 2 | 16, 13, 30 |
| Level 3 | 30 |
| Level 4 | 30 |
| Level 5 | 18, 30 |

There are 233 recommended stops across 11 saved walks (932 possible directional photos), up from 163. Regions with no traced corridor path are not given invented photo locations.

Sparse planning: [planner](../apps/pipeline/shared/building/capture-points.js), [HTTP endpoint](../apps/pipeline/server/authoring-routes.js), [API client](../apps/web/src/app/features/authoring/pipeline.service.ts), [controls](../apps/web/src/app/features/authoring/authoring.html), [planner/API regressions](../apps/pipeline/tests/sam-ibrahim-project.test.js). The existing per-corridor mobile capture planner is unchanged.

**Send to graph editor** creates a fresh, single-floor draft with the rendered floor underlay and photo checkpoints. [photo-graph.ts](../apps/web/src/app/features/authoring/photo-graph.ts) preserves the planner's actual corridor polylines: it inserts checkpoints along segments and retains path bends and shared junctions. Nearby numbered points are not connected by an inferred straight chord. This fixes three wall-crossing links found in the old distance-only transfer on Sam Ibrahim Levels 1 and 3. It does not export cross-floor connectors, automatically join other floor drafts or grant capture membership. Additional path nodes are labelled separately from `Point N` photo checkpoints.

Implementation and tests: [authoring component](../apps/web/src/app/features/authoring/authoring.ts), [component regressions](../apps/web/src/app/features/authoring/authoring.spec.ts), [graph conversion](../apps/web/src/app/features/authoring/photo-graph.ts), [conversion tests](../apps/web/src/app/features/authoring/photo-graph.spec.ts). The component validates/converts the plan before starting an upload, and rejects off-path or duplicate photo locations. Paths remain in source coordinates until the existing underlay transformation is applied. The geometry converter does not require backend or dependency changes.

Before the density reduction, verification on 2026-10-18 passed 37 authoring/conversion tests and the production web build. Read-only checks of the dense Sam Ibrahim plans found 505 generated placements on corridor paths; all 814 converted links passed the existing wall/opening validator. Live Chrome checks confirmed map/list selection, hide/show and clearing the plan on a floor change. The signed-in capture screen reported no active admin/volunteer mapping target. No camera capture, R2 upload, real draft creation or membership change was performed.

Sparse-plan verification on 2026-10-18: 38 authoring/conversion tests, 232 pipeline tests (18 optional-fixture skips) and the production web build passed. All Sam Ibrahim halls were checked at limits 2, 6, 12 and 30 for deterministic counts, on-path coordinates, unchanged polylines and unchanged building data. Invalid budgets are rejected by the API. Live Chrome showed 8 markers on Level 5 circulation 1, regenerated exactly 6 through the control, then restored 8. The local pipeline service was restarted with its existing provider configuration; no model calls or environment changes were made.

**Four photos per point (R2).** In the graph editor, each selected node shows four slots: **Front**, **Right**, **Back** and **Left** (relative to the walking direction), each a file/camera input. `POST /api/maps/revisions/{rev}/nodes/{node}/photos/` takes an optional `direction` (`front`, `right`, `back`, `left`); the direction is kept in `ReferencePhoto.capture_context` (no migration), list/attach responses return it, and a new photo replaces that node's earlier photo for the same direction (the old asset row stays, as assets are append-only). Directional photos are stored in Cloudflare R2 only: when the configured Django S3 storage does not use an HTTPS R2 endpoint, the upload returns `503` and nothing is written. Undirected "Other photos" keep main's behaviour. Code: [references service](../apps/api/maps/services/references.py), [view](../apps/api/maps/views_graph.py), [web client](../apps/web/src/app/core/graph-api.service.ts), [graph editor](../apps/web/src/app/features/graph-editor/graph-editor.html); tests in [test_node_media.py](../apps/api/tests/test_node_media.py). The current API configuration resolves to filesystem storage, so directional uploads correctly return 503 until the team supplies real R2 settings privately in `local/.env`. No credentials were changed or printed. The existing optional `storage` dependency is included in CI commands to exercise the real storage adapter with stubbed R2 responses. No new packages or schema migrations were introduced.

Implementation: [dc708c0](https://github.com/mhamza1906/SnapWay/commit/dc708c0) on the local feature branch; the remote link becomes available after a push.

Sparse stop limits: [4bf3c00](https://github.com/mhamza1906/SnapWay/commit/4bf3c00) on the local feature branch; the remote link becomes available after a push.

Four-view safeguards: corrupt images are rejected before upload; replacements serialize on the point and preserve the old view if storage fails. Delayed list/upload responses cannot populate a different selected point. The editor displays a 0–4 completion count and prevents overlapping uploads. “Front” is manually chosen relative to walking direction; no automatic heading or localization accuracy is claimed. Additional path bend/junction nodes preserve routing geometry and do not require four photos.

Verification for the 12-stop/four-view change: 38 authoring/conversion tests, 5 graph-editor tests, 46 related Django tests (1 PostgreSQL-only skip), and 232 pipeline tests (18 optional-fixture skips) passed. The production web build passed. R2 adapter tests stub remote S3 responses while exercising storage writes and signed URL generation; no live cloud upload or camera test was performed. The live local planner API returns 12 points by default after restart. No browser or desktop automation was used. Editor implementation: [logic](../apps/web/src/app/features/graph-editor/graph-editor.ts), [styles](../apps/web/src/app/features/graph-editor/graph-editor.scss), [tests](../apps/web/src/app/features/graph-editor/graph-editor.spec.ts); [CI storage extra](../.github/workflows/ci.yml).

Twelve-stop defaults and four R2 views: [2ebc522](https://github.com/mhamza1906/SnapWay/commit/2ebc522).

## Phone photo walk over a temporary HTTPS preview

Open `<PREVIEW_ORIGIN>/graph-editor?mode=photos` in Safari/Chrome on the phone and sign in with the same Google account used on the computer. Choose the saved floor/circulation, stand at the highlighted numbered stop, and take Front, Right, Back and Left. Previous/Next and a stop picker avoid tapping small map markers. Only numbered photo stops appear in this view; graph-editing controls and path support vertices are omitted. Completion counts are returned from the server, so already-uploaded views resume on another signed-in device. Switching maps uses the contributor's own writable draft list; it grants no new access to other people's maps.

The [phone view and shared logic](../apps/web/src/app/features/graph-editor/graph-editor.ts), [template](../apps/web/src/app/features/graph-editor/graph-editor.html) and [phone styles](../apps/web/src/app/features/graph-editor/phone-walk.scss) use large camera buttons, a narrow-screen layout, safe-area padding and sticky previous/next navigation. The existing desktop [editor styles](../apps/web/src/app/features/graph-editor/graph-editor.scss) stay separate. Images are oriented/decoded by the browser, resized to at most 2048 pixels on the long side and encoded as JPEG before the existing 5 MiB upload API.

[Pending photos](../apps/web/src/app/features/graph-editor/point-photo-queue.ts) are saved in IndexedDB, scoped to the signed-in account/revision/point/direction, before attempting upload. They are removed only after the server acknowledges the upload. Failed uploads remain retryable; one pending file per direction is retained. The page distinguishes phone-pending from cloud-uploaded photos. Browser storage failures fall back to memory with a visible keep-this-tab-open notice. This does not provide a fully offline website: load the page/maps while connected; pending files can resume after reconnecting to the same browser and preview origin. [Queue tests](../apps/web/src/app/features/graph-editor/point-photo-queue.spec.ts), [view regressions](../apps/web/src/app/features/graph-editor/graph-editor.spec.ts).

[Graph responses](../apps/api/maps/services/graph.py) include saved view directions and a storage-configuration flag. [Reference uploads](../apps/api/maps/services/references.py) and the graph API share the same [R2 readiness check](../apps/api/maps/services/media_store.py). The [draft-list endpoint](../apps/api/maps/views_graph.py) returns only the caller's writable draft targets. [Web API client](../apps/web/src/app/core/graph-api.service.ts); [API tests](../apps/api/tests/test_node_media.py). Credentials remain server-side.

### Preview setup and account handoff

The user chose a temporary preview with the computer remaining on. [phone-preview.mjs](../scripts/phone-preview.mjs) starts/reuses only the named `snapway-phone` tunnel through the already-running configured ngrok agent; it leaves unrelated tunnels unchanged. Run `node scripts/phone-preview.mjs info` for the current phone URL and required API/frontend commands, or `start` if the named tunnel is absent. It writes only non-secret preview metadata to ignored `local/phone-preview.json`. `stop` removes only this tunnel. [ngrok's local agent API](https://ngrok.com/docs/gateway/agent/api) documents starting/stopping endpoints without stopping the agent.

Preserve the public Host through the tunnel. The frontend allows exactly that additional host through Vite's existing `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` option. The loopback Django development process uses `DEV_EXTRA_ORIGINS=<PREVIEW_ORIGIN>` and the existing `DJANGO_TRUST_PROXY=true` opt-in; [development settings](../apps/api/config/settings/development.py) trust the HTTPS scheme from this controlled preview proxy. The public API/session and CSRF-protected Google-login POST were checked. The resulting OAuth callback uses the public HTTPS origin, rather than a loopback URL.

The Google OAuth web client's **Authorized redirect URIs** must include `<PREVIEW_ORIGIN>/accounts/google/login/callback/` exactly. On 2026-10-18 Google rejected the new preview callback with `redirect_uri_mismatch`; the user was given the Cloud Console Clients steps to add it. The user added the callback, and a fresh Google authorization request returned without `redirect_uri_mismatch` or another OAuth error. Human account selection/sign-in is left to the user. Keep the computer awake, connected and running the API, frontend and ngrok. A new preview hostname needs a new OAuth callback entry and cannot access pending browser storage from an old hostname. Remove the temporary callback when retiring the preview.

R2 credentials were supplied in existing private local configuration during this task. A real synthetic R2 write, read-back and signed-URL GET succeeded, and the synthetic object was removed. Display underlays for the imported walks were stored through the configured R2 adapter. No human camera photos were captured or uploaded by the agent. The consolidated `local/.env` contract is still absent in this checkout; the existing private legacy configuration supplies the working settings. Never copy secrets into Git. Local SQLite backups are excluded through [gitignore](../.gitignore).

### Preparing Sam Ibrahim's saved walks

Signed-in contributors can now open their own saved maps directly from `/map`: choose a floor/circulation under **Your saved indoor maps**, then select **Open photo walk**. The picker loads independently of the optional outdoor Google Maps SDK; its failure cannot hide or disable indoor collection. On phones the saved-map controls appear before the outdoor map. The list uses the existing owner-scoped draft API, updates after sign-in, clears after sign-out and offers retry on failure; it does not publish drafts as reviewed visitor maps. Implementation: [map.ts](../apps/web/src/app/features/map/map.ts), [template](../apps/web/src/app/features/map/map.html), [styles](../apps/web/src/app/features/map/map.scss), [tests](../apps/web/src/app/features/map/map.spec.ts). Four discovery tests and the production web build passed for this access change, including an unavailable SDK, selection of a specific saved walk, retry and sign-out during a pending request. Physical-phone testing remains with the user.

The [offline exporter](../experiments/sam-ibrahim-hardcoded/phone-walks.mjs) uses the same original-SVG project, adaptive 30-stop ceiling and source-polyline graph conversion as authoring. It does not call an AI provider. The [import command](../apps/api/maps/management/commands/import_photo_walks.py) creates only the named existing contributor's own new drafts and skips already-imported source identities. `--upgrade-existing` explicitly updates a matching previous source plan in place. It preserves the target, revision, underlay, every existing node ID/coordinate and all photo references; it refuses a changed frame or an export that drops an old node. Previous photo locations that are not recommended now remain as path vertices. The phone view also includes retained locations with uploaded or locally queued photos, so these remain accessible. Numbering may change to follow the current itinerary; no photograph moves to another physical location.

```sh
node --experimental-strip-types experiments/sam-ibrahim-hardcoded/phone-walks.mjs local/phone-walks.json
DJANGO_SETTINGS_MODULE=config.settings.development .venv/bin/python apps/api/manage.py import_photo_walks --username YOUR_EXISTING_USERNAME --file local/phone-walks.json --upgrade-existing
```

The local database was backed up before import and again before each density update. The initial 11 walks contained 121 stops, the first adaptive version 163, and the same walks now contain 233, including both Level 5 areas (48 stops / 192 possible directional photos). All existing targets, revision IDs, node IDs/coordinates and source underlays were verified unchanged. No global staff role or other user's membership was changed. The export is single-floor collection data; it does not alter the project's cross-floor routes.

Phone-workflow verification on 2026-10-18: 11 editor/queue/graph-conversion tests and 18 related Django tests passed; the production web build passed without style-budget warnings. Django system checks and migration checks passed (no schema changes), and source/diff checks passed. Re-importing the saved walks preserved existing drafts. Public page and session API returned 200; the CSRF-protected OAuth start generated the exact public HTTPS callback, accepted by Google after the user updated it. R2 and OAuth credentials were never printed or committed.

The user subsequently confirmed the preview opens after a transient connection timeout. Local/public frontend and public session API checks returned 200; no browser/network security settings were changed. Phone camera/upload behavior remains for the user's physical-device test.

Mobile collection implementation: [3de9a9a](https://github.com/mhamza1906/SnapWay/commit/3de9a9a).
Home-page saved-map access: [8d734c1](https://github.com/mhamza1906/SnapWay/commit/8d734c1).

Adaptive-update verification: 47 authoring/graph-conversion/phone-editor tests, 17 planner/project tests and 13 node-media/import tests passed. Tests cover size-dependent counts, unchanged paths, retained node/photo identity, repeat import, rejection of moved locations and visibility of queued/uploaded photos on retained vertices. Regression tests: [phone editor](../apps/web/src/app/features/graph-editor/graph-editor.spec.ts), [API/import](../apps/api/tests/test_node_media.py). The production web build and source checks passed. The live planner was restarted with the same provider settings; no model calls, credential changes or computer-use tools were involved.

Adaptive planning and preserved saved-walk updates: [b9ffb2b](https://github.com/mhamza1906/SnapWay/commit/b9ffb2b).

Local image handoff (2026-10-18): exported `Hack_The_valley/Sam-Ibrahim-Circulation-Maps/` beside this checkout, then replaced it with the denser 30-stop-ceiling version. Open `index.html` there for the offline gallery. It contains 11 full-floor PNGs with the saved numbered stops, 11 zoomed PNGs, six floor overviews and 11 SVGs. `manifest.json` records all 233 point coordinates and counts. Images use the original SVG source frame and the same planner/renderer as the app; every point was checked against the saved adaptive export. All 28 PNGs and 11 SVGs were verified, and representative images were visually inspected. The previous 20-stop-ceiling export was preserved in `Hack_The_valley/output/backups/`. These exports are plan images rather than captured camera photographs.

The user requested clearing the uploaded Level 1 Point 13 views before rebuilding. A read-only check found exactly four front/right/back/left attachments there and none on Point 3. After a database backup, the four attachments were removed using [remove_node_photo](../apps/api/maps/services/references.py); all other references were preserved. The original physical location is now **Point 19** after renumbering and has no attached photos. As in the existing removal API, append-only Asset rows and R2 bytes remain retained; this clears active map attachments rather than purging storage. No camera photo was downloaded or re-uploaded.

Denser-plan verification: 47 focused frontend tests, 17 planner/project tests and 14 node-media/import tests passed, including expansion to 30 with existing photos and node identity preserved. The production build, lint and source checks passed. Local image files match the same 233 website stop locations. The live planner was restarted with the same provider settings; no model calls or computer-use tools were used.

Thirty-stop ceiling and increased density: [4fbcadc](https://github.com/mhamza1906/SnapWay/commit/4fbcadc).
