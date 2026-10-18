# Clean plans (removed)

The clean-plan redraw step was **removed on 2026-10-17**. It redrew each floor
with a Vertex AI image model (Nano Banana, `gemini-nano-banana-2.1`) after a
Gemini 4 Argon plan reader had briefed each redraw. It is replaced by
vectorizer.ai vectorization plus a Claude SVG analysis step.

What changed:

- Removed: `server/pipelines/clean-plan.js`, `server/vertex-image.js`,
  `server/plan-brief.js`, the `/api/authoring/clean-plans` endpoints, the
  `imageModel` field of `GET /api/health`, the `--clean` option of
  `server/build-floors.js`, the authoring screen's "Redraw each floor as a clean
  plan first" option, and the `VERTEX_IMAGE_*` / `VERTEX_BRIEF_*` variables.
- Mapping runs directly on the uploaded source image (`POST /api/authoring/plans`,
  then `/api/map-jobs`). Raster segmentation (`segmentation: "raster"`) accepts
  any source image; its grey-corridor detection only triggers on plans with the
  `#D8D8D8` circulation fill.
- Saved buildings with clean-redraw assets (`asset-clean-…`, provenance
  `Clean redraw by …`) still load, and `segmentation: "auto"` still segments
  those floors locally.
- The main Vertex AI text provider (`server/vertex.js`, `AI_PROVIDER=vertex`,
  `VERTEX_MODEL=gemini-4-argon`) is unchanged.
