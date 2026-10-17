# Clean-plan stage (Gemini image models) and parallel floors

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

The text model (Claude Sonnet 5.5 in prod by default; Gemini 4 when `AI_PROVIDER=vertex`) receives a gridded 0–1000
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

## Rooms and hallways from the clean redraw (raster segmentation)

The model-traced tiles missed open circulation on complex floors (the Level B
atrium and hallways never became regions). Clean-redraw floors are therefore
segmented locally from the image (`server/pipelines/raster-rooms.js` and
`raster-walls.js`, option `segmentation: "auto" | "raster" | "model"`; auto uses
raster for sources whose asset provenance starts with "Clean redraw"):

1. **Walls:** dark strokes; hollow double-line walls are filled (also when the
   two lines are up to 18 px apart, with checks that reject stair treads, seat
   rows and glazing); thin lines, door arcs and text are dropped; isolated blobs
   (bold labels, furniture, columns) are removed; sealed doorways with a matching
   door-swing arc are reopened.
2. **Building footprint:** a disk rolled in from the image border marks the
   outside, so entrances and short breaks in the outer wall do not leak.
3. **Spaces:** regions grow over the distance-to-wall field and split only at
   constrictions (doorways); a corridor junction or a bend merges.
4. Regions tile the floor and share exact boundaries; regions too narrow to walk
   are merged away; a region that encloses another (a corridor ring around a
   void) is cut into pieces joined by an "Open circulation join".
5. **Doorways** are where two regions meet across open floor; **walls** are the
   other shared boundaries.
6. **Names** come from the model's label inventory by position. The model only
   names rooms: printed stair names stay rooms, generic descriptions never
   override shape, and unnamed regions become "Hallway N" (long or
   well-connected), "Open lobby N" (large with 3+ doorways) or "Unlabelled room N".
   No model stair/void classification runs on these floors.

The model is still used for the label inventory and to check each doorway gap.
On Level B (Claude Sonnet 5.5, high) this gave 42/43 routable rooms in 49 s with
10 requests (the model-traced run had left the atrium and hallways out).
Each floor's raster stage takes about 3 s.

## Editing regions (the user's decisions)

The editor's **Regions** panel (map authoring screen) lets the user:

- rename any region (default names such as "Unlabelled room 3" are flagged);
- mark or unmark a region as a **stair** (stored as `kind: "lobby"`,
  `use: "stair"`; drawn with tread hatching);
- tick two or more regions that share a boundary and **merge** them into one,
  optionally as a stair (the first region keeps its id; the doorway and wall
  between them are removed; doors to other regions and their evidence move to
  the merged region);
- select regions by ticking them or clicking them on the map; selected regions
  are highlighted.

Every edit goes through the access transaction (`applyAccessDecisions`, ops
`rename-space`, `set-space-use`, `merge-spaces`), so walking paths are rebuilt
and route checks re-run. API: [api.md](api.md) "Region tools".

## Configuration

Same Vertex key and project as the team's prod setup (`apps/pipeline/.env.prod`), whichever `AI_PROVIDER` maps the floors:

```sh
VERTEX_IMAGE_MODEL=gemini-nano-banana-2.1   # default; gemini-3-pro-image for Nano Banana Pro
VERTEX_IMAGE_SIZE=2K                         # 1K, 2K or 4K (Nano Banana 2 Lite: 1K only)
```

The default changed from Nano Banana Pro to Nano Banana 2.1 after the
comparison below. Pro stays selectable for the most faithful redraws.

## Image model comparison (Level B, same crop)

All five Gemini image models were available in the team's Vertex project.
One redraw each of the Sam Ibrahim Level B crop, October 17, 2026. Prices are
third-party list prices per output image, not invoices.

| Model (ID) | Size | Time | Tokens in/out | Approx. price | Result on this floor |
| --- | --- | --- | --- | --- | --- |
| Nano Banana Pro (`gemini-3-pro-image`) | 2K | 38 s | 769 / 1,372 | ~$0.134 | Most faithful; labels and seat counts correct |
| **Nano Banana 2.1** (`gemini-nano-banana-2.1`, default) | 2K | 41 s | 1,329 / 3,289 | ~$0.050 | Clean and faithful geometry, draws door swings; one slip ("35 SEATS" for 36) |
| Nano Banana 2 (`gemini-3.1-flash-image`) | 2K | 29 s | 1,329 / 1,680 | ~$0.07–0.10 | Dropped seat counts and The Cave's seating, misread "THE CASE", duplicated Stair C |
| Nano Banana 2 Lite (`gemini-3.1-flash-lite-image`) | 1K only | 10 s | 1,329 / 1,120 | ~$0.034 | Fast and cheap; wrong stair labels ("STAIR E", duplicate "STAIR C"), lower resolution |
| Nano Banana (`gemini-2.5-flash-image`) | ~1.5K | 16 s | 2,531 / 1,290 | ~$0.039 | Barely cleaned: kept grey fills and colours |

One floor is not a benchmark: compare more floors before settling on a model.


Dev also needs `VERTEX_API_KEY` and `VERTEX_PROJECT` in `.env.dev`
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
  2.1 at about $0.050 per 2K image and Nano Banana Pro at about $0.134; check
  the Vertex pricing page.
- The image model ID is configurable because Google's model names change;
  verify access in your project before a paid run.
