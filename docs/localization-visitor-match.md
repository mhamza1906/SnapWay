# Visitor localization against stored MegaLoc indexes

**Canonical product visitor path** (with [localization-megaloc.md](localization-megaloc.md)).  
**Branch:** `feature/visitor-localization-match`  
**Status:** Backend implemented and live-E2E verified (no frontend UI in this PR).  
Personal history: ignored `local/ACTIONS.md`.

## Goal

Visitor submits a camera JPEG (**no floor prompt**). MegaLoc embeds once and cosine-searches the **union of all ready floor index zips**. Response includes building/floor/target/node + decision (`floor_id` is **output enrichment**, not an input).

```text
JPEG → Django POST /api/navigation/localize/
  → sync ready RevisionArtifact index zips to place-match catalog
  → POST engine /v1/match-global
  → JSON: decision, node_id, target_id, floor_id, building_id, …
```

Frontend is owned by teammates; this document is the **API handoff**.

## Design

- **Eligible indexes:** current `Publication` revisions with `RevisionArtifact(kind=index, state=ready)`. When `DEBUG=True`, also unfrozen draft revisions with a ready index.
- **Engine:** [`placematch/catalog_index.py`](../apps/place-match/placematch/catalog_index.py) + `/v1/catalog`, `/v1/catalog/sync`, `/v1/match-global` on [`mobile_api.py`](../apps/place-match/placematch/mobile_api.py).
- **Catalog sync:** JSON body with optional base64 zips (not multipart). `GlobalCatalog.sync` must not call `snapshot()` while holding the same non-reentrant lock (deadlock).
- **Django:** [`maps/services/index_catalog.py`](../apps/api/maps/services/index_catalog.py), [`navigation/services/placematch.py`](../apps/api/navigation/services/placematch.py), [`LocalizeView`](../apps/api/navigation/views.py) (default `mode=global`; `mode=legacy` keeps old single-set match).
- **Cross-floor guard:** if top-1/top-2 are different `target_id` and cosine margin is thin → `uncertain`.
- **Thresholds:** without `apps/place-match/data/calibration/current.json`, MegaLoc never returns `likely_match` (stays `uncertain`). Local E2E can use REPORT-v2 MegaLoc accept ≥ 0.331 (gitignored under `data/`).
- **Not in this PR:** Angular UI, Capture/`LocalizationResult` persistence, Vertex/verify on global path.

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
| 503 | `not_configured` / `unavailable` | Engine URL/token missing or down |
| 415 / 413 / 400 | `invalid_image` / validation | Bad JPEG / meta |

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
