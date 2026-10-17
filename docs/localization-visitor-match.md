# Visitor localization against stored MegaLoc indexes (draft)

**Branch:** `feature/visitor-localization-match`  
**Status:** Draft plan — not implemented yet.  
**Depends on:** [localization-megaloc.md](localization-megaloc.md) (developer embed + store, merged via PR #13).  
Personal history: ignored `local/ACTIONS.md`.

## Goal

Let a **visitor (or signed-in tester)** submit a camera JPEG and get back a **matched graph node** by comparing against the revision’s stored MegaLoc index (`RevisionArtifact` kind=`index`).

```text
Developer half (done)
  ReferencePhotos → MegaLoc → Asset zip + RevisionArtifact ready

Visitor half (this branch)
  JPEG frame + revision (or published target)
    → SnapWay API /localize/ (extended)
    → place-match MegaLoc cosine match vs that revision’s vectors
    → node_id (location_id) + decision (likely_match | uncertain | no_supported_match)
```

## What already exists

| Piece | Role |
| --- | --- |
| Index zip on `RevisionArtifact` | `vectors.npy`, `index.txt`, `meta.json`, `locations.json` (`image_id` → `node_id`) |
| place-match `serve-mobile` `/v1/match` | MegaLoc match against a **named folder** reference set |
| Django `/api/navigation/localize/` | Validates JPEG, forwards to engine; **does not** select a map revision’s stored artifact |
| iOS / live-locate client | Capture → localize against engine’s fixed `MOBILE_REFERENCE_SET` |

## Design (chosen for first implementation)

### 1. Resolve which index to use

Request names either:

- `revision_id` (dev/contributor testing on a draft with a ready index), or  
- `target_id` → current `Publication` revision (visitor-facing path when publications exist).

Require `RevisionArtifact(kind=index, state=ready)` with an `Asset`. Otherwise `404` / `503` with a clear code (`index_not_ready`).

### 2. Register / load index into the engine

Engine today loads one set from `data/references/<name>/`. Extend place-match with:

- **`POST /v1/references/load-index`** (or equivalent CLI): accept the zip (or paths to `vectors.npy` + `index.txt` + `locations.json`), register as set name `rev_<revision_id_compact>`.
- Match uses **vectors only** for scoring; thumbnails optional later (may omit image bytes in v1).
- Django, before `/v1/match`, ensures the set is loaded (cache by artifact `input_content_hash` / asset sha256 so rebuilds refresh).

Alternative considered and rejected for v1: re-implement MegaLoc cosine inside Django (would pull torch into the API venv).

### 3. API contract (Django)

Extend localize (or add sibling) so clients can pass revision/target:

```http
POST /api/navigation/localize/
multipart: image (JPEG) + meta (JSON)
query or form: revision_id=…   OR   target_id=…
```

Response (engine decision, plus SnapWay fields):

```json
{
  "decision": "likely_match",
  "node_id": "<uuid>",
  "revision_id": "<uuid>",
  "reference_id": "…",
  "backend_used": "megaloc",
  "candidates": [ … ],
  "timings_ms": { … }
}
```

`node_id` = `locations.json` / place-match `location_id` (already node UUID from embed half).

**Auth for v1 (dev):** keep existing localize auth (session / nav capability / DEBUG token). Do not require full visitor `NavigationSession` productization yet.

**Still out of scope for this draft’s first PR:** writing `Capture` / `LocalizationResult` rows (needs frame-retention approval).

### 4. Minimal tester UI

Reuse or thin-wrap existing live-locate / a small `/localize-test` page:

- pick or paste `revision_id` (with ready index),
- upload or capture one JPEG,
- show matched `node_id` + decision.

Full visitor map guidance (route, arrival) remains later.

## Non-goals (this branch)

- Multi-angle authoring UX / “index stale” banners  
- Auto-rebuild index on every photo upload  
- Celery workers / Cloud Run place-match hosting  
- Continuous tracking / IMU  
- Persisting visitor frames to R2  
- Geometric verification / Vertex second opinion (keep engine defaults: MegaLoc-only)

## Implementation slices

| Slice | Work |
| --- | --- |
| A | place-match: load index zip → in-memory / on-disk set; match without photo files |
| B | Django: resolve revision artifact → push/load to engine → forward match; map `location_id` → `node_id` |
| C | Tests: fake engine + fake artifact zip; one optional live MegaLoc smoke |
| D | Minimal web tester UI (revision id + JPEG → result) |
| E | Docs: this file → “implemented”; link from `localization-megaloc.md` |

Suggested order: **A → B → C → D → E**.

## Env

Reuse existing:

| Variable | Role |
| --- | --- |
| `PLACEMATCH_ENGINE_URL` / `TOKEN` / `TIMEOUT_S` | Django → engine |
| `S3_*` / `MEDIA_ROOT` | Read index Asset bytes |
| `MOBILE_REFERENCE_SET` | Legacy default set name; revision sets use `rev_*` names |

No schema migration expected if `RevisionArtifact` + `Asset` already hold the index.

## How to verify (once built)

1. Graph editor: photos on nodes → `POST …/revisions/<id>/index/` → `ready`.  
2. Start `uv run placematch serve-mobile` from `apps/place-match`.  
3. Set `PLACEMATCH_ENGINE_*` in `local/.env`.  
4. `POST /api/navigation/localize/` with a JPEG similar to a reference + `revision_id`.  
5. Expect `decision: likely_match` and the correct `node_id`.

## Open points (resolve during implementation, not blockers for starting A)

- Cache invalidation when the same revision’s index is rebuilt (hash key).  
- Whether unpublished drafts are allowed for localize in production (default: allow in DEBUG / membership only).  
- Thumbnail URLs without storing image copies in the engine set.

## Commits / evidence

- Draft opened on `feature/visitor-localization-match` (2026-10-17).  
- Implementation commits TBD.
