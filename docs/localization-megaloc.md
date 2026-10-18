# Localization pipeline (MegaLoc) — canonical product path

**This is the project’s absolute visitor photo localization architecture.**  
Developer reference photos → MegaLoc index → visitor JPEG → global cosine match.  
Do not implement Gemini/LLM scene-text localization or floor-prompted search for this product loop.

Personal history: ignored `local/ACTIONS.md`.  
Visitor half: [localization-visitor-match.md](localization-visitor-match.md).  
Engine benches: [visual-place-matching.md](visual-place-matching.md), [place-match-production.md](place-match-production.md).  
Related: [mobile-ios.md](mobile-ios.md), [map-node-media.md](map-node-media.md).

Offline case study: [Sam Ibrahim Level 1 video test](sam-ibrahim-video-localization.md)
— local photo descriptors, independent checks and diagnostic tracking video;
exact-point tracking remains unverified and this does not activate a phone localizer.

## Supersedes (read this instead of initial plans)

Hash-locked files under [`docs/initial/`](initial/README.md) still describe an older Gemini /
NLP / floor-scoped localization design. Those passages are **historical evidence only**.
Implement and extend from this document and [localization-visitor-match.md](localization-visitor-match.md).

| Older claim (do not follow for product localize) | Canonical replacement |
| --- | --- |
| Gemini Argon / Flash as visitor photograph matcher | MegaLoc image embeddings + cosine |
| NLP `gemini-embedding-2` for place match | Text destination search only; not photo match |
| Floor prompt or floor-first search before match | No floor input; `floor_id` / `building_id` from winning `target_id` |
| NaviGraph-style scene-text → embedding → node | Out of scope for visitor place match |
| Open-source “Gemini-first localization experiment” | MegaLoc catalog path above |

Also canonical in: [pipeline/README.md](pipeline/README.md),
[pipeline/navigation-ai-workflow-plan.md](pipeline/navigation-ai-workflow-plan.md),
[map-authoring-pipeline.md](map-authoring-pipeline.md), [mobile-ios.md](mobile-ios.md),
[mobile-ios-api.md](mobile-ios-api.md), [visual-place-matching.md](visual-place-matching.md),
[place-match-production.md](place-match-production.md),
[audits/2026-10-17-main-sync-gaps.md](audits/2026-10-17-main-sync-gaps.md), root [README.md](../README.md).

## End-to-end flow

```text
Developer
  ReferencePhoto on graph nodes (R2 / MEDIA_ROOT)
    → POST /api/maps/revisions/<id>/index/  (or manage.py build_reference_index)
    → place-match MegaLoc embed (subprocess)
    → zip(vectors.npy, index.txt, meta.json, locations.json)
    → Asset(kind=index) + RevisionArtifact(kind=index, state=ready)

Visitor (no floor prompt)
  JPEG + meta
    → POST /api/navigation/localize/          (default mode=global)
    → Django syncs ready index zips → engine /v1/catalog/sync
    → engine MegaLoc embed once + cosine over union catalog (/v1/match-global)
    → decision + node_id + target_id + floor_id + building_id (floor is output enrichment)
```

## Decision

| Topic | Choice |
| --- | --- |
| Matcher | MegaLoc image embeddings + L2 cosine top-k |
| Floor | **No visitor floor prompt**; search all ready floor indexes; floor/building returned from winning `target_id` |
| Gemini / LLM scene-text for place match | **Out of scope** for localization |
| Vertex / geometric verify | Optional later (legacy `mode=legacy` / engine flags); not required on global path |
| NLP `gemini-embedding-2` | Destination **text** search only — not visitor photo matching |

## Developer embed + store (done)

| Piece | Location |
| --- | --- |
| Service | [`apps/api/maps/services/reference_index.py`](../apps/api/maps/services/reference_index.py) |
| Media | [`apps/api/maps/services/media_store.py`](../apps/api/maps/services/media_store.py) |
| REST | `GET\|POST /api/maps/revisions/<revision_id>/index/` |
| Command | `manage.py build_reference_index <revision_id> --email …` |
| MegaLoc helper | [`apps/place-match/placematch/ops/revision_embed.py`](../apps/place-match/placematch/ops/revision_embed.py) |
| Tests | [`apps/api/tests/test_reference_index.py`](../apps/api/tests/test_reference_index.py) |

**Eligible photos:** `node` set, `status != rejected`. Skip rebuild when `input_content_hash` unchanged.

## Visitor match (backend done)

See [localization-visitor-match.md](localization-visitor-match.md): catalog eligibility, `/v1/match-global`, Django enrichment, tests, curl E2E.

## Still later (product, not architecture change)

- Frontend UI for localize
- `LocalizationResult` / Capture persistence (needs retention approval)
- Auto-rebuild index on photo change; publish gates; Celery
- Optional Vertex/verify on global path

## Env

No new keys. `S3_*` / `MEDIA_ROOT` for photo + index bytes.  
`PLACEMATCH_ENGINE_URL` / `TOKEN` / `TIMEOUT_S` for visitor localize.  
Live MegaLoc uses the place-match venv (`uv` under `apps/place-match`).  
Calibrated thresholds: ignored `apps/place-match/data/calibration/current.json` (without it, outcomes stay `uncertain`).

## Commits / evidence

- Engine + benches: [visual-place-matching.md](visual-place-matching.md), `apps/place-match/REPORT-v2.md`
- Embed+store: `feature/reference-embedding-index`
- Global visitor match + live E2E: `feature/visitor-localization-match`
