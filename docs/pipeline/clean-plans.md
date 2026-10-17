# Clean-plan stage (Nano Banana Pro) and parallel floors

**Status:** implemented on `feature/map-authoring-pipeline` (October 17, 2026) by
Arjun's decision, ahead of team agreement. The [phase audit](../audits/2026-10-17-map-authoring-pipeline.md)
and [redesign proposal](redesign-proposal.md) name GPT Image 2.5 for this step;
this branch uses Gemini's image model on the same Vertex AI project instead, so
no new provider account is needed. Revisit with the team before merging.

## What it does

Before mapping, each floor of an upload is redrawn as a clean, flat floor plan
by the image model. The clean image becomes the floor's mapping source; the
original upload and the floor's crop are kept as assets for comparison.

| Plan type (user chooses) | Behaviour |
| --- | --- |
| **Floor plan** | One floor. The page is redrawn once. A multi-page PDF is refused (use Building plan). |
| **Building plan** | The user must enter how many floors it shows (2–20) and may name them. A PDF with exactly that many pages uses one page per floor. A single image is split by a planner (below). |

### Floor splitter (building plan, one image)

The text model (Gemini 4 in prod, Claude in dev) receives a gridded 0–1000
overview of the original and three tools:

- `crop_region(label, level, x0, y0, x1, y1)`: crops one floor from the
  original; the crop is shown back to the model.
- `generate_clean_floor(crop_id)`: redraws a crop with the image model; calls
  in the same turn **run in parallel**; a small preview is shown back.
- `finish(floors[])`: must list exactly the requested number of floors, each
  with its own crop and that crop's redraw.

Limits: 8 planning turns (5-minute timeout, one retry), 3×N crops and 2×N
redraws per building. The finished split (crop boxes) is cached by upload,
floor count and names, so a re-run reuses the same crops and redraws.

Then all floors run through the existing pipeline **as separate pipelines at the
same time** (`floorConcurrency`, default 6), each with its own request budget.

## Configuration

Same Vertex key and project as the team's prod setup (`apps/pipeline/.env.prod`):

```sh
VERTEX_IMAGE_MODEL=gemini-3-pro-image   # Nano Banana Pro
VERTEX_IMAGE_SIZE=2K                     # 1K, 2K or 4K
```

Dev (Claude) also needs `VERTEX_API_KEY` and `VERTEX_PROJECT` in `.env.dev`
for this stage. `GET /api/health` reports `imageModel {model, size, configured}`.

## Interfaces

- Angular `/authoring`: choose **Floor plan** or **Building plan**; for a
  building, the number of floors is required before upload. "Redraw each floor
  as a clean plan first" is on by default. The clean floors are shown beside
  their originals before "Build all N floors".
- `POST /api/authoring/clean-plans` (multipart: `plan`, `mode`=`floor|building`,
  `floors`, optional `labels` comma-separated, `name`) → `202 {id}`.
  `GET /api/authoring/clean-plans/:id` → `{status, progress, result?}`; the
  result holds the building, summary, per-floor previews, usage and timing.
  `POST /api/authoring/clean-plans/:id/cancel`. One clean job at a time.
- CLI: `node server/build-floors.js <out> <plan> --clean=floor|building
  [--floors=N] [--labels="Level B,Level 1,..."]` redraws, builds and maps all
  floors in parallel, writing `clean/<floor>-original.png`, `clean/<floor>-clean.png`
  and `clean-report.json` besides the usual outputs.

## First live trial: Sam Ibrahim board photo (6 floors)

Input: one phone photo of a wall board (1960×1889 JPEG) with Levels B–5.

| Stage | Result |
| --- | --- |
| Floor split (Gemini 4, high) | 3 planning turns, ~31k tokens; all 6 floors cropped correctly in one turn |
| Redraws (Nano Banana Pro, 2K) | 6 images **in parallel in ~30 s** (26–31 s each), ~2.2k tokens each |
| Whole clean stage | 147 s |

The redraws remove fire symbols, leader lines, colour fills and glare while
keeping walls, rooms, stairs and seating in place. They are not faithful
everywhere: some text was invented or misspelled ("DARK MATTER" became
"THINK MASTER", "INNOVVATION", a new "196 CAP" label), Level 4 lost its diagonal
escalator and Level 5 lost cross marks on one void. Always compare each redraw
with its original before mapping.

Mapping results are in [operations.md](operations.md#clean-plan-trial).

## Known gaps

- Generated images can move walls, drop doors or invent labels; there is no
  automatic geometric registration of a redraw against its original yet.
- Prices are not measured from invoices. Third-party listings put Nano Banana
  Pro at about $0.134 per 1K/2K image; check the Vertex pricing page.
- The image model ID is configurable because Google's model names change;
  verify access in your project before a paid run.
