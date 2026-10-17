# Visitor localization against stored MegaLoc indexes (draft)

**Branch:** `feature/visitor-localization-match`  
**Status:** Draft plan — not implemented yet.  
**Depends on:** [localization-megaloc.md](localization-megaloc.md) (developer embed + store, merged via PR #13).  
Personal history: ignored `local/ACTIONS.md`.

## Goal

Let a **visitor** submit a camera JPEG (no floor prompt) and get back **which floor and node** by MegaLoc cosine search over **all ready floor-map index zips**.

```text
Developer half (done)
  Per MapTarget/floor revision: ReferencePhotos → MegaLoc → index zip on RevisionArtifact

Visitor half (this branch)
  JPEG frame only (no floor / target / revision from the user)
    → embed once with MegaLoc
    → cosine vs every ready floor index (published preferred)
    → best global hit → building/floor/target + node_id + decision
```

## Design decision (updated)

**Do not ask the user which floor they are on.** The app does not rely on GPS for indoor floor. Instead:

1. Embed the visitor photo **once**.  
2. Score it against **all** eligible MegaLoc indexes (one gallery per floor map revision).  
3. Take the **global** top candidate(s); the winning reference’s index carries `target_id` / `revision_id` / `node_id` (and thus floor).

Indexes remain stored **per revision** (one floor version each). Search is **cross-floor**, not “one big floorplan embedding.”

Optional **debug** query params (`revision_id` / `target_id`) may restrict search for developers; they are not part of the visitor UX.

## What already exists

| Piece | Role |
| --- | --- |
| Index zip on `RevisionArtifact` | `vectors.npy`, `index.txt`, `meta.json`, `locations.json` (`image_id` → `node_id`) |
| place-match `/v1/match` | MegaLoc match against a **single** named reference set |
| Django `/api/navigation/localize/` | Forwards one frame to the engine; no multi-index / floor resolution yet |
| iOS / live-locate | Capture UI; still assumes a fixed engine set today |

## Design (chosen for first implementation)

### 1. Which indexes are eligible

Default visitor catalog:

- Each `MapTarget` (floor) with a **current `Publication`**, and  
- That publication’s revision has `RevisionArtifact(kind=index, state=ready)`.

Dev/DEBUG may also include unfrozen drafts with a ready index (membership-gated), so testers can run without a full publish loop.

If **no** ready indexes exist → `503` / `index_not_ready`.

### 2. Global search mechanics

- MegaLoc **embed query once** (same backend key as embed half, e.g. `megaloc:5fe0dd6:322x322`).  
- Load each eligible index zip into the engine (or one concatenated gallery with per-row metadata: `target_id`, `revision_id`, `node_id`, `reference_id`).  
- Cosine top-k **across the union**; apply existing place-match decision thresholds on the global ranking (or calibrated multi-set policy: margin vs 2nd place, including 2nd place on another floor).  
- Response includes floor context derived from the winning target (`building` / `floor` / `target_id` / `revision_id` / `node_id`).

**Risk:** visually similar corridors on different floors. Mitigation for v1: keep calibrated `uncertain` when top-1 and top-2 are close (especially cross-target); do not invent a floor. Optional later: building filter if outdoor/context ever provides building only (still no floor prompt).

### 3. Engine / Django split

- **place-match:** support multi-set or merged-index match from zips (vectors + locations + set metadata); still no torch in Django.  
- **Django:** list eligible artifacts, ensure engine has them loaded (keyed by asset sha256 / `input_content_hash`), forward JPEG, map engine hit → SnapWay IDs.

Reject re-implementing MegaLoc inside the API venv.

### 4. API contract (Django)

```http
POST /api/navigation/localize/
multipart: image (JPEG) + meta (JSON)
# visitor: no floor fields required
# optional debug: revision_id=… or target_id=… to search one gallery only
```

Example success body:

```json
{
  "decision": "likely_match",
  "node_id": "<uuid>",
  "revision_id": "<uuid>",
  "target_id": "<uuid>",
  "floor_id": "<uuid>",
  "building_id": "<uuid>",
  "reference_id": "…",
  "backend_used": "megaloc",
  "candidates": [ … ],
  "timings_ms": { … }
}
```

**Auth for v1 (dev):** existing localize auth (session / nav capability / DEBUG token). Full visitor `NavigationSession` productization later.

**Out of scope for first PR:** `Capture` / `LocalizationResult` persistence (frame retention).

### 5. Minimal tester UI

Upload/capture one JPEG → show **floor + node + decision** (no floor picker). Debug-only optional “limit to revision” control behind a flag.

## Non-goals (this branch)

- Prompting the user for floor / map  
- Multi-angle authoring UX  
- Auto-rebuild index on photo upload  
- Celery / Cloud Run hosting  
- Continuous tracking / IMU  
- Persisting visitor frames  
- Vertex / geometric verification (MegaLoc-only defaults)

## Implementation slices

| Slice | Work |
| --- | --- |
| A | place-match: load many index zips; match query vs union (metadata per row) |
| B | Django: discover eligible published (and DEBUG draft) indexes; sync to engine; localize → floor + node |
| C | Tests: multi-floor fake indexes; correct floor wins; uncertain when scores collide |
| D | Tester UI: photo in → floor/node out (no floor prompt) |
| E | Docs mark implemented; keep link from `localization-megaloc.md` |

Order: **A → B → C → D → E**.

## Env

| Variable | Role |
| --- | --- |
| `PLACEMATCH_ENGINE_URL` / `TOKEN` / `TIMEOUT_S` | Django → engine |
| `S3_*` / `MEDIA_ROOT` | Read index Asset bytes |

No new keys required for the design change. Scale note: embedding once + scoring all refs is fine for demo floor counts; revisit if galleries grow huge.

## How to verify (once built)

1. Build ready indexes on **two** floor revisions (different photos).  
2. Run engine + API with `PLACEMATCH_ENGINE_*`.  
3. `POST /localize/` with a photo from floor A **without** floor params.  
4. Expect `likely_match` (or calibrated `uncertain`) and `target_id` / `node_id` for floor A.

## Open points

- Exact catalog: published-only vs DEBUG drafts.  
- Engine: merged matrix vs N sequential score merges (same math).  
- Thresholds when top-2 are different floors.  
- Cache invalidation when any floor’s index is rebuilt.

## Commits / evidence

- Draft opened on `feature/visitor-localization-match` (2026-10-17).  
- Design update: **global multi-floor search, no floor prompt** (2026-10-17).  
- Implementation commits TBD.
