# Visitor localization against stored MegaLoc indexes

**Canonical product visitor path** (with [localization-megaloc.md](localization-megaloc.md)).  
**On:** `main` / `feature/frontend-iteration` (merged via PR #15; no separate merge needed).  
**Status:** Camera integration implemented; each environment needs a running engine and ready indexes. The graph editor can rebuild MegaLoc indexes.
Personal history: ignored `local/ACTIONS.md`.

## Goal

Visitor submits a camera JPEG (**no floor prompt**). MegaLoc embeds once and cosine-searches the **union of all ready floor index zips**. Response includes building/floor/target/node + decision (`floor_id` is **output enrichment**, not an input).

```text
JPEG → Django POST /api/navigation/localize/
  → sync ready RevisionArtifact index zips to place-match catalog
  → POST engine /v1/match-global
  → JSON: decision, node_id, target_id, floor_id, building_id, …
```

Visitor UI posts from [`visitor-camera.ts`](../apps/web/src/app/features/visitor/visitor-camera.ts). Index rebuild: graph editor toolbar or `manage.py build_reference_index`.

## Design

- **Eligible indexes:** current `Publication` revisions with `RevisionArtifact(kind=index, state=ready)`. When `DEBUG=True`, also unfrozen draft revisions with a ready index.
- **Engine:** [`placematch/catalog_index.py`](../apps/place-match/placematch/catalog_index.py) + `/v1/catalog`, `/v1/catalog/sync`, `/v1/match-global` on [`mobile_api.py`](../apps/place-match/placematch/mobile_api.py).
- **Catalog sync:** JSON body with optional base64 zips (not multipart). `GlobalCatalog.sync` must not call `snapshot()` while holding the same non-reentrant lock (deadlock).
- **Django:** [`maps/services/index_catalog.py`](../apps/api/maps/services/index_catalog.py), [`navigation/services/placematch.py`](../apps/api/navigation/services/placematch.py), [`LocalizeView`](../apps/api/navigation/views.py) (default `mode=global`; `mode=legacy` keeps old single-set match).
- **Cross-floor guard:** if top-1/top-2 are different `target_id` and cosine margin is thin → `uncertain`.
- **Thresholds:** without `apps/place-match/data/calibration/current.json`, MegaLoc never returns `likely_match` (stays `uncertain`). Local E2E can use REPORT-v2 MegaLoc accept ≥ 0.331 (gitignored under `data/`).
- **Still later:** Capture/`LocalizationResult` persistence, Vertex/verify on global path, visitor text route guidance (separate branch).

## Frontend handoff — `POST /api/navigation/localize/`

Auth: session user, navigation capability, or DEBUG `PLACEMATCH_DEV_TOKEN` (same as before).

Multipart:

| Field | Content |
| --- | --- |
| `image` | JPEG ≤ 3 MiB, ≤ 4096 px longest side |
| `meta` | JSON e.g. `{"client_frame_id": 1, "timestamp_s": 1.0}` |

Query (optional):

| Param | Meaning |
| --- | --- |
| *(none)* | Global search (default) |
| `revision_id` / `target_id` | Debug: restrict catalog to one revision or floor target |
| `mode=legacy` | Old single reference-set `/v1/match` (engine default set) |

Success **200** (shape abbreviated):

```json
{
  "decision": {
    "outcome": "likely_match",
    "node_id": "<uuid>",
    "location_id": "<uuid>",
    "revision_id": "<uuid>",
    "target_id": "<uuid>",
    "reference_id": "reference:…",
    "reasons": ["…"]
  },
  "node_id": "<uuid>",
  "matched_node": {
    "node_id": "<revision-local node uuid>",
    "stable_id": "<stable node uuid>",
    "revision_id": "<uuid>",
    "target_id": "<uuid>",
    "label": "West stair landing",
    "kind": "stairs",
    "floor_id": "<uuid>",
    "floor_name": "Floor 1",
    "building_id": "<uuid>",
    "building_name": "Example building"
  },
  "localization_token": "<signed short-lived route handoff>",
  "target_id": "<uuid>",
  "floor_id": "<uuid>",
  "building_id": "<uuid>",
  "floor_code": "4",
  "floor_name": "…",
  "building_name": "…",
  "building_slug": "…",
  "candidates": [ … ],
  "backend_used": "megaloc",
  "timings_ms": { … },
  "caller": "user"
}
```

`outcome` is `likely_match` | `uncertain` | `no_supported_match`.

Errors:

| Status | `error` | When |
| --- | --- | --- |
| 503 | `index_not_ready` | No ready indexes in catalog |
| 409 | `stale_location` | Accepted engine IDs do not resolve to a node on an eligible revision/target, or node/location IDs disagree |
| 503 | `not_configured` / `unavailable` | Engine URL/token missing or down |
| 415 / 413 / 400 | `invalid_image` / validation | Bad JPEG / meta |

## Camera result to confirmed visitor node

October 18 integration extension, pending deployment: camera capture continues
to use the existing JPEG/meta endpoint and MegaLoc global matcher. There is no
new recognition model or scene-text pipeline. The
[node resolver](../apps/api/navigation/services/detected_node.py) validates a
`likely_match` against the eligible index revision/target and loads the exact
`maps_node` row. It returns `matched_node` with the camera-location node's ID,
stable identity, label, floor and building; this is not an observed target node
or proof that another node is ahead of the camera. Only a resolved node receives
the signed route handoff. Uncertain/unsupported outcomes return null
`matched_node` and null `localization_token`; stale identities return 409.

The [API integration](../apps/api/navigation/views.py) preserves engine scores
and decisions. [Typed response validation](../apps/web/src/app/core/place-match.ts)
accepts the new object and rejects malformed node payloads while retaining legacy
response support. The [visitor controller](../apps/web/src/app/features/visitor/visitor.ts)
keeps suggested and confirmed node objects separately, checks the selected
building and returned identities, and uses the signed location for routing only
after user confirmation. The [confirmation panel](../apps/web/src/app/features/visitor/visitor.html)
shows the node label, floor and building inside the visible indoor panel;
image browsing does not change the confirmed physical node. Recapture,
cancellation, background and destination changes clear the detected-node state.

[Camera coverage](../apps/web/src/app/features/visitor/visitor-camera.spec.ts)
exercises one browser JPEG upload with an in-memory visitor capability and the
exact returned node. [API integration coverage](../apps/api/tests/test_photo_routing.py)
runs real session, multipart-localize, node validation, signed-handoff and route
views with only the engine boundary mocked. [Global API coverage](../apps/api/tests/test_localize_global.py),
[visitor route coverage](../apps/web/src/app/features/visitor/visitor.spec.ts)
and [payload validation](../apps/web/src/app/core/place-match.spec.ts) cover IDs,
cross-floor starts, uncertain results, malformed payloads and reset behavior.

Validation for this extension: 176 backend tests pass on isolated PostgreSQL;
158 pass with 18 PostgreSQL-only skips on SQLite. All 116 frontend tests pass.
Web and visitor production builds, Android asset sync and browser acceptance
with fake camera/synthetic responses pass. This is integration evidence, not a
new live MegaLoc accuracy test, real R2-fetch verification or physical-device
acceptance. The earlier dated live evidence below belongs to the teammate's
existing matcher. No dependencies, database migrations, env keys/private values
or architecture change are required. Current extension commit is pending.

## Sample room for camera testing

On October 18, a database-backed test destination was created under **IA Building**:
floor **Camera test - sample only**, room **CAM-TEST-001**, named **Camera test room
(sample)**. Refresh `/app-review`, select that building and room, then choose
**Yes, I'm inside** to open the existing camera flow.

This separate test floor copies five readable scene photos from the Level 1 draft:
four at the west-exit node and one at the east-entrance node. The synthetic room
is attached to the copied west-exit node. Tiny upload-test images are excluded.
Original drafts and files are unchanged; copied photo associations retain proposed
status. This fixture has no walking edges and does not establish a verified route
or an additional physical floor.

Test target: `a922db6e-8cc1-4371-85e0-b5853385fcc0`; initial published revision:
`5114accc-d4ae-4755-a11d-540a91c6ef92`. The publication makes the room selectable,
but contains **no ready MegaLoc index**. The checked localhost settings also have
no configured localization engine. Recognition is therefore not ready to test:
an upload currently receives `503 index_not_ready`, rather than a no-match result.

Obtain the existing `PLACEMATCH_ENGINE_URL` and `PLACEMATCH_ENGINE_TOKEN` values
through the team's private channel, update the existing `local/.env`, run the
[environment contract check](environment-sync.md) and restart the API. Prepare
the engine, weights and calibration using [the matcher guide](localization-megaloc.md).
Open a new edit of this test floor, rebuild its photo index, and publish that
revision through the existing workflow; published content is immutable.
Use a fresh photo of one of the stored scenes for an actual recognition check.
Successful room discovery/session creation alone does not validate inference.
No template, dependency or architecture change was made for this fixture.
Local validation confirmed room discovery, visitor session creation and an actual
camera upload returning `index_not_ready`; browser media was synthetic and no
inference result was mocked. All six copied storage assets passed read/hash checks,
and rerunning fixture creation reused the same room. Recognition accuracy and
physical-device behavior remain unverified. Documentation commit is pending.

### Camera service feedback

The [browser camera](../apps/web/src/app/features/visitor/visitor-camera.ts) now
handles Angular HTTP errors through the same
[response parser](../apps/web/src/app/core/place-match.ts) as native uploads.
Missing reference indexes, an unconfigured service, an offline engine and a
network failure receive distinct recovery messages. These service failures never
emit a detected location. Actual uncertain/no-match results still ask for another
door sign or landmark. The black preview after an upload reflects the existing
camera stream shutdown; **Open camera** starts a new capture.

[Camera regression coverage](../apps/web/src/app/features/visitor/visitor-camera.spec.ts)
checks a real Angular HTTP 503 rejection and no location emission;
[parser coverage](../apps/web/src/app/core/place-match.spec.ts) checks the service
error codes shared with native uploads. This improves feedback only and does not
configure or start the matching engine or build an index.
Validation: all 119 frontend tests pass, both production builds and Android asset
sync pass, and a browser check against the real localhost API displays the
missing-reference message for `503 index_not_ready`. The existing application
stylesheet budget warning remains. No engine configuration or device install
was performed; the feedback change's commit is pending.

## How to run (backend)

```sh
# Terminal 1 — engine
cd apps/place-match
uv sync
uv run python -c "from placematch.backends.megaloc import download; download()"
uv run placematch serve-mobile

# local/.env — PLACEMATCH_ENGINE_URL=http://127.0.0.1:8790 and matching TOKEN

# Terminal 2 — API
python scripts/dev.py api

# Build indexes on drafts (DEBUG) or publish revisions, then:
# POST /api/navigation/localize/ with JPEG + meta (no floor fields)
```

## Tests

- `apps/api/tests/test_localize_global.py` — catalog eligibility, global localize enrichment, empty catalog (mocked engine).
- `apps/api/tests/test_localization.py` — legacy `mode=legacy` path.
- `apps/place-match/tests/test_catalog_index.py` — cross-target uncertain helper.

## Commits / evidence

- Draft + multi-floor design on this branch (2026-10-17).
- Backend global catalog + localize (2026-10-17).
- Live E2E: catalog sync deadlock fix + calibrated localize → `likely_match` (2026-10-17).
- Confirmed on `feature/frontend-iteration` (2026-10-18): engine health + empty catalog sync + Django localize → `likely_match` (2 catalog sets).
