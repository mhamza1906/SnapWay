# Localization pipeline (MegaLoc only)

Shared plan for visitor photo → waypoint matching. Personal history: ignored
`local/ACTIONS.md`. Related: [visual-place-matching.md](visual-place-matching.md),
[place-match-production.md](place-match-production.md), [mobile-ios.md](mobile-ios.md),
[map-node-media.md](map-node-media.md).

Branch: `feature/reference-embedding-index` (developer embed + store).

## Decision

- **Matcher:** MegaLoc image embeddings + cosine top-k (existing defaults).
- **Not in scope:** Gemini / LLM semantic scene-text extraction for localization.
- **Optional later:** Vertex second opinion / geometric verification in place-match.

## Developer embed + store (this slice — done)

Contributor attaches node `ReferencePhoto`s (existing graph API). Rebuild embeds them
with MegaLoc and stores one revision-level index artifact.

```text
ReferencePhotos (R2/local media)
  → POST /api/maps/revisions/<id>/index/  (or manage.py build_reference_index)
  → place-match MegaLoc (subprocess: placematch.ops.revision_embed)
  → zip(vectors.npy, index.txt, meta.json, locations.json)
  → Asset(kind=index) + RevisionArtifact(kind=index, state=ready)
```

| Piece | Location |
| --- | --- |
| Service | [`apps/api/maps/services/reference_index.py`](../apps/api/maps/services/reference_index.py) |
| `read_bytes` | [`apps/api/maps/services/media_store.py`](../apps/api/maps/services/media_store.py) |
| REST | `GET|POST /api/maps/revisions/<revision_id>/index/` |
| Command | `manage.py build_reference_index <revision_id> --email …` |
| MegaLoc CLI helper | [`apps/place-match/placematch/ops/revision_embed.py`](../apps/place-match/placematch/ops/revision_embed.py) |
| Tests | [`apps/api/tests/test_reference_index.py`](../apps/api/tests/test_reference_index.py) |

**Eligible photos:** `node` set, `status != rejected`. Skip rebuild when
`input_content_hash` unchanged. Real MegaLoc needs `uv` + weights under
`apps/place-match`; API tests mock the subprocess.

```sh
# after attaching photos on a draft revision
cd apps/api
uv run python manage.py build_reference_index <revision_uuid> --email you@example.com
# or POST /api/maps/revisions/<revision_uuid>/index/ while authenticated as a member
```

## What Arjun already built (engine)

| Piece | Location | Status |
| --- | --- | --- |
| Embed / retrieve / decide | `apps/place-match/` | Done |
| `build-references` / mobile API | place-match | Done |
| Django `/api/navigation/localize/` forwarder | navigation | Done (no frame retention) |

## Still later

- Visitor match against this index — **backend done**:
  [localization-visitor-match.md](localization-visitor-match.md)
  (`feature/visitor-localization-match`); frontend UI is teammates’ work
- `LocalizationResult` / Capture persistence
- Multi-angle authoring UX / full visitor navigation loop
- Auto-build on photo upload; Celery; publish gates

## Env

No new keys. Uses existing `S3_*` / local `MEDIA_ROOT` for photo + index bytes.
Live MegaLoc subprocess uses the place-match venv (`uv` from `apps/place-match`).
`PLACEMATCH_ENGINE_*` remains for visitor localize only (not required for embed+store).

## Commits / evidence

- Engine + benches: [visual-place-matching.md](visual-place-matching.md),
  `apps/place-match/REPORT-v2.md`.
- Developer map → MegaLoc index: this document / `feature/reference-embedding-index`.
