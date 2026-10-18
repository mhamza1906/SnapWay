# Map image optimize (GPT Image 2.5)

Updated October 18, 2026. Branch: `feature/frontend-iteration`.
Personal history: ignored `local/ACTIONS.md`.

## Scope

After a New Map image upload, the product runs **GPT Image 2.5**
(`gpt-image-2.5-sunburst`) before any graph tools. The user lands on
`/map-optimize?target=<uuid>`: **Regenerate** (current image as template) and
**Vectorize (demo)** only. No waypoint/edge tools on this page.

Architecture reference:
[Indoor_Navigation_Architecture_and_Dependencies_EN.md](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md).
Raster prompt evidence:
[audits/assets/2026-10-17-gpt-fullchain/raster-prompt.txt](audits/assets/2026-10-17-gpt-fullchain/raster-prompt.txt).

## Flow

```text
Authoring upload (PNG/JPEG/WebP)
  -> POST /api/maps/workspace/targets/<id>/optimize/upload/
  -> Image 2.5 edit -> Asset(standardized) becomes revision SoT
  -> user upload Asset may remain as an unused append-only orphan
  -> /map-optimize review (stage=image_optimize)
       |-- Regenerate (optional prompt row) -> template = current SoT
       `-- Vectorize (header) -> vectorize-demo/ (IA floor-4 prebuilt SVG)
```

The optimized raster is the **source of truth** for further regenerates. Raw
uploads are not used for display or regenerate once Image 2.5 succeeds. Asset
rows are append-only on PostgreSQL, so the upload row may remain unused until a
retention purge.

My maps sort/display preference: **vectorized SVG** first, then **Image 2.5**
optimize, then other drafts. Cards in `image_optimize` / `vectorized_demo` use
`edit_path=/map-optimize`. Review UI: Vectorize beside My maps; Regenerate with a
dedicated prompt row; no yellow status banner. Layout uses the same full-bleed
28px padding as Vectorize comparison (no narrow max-width card). Long waits use
the global semi-transparent spinner overlay (`UiService`).

## Demo vectorize (not Vectorizer.AI)

`VECTORIZER_LIVE_ENABLED` stays false; credentials remain empty. The demo route
never calls Vectorizer.AI. It attaches a fixed SVG:

1. Prefer `local/prebuilt/ia-4/floor.svg` when present
2. Else the committed Figma export
   [figma-vector.svg](audits/assets/2026-10-17-figma-vectorization/figma-vector.svg)
   labeled as floor `ia-4` until real floor-4 assets are prepared

Response includes the English disclosure that this is a prebuilt demo, not a live
API generation. Stage becomes `vectorized_demo`. Graph tools still do not open.

## Environment

Uses existing contract keys (no schema bump):

| Key | Role |
| --- | --- |
| `OPENAI_API_KEY` | Required for live optimize/regenerate |
| `OPENAI_IMAGE_MODEL` | Default `gpt-image-2.5-sunburst` |

Obtain private values through the external channel into ignored `local/.env`.
Validate with `python scripts/env_contract.py check` (never print secrets).

## Floor 2 live smoke (this checkout)

Deleted prior Floor 2 draft `a3b602a8-80f4-4a59-aa4a-28b2a8b91e5f`.
Retest coordinates: **latitude 43.788195**, **longitude -79.190593**.

One live Image 2.5 call on
`local/test-source/ee8fe721-0a58-429c-9719-ecb6b4addd83.jpg`:

| Field | Value |
| --- | --- |
| target_id | `0dab38f0-314f-4431-bfaa-1c0f4bdf718f` |
| revision_id | `e52c149c-cbbf-455a-9993-b19066380f8c` |
| stage | `image_optimize` (stopped; no vectorize) |
| local preview | ignored `local/test-results/image-optimize-floor2-2026-10-18/optimized-floor2.png` |

Review URL (reuse existing `4200` / `8000`):

`http://127.0.0.1:4200/map-optimize?target=0dab38f0-314f-4431-bfaa-1c0f4bdf718f`

## HTTP

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/maps/workspace/targets/<id>/optimize/` | Status + signed URLs |
| POST | `.../optimize/upload/` | Multipart `file` → Image 2.5 |
| POST | `.../optimize/regenerate/` | Optional JSON `prompt` |
| POST | `.../vectorize-demo/` | Fixed floor-4 SVG stub |

Angular proxy `/api/**` timeout is 700s for long image edits.

## Tests

`uv run pytest apps/api/tests/test_image_optimize.py` (OpenAI mocked).

## Changed files

| Path | Role |
| --- | --- |
| [apps/api/maps/services/image_optimize.py](../apps/api/maps/services/image_optimize.py) | Image 2.5 upload/regenerate |
| [apps/api/maps/services/vectorize_demo.py](../apps/api/maps/services/vectorize_demo.py) | Floor-4 demo SVG stub |
| [apps/api/maps/views_optimize.py](../apps/api/maps/views_optimize.py) | HTTP views |
| [apps/web/.../map-optimize/](../apps/web/src/app/features/map-optimize/) | Review UI |
| [apps/web/.../authoring/](../apps/web/src/app/features/authoring/) | Upload → optimize |
| [docs/map-image-optimize.md](map-image-optimize.md) | This feature doc |

## Non-goals

- Live Vectorizer.AI
- Opening the graph editor after optimize
- Automatic publication of optimized bitmaps
