# Pipeline stages

This page describes how the map-authoring pipeline works internally, stage by
stage. It is written against the code in `apps/pipeline/`. All paths below are
relative to that directory.

Related pages:

- [README.md](README.md): overview and how the service fits SnapWay.
- [environments.md](environments.md): development and production setup.
- [api.md](api.md): HTTP routes and the CLI.
- [operations.md](operations.md): limits, cost, caching, tests, trial results
  and troubleshooting.

The orchestrator is `runSmartMap` in `server/pipelines/smart-map.js`. It works
on a clone of the building, so a running job never writes the saved project.
Its output is a set of proposals, one per floor source, plus a review queue.

## Flow

```
 upload (PDF / PNG / JPEG)
   |
 [1] preparePlan ............ one normalized PNG per page; the "source frame"
   |
 [L] extractLocalVectors .... PDF line segments and text labels (no model call)
   |
 [3] provider.inventory ..... labels + rough footprints      (1 model call)
   |        \__ [2] fitVisionFrame: <= 2048 px edge, <= 3.4 MP, rescale back
 [4] footprintTiles ......... plan, widen, pre-split, rank; keep maxDetailTiles
   |
 [5] extractDetail x N ...... vector-rendered crop -> provider.extract
   |        \__ on max_tokens: re-read in halves (up to 4 pieces)
 [6] consolidateCoverage .... after every tile: snap, dedupe, corridors, joins
   |
 [7] targeted repairs ....... up to maxRepairTiles re-reads at zoom 7
   |
 [8] verifyRegionSemantics .. stairs / voids / other levels / unclear
   |
 [9] verifyOpeningQueue ..... doors and joins, original + locator crops
   |
 [10] applyAccessDecisions .. replace-source: validate, walls, graph, routes
   |
 [11] placeAssumedDoorways .. fallback (CLI default; editor button)
   |
 [12] developer controls .... room / not a room / add / move / confirm / remove
   |
 [13] buildGraph + routeBuilding
```

Steps 1 to 10 run inside `runSmartMap`. Step 11 runs afterwards, in
`server/build-from-plan.js` or from the editor. Step 13 runs inside every
access transaction and again whenever a route is requested.

### Two modes

`runSmartMap` handles each `floor.sources[]` entry in one of two modes:

- **Source mode** (`rebuild: true`, or the source owns no regions yet). This
  runs stages 3 to 10 below.
- **Access mode** (the source already owns regions and `rebuild` is false).
  Geometry is kept. Openings that are not already `verified` or `legacy` are
  re-checked with `verifyOpeningQueue`, as long as neither side is
  non-walkable or held for classification. If no openings are pending, up to
  `maxAccessRegions` queued regions go to the tool-using doorway agent
  (`investigateRegion` in `server/pipelines/doorways.js`; 4 turns, no retries,
  at most 300 s per region). An agent opening is applied only when it passed
  validation, passed the route check and was confirmed by a separate second
  look. When openings are pending, the doorway agent does not run in that
  pass. Unresolved regions wait for the next run.

**Why:** a re-run should not pay to re-extract geometry that a developer may
already have edited.

## 1. Source preparation

`preparePlan` in `server/pipelines/preparation.js`:

- **Originals are kept.** The original upload is stored byte-for-byte as an
  asset, addressed by its SHA-256 hash.
- **PDF pages are rendered.** At most 20 pages per import. Each page is
  rendered with pdf.js so that its long edge is 2400 px.
- **Rasters are taken as they are.** PNG and JPEG are accepted, up to a
  40 MP input limit.
- **Every image is normalized.** It passes through `sharp().rotate()`, which
  applies EXIF orientation, so phone photos come out upright. It is then
  resized to fit inside 2400×2400 (never enlarged) and re-encoded as PNG.
- **One source per page.** Each source starts with an identity `transform`,
  `alignment: "draft"` and an `unassigned-…` section.

The **source frame** is the pixel grid of that normalized PNG. All model
geometry is converted into it before anything else happens. Floor coordinates
come from `source.transform`, a similarity transform. `applyTransform`,
`invertTransform`, `transformGeometry` and `sourceGeometry` in
`shared/building/preparation.js` convert between the two frames.
`transformGeometry` also prefixes IDs with `sourceId:`, so several sources can
share one floor.

Merging a proposal (`mergeProposal`) requires `source.alignment ===
"reviewed"`. The CLI (`build-from-plan.js`) sets this itself for a
single-source plan with an identity transform. The source notes say that no
human alignment review is claimed.

**PDF rotation.** `pdfSourceMapping` in `server/pipelines/source-crops.js`
recovers the page rotation and scale that reproduce the normalized image. It
skips any rotation whose aspect ratio differs by more than 1%. For each
remaining rotation (0, 90, 180 or 270), it renders a 400 px greyscale
thumbnail and compares it with the normalized image. It accepts the best match
only if the mean absolute difference is below 12. Otherwise crops fall back to
the raster.

**Why:** later crops can then be re-rendered from the original vectors in
exactly the source frame. Evidence stays sharp at high zoom, and no reviewer
has to trust a downscaled bitmap.

**Local vectors** (`extractLocalVectors`, `server/pipelines/local-vectors.js`):

- **Segments.** Straight line segments come from the PDF operator list,
  de-duplicated at half-pixel precision.
- **Curves.** Curves are counted but never turned into segments. Door arcs and
  glyph outlines must not become walls.
- **Unsupported paths.** An unsupported path command stops that path. The
  code never guesses.
- **Labels.** Text items are kept as label positions when the PDF has real
  text.

These are hints only. The notes state that linework is "evidence for
alignment, not proof of a wall or doorway".

## 2. Vision frame

`server/pipelines/vision-frame.js` defines `VISION_MAX_EDGE = 2048` and
`VISION_MAX_PIXELS = 3_400_000`. `fitVisionFrame` downscales an image with
Lanczos so that it fits both limits. It returns per-axis factors `kx` and `ky`
(sent pixels = source pixels × k).

**Measured reason.** The API silently downscales large images. The model then
answers in a smaller frame than the prompt states. With `claude-sonnet-5-5`:

| Long edge sent | Coordinates returned at |
| --- | --- |
| 2400 px | about 0.909× |
| 2292 px | about 0.955× |
| 2097 px | exact |

These results fit an effective long edge of about 2180 px, not the documented
2576 px. The limit is set to 2048 px to leave a margin. After the fix, the
inventory frame ratio was 1.000. An earlier fix capped pages at 3.4 MP and
2576 px. It cured the 0.909× scale but not the 0.955× scale.

**The prompt states the sent frame.** `provider.inventory` and
`provider.extract` (`server/provider.js`) describe the image by its sent
`width` × `height`. Results are mapped back to the source frame:
`scaleGeometry(parsed, 1/kx, 1/ky)` for extraction, and `p / k` for inventory
positions and footprints.

**Crops stay inside the frame.** `renderSourceCrop` clamps its own scale so
the crop's long edge is at most 2048 px.

**The transport refuses oversized images.**

- `imageBlock` in `server/anthropic.js` throws if a PNG is over 2048 px on its
  long edge or over 3.75 MP.
- `inlineImage` in `server/vertex.js` checks only the long edge.

Both fail loudly, so the API never gets a chance to rescale an image silently.

## 3. Label and footprint inventory

`provider.inventory` makes one call per source on the full page, fitted to the
vision frame. The settings are reasoning effort "low", 12,000 output tokens and
a strict `InventorySchema`. The call returns:

- `items[]`: `label`, `kind` (room, corridor, stair, elevator, restroom or
  storage) and a `position`.
- `footprints[]`: simple outer-wall polygons. These exclude white space, title
  blocks and site insets.
- `notes[]`: for anything unreadable.

Room polygons are explicitly not requested in this pass. A refusal, an
incomplete response or a schema failure throws. Any cached response for that
call is deleted (`invalidateResponse`).

**Why:** an independent label list is the yardstick for coverage. A missing
room shows up as an inventory item without a region, instead of silently
disappearing.

## 4. Detail tiles

`footprintTiles(source, inventory, vectors)` in `smart-map.js`:

1. **Footprint areas.** It takes the bounding box of each footprint, or the
   whole page if there is none.
2. **Widen to nearby labels.** Any inventory label within 80 px of an area
   grows that area to include it, plus 20 px. Leader labels and edge corridors
   then stay on a tile. The area is then padded by 10 px on each side.
3. **Plan tiles.** `planTiles` (`server/pipelines/coverage.js`) covers each
   area with 600 px tiles at 25% overlap, so the step is 450 px.
4. **Pre-split dense tiles.** A tile with more than 14 inventory labels
   (`DENSE_LABELS`) and a long side of at least 300 px is split, recursively.
   `splitTile` halves a tile along its longer side: the first piece covers
   60%, the second starts at 40%, so the two overlap by 20%. **Why:** a dense
   tile would need more output than one response allows. Splitting first is
   cheaper than paying for a reply that gets cut off.
5. **De-duplicate.** Identical tiles are dropped.
6. **Rank greedily.** Each round picks the tile with the most inventory labels
   not yet covered. A label counts as covered once it lies inside a chosen
   tile, more than 12% in from every edge. The score is newly covered labels
   × 1000 + the number of vector segments in the tile. Ties go to the top-left
   tile. **Why:** clamped near-duplicate tiles at a page edge used to outrank
   distinct areas. Linework only breaks ties; it never establishes a room.

Only the first `maxDetailTiles` tiles run (default 8). The rest are queued as
"N detail tiles remain; resume with a larger detail allowance".

## 5. Detail extraction

`extractDetail(rect, refinement, target)` inside `runSmartMap`:

**The crop.** `sourceCrop` renders the tile with `renderSourceCrop`, from PDF
vectors when a mapping exists. It uses zoom 2.5 for a detail tile, zoom 7 for a
repair, and at most 2.6 MP.

**The prompt.** `provider.extract(image, { deriveWalls: true, instructions })`
sends:

- `tileInstructions`: map every enclosed space, keep letter suffixes, mark
  clipped geometry, and so on. Stair landings are mapped as `lobby`.
- Up to 180 of the longest PDF segments that lie fully inside the crop, in the
  crop's coordinates. The prompt says these may include annotation or glyph
  lines.
- Independent label readings that fall inside the crop: inventory items plus
  PDF text.
- For a repair, a note naming the label that an earlier pass missed.

**Walls are derived locally.** With `deriveWalls`, the schema omits `walls`
and `max_output_tokens` drops from 24,000 to 16,000. The prompt says walls are
derived locally from region boundaries and verified openings. Walls are later
traced from region edges, with gaps cut at doors (`traceBoundaryWalls`).
`cacheAlternatives: [legacyBody]` lets an older cached response for the
with-walls request be reused. **Why:** walls were the largest share of output,
and they can be computed exactly from shared boundaries.

**`max_tokens` handling.** Every adapter maps a cut-off response to
`error.code = "max_tokens"`:

- Anthropic: the `stop_reason`.
- OpenAI: `incomplete_details`.
- Vertex: `finishReason: "MAX_TOKENS"`.

The usage of the incomplete response is still counted against the budget.
When a tile fails this way, the detail worker keeps the output limit and
re-reads the tile as the two halves from `splitTile`. If a half also hits
`max_tokens`, has a long side of at least 200 px, and the piece list is still
under 4 entries, that half is split once more. Otherwise the failure is
recorded in `proposal.tileFailures`. A `PipelineLimit` error (budget,
deadline or cancel) always stops the job. Any other failure is recorded and
the job continues.

> As written, only the first half that fails can be split again: after one
> re-split the list already holds 4 entries. A second failing half is recorded
> as a failure.

Tiles run in `concurrency` workers (default 2). After each tile, the source is
reconciled again (stage 6), so a stopped job still has a usable partial
proposal.

## 6. Reconciliation

`consolidateCoverage(source, sections, { inventory, footprints })` in
`shared/building/coverage.js` runs over every completed section.

**Project and clip.** `tileGeometry` maps tile pixels back into the source
frame. Each candidate polygon is intersected with the union of the footprints,
and the largest piece is kept.

**Score.** A candidate gets +100 when it lies more than 2 px from an inner crop
edge, so it is not clipped. It also gets confidence × 10, plus 25 for a repair
pass.

**Snap.** On each axis, coordinates within 2.5 px of each other are grouped.
Each group snaps to the nearest existing base coordinate within 3 px, or else
to the group median rounded to 0.5 px. If snapping shrinks a polygon below 25%
of its area, the unsnapped polygon is kept. **Why:** repeated measurements of
one wall from overlapping tiles should land on one shared centreline.

**Rooms.** Candidates other than corridors are processed by score.

- A candidate that shares a room number (`roomLabels`) with a known room, or
  has the same label and overlaps it by more than 65% IoU, maps to that room.
- Otherwise the parts already claimed by other rooms are subtracted. If less
  than 25% of the candidate is left, it is recorded as an `overlap` diagnostic
  and not added.
- Unlabelled candidates with a score below 100 are ignored.

**Nested duplicates.** Polygons cannot have holes. When the subtraction leaves
a hole, the candidate fully encloses one or more existing rooms. It is merged
only if all of these hold:

- exactly one room is enclosed;
- that room has the same `kind`;
- the candidate adds no room number the enclosed room lacks, and none that
  belongs to another room.

In that case the enclosed room takes the outer outline under its existing ID
and label, and a `nested-duplicate` diagnostic is recorded. An example is stair
treads drawn inside the stair enclosure. Anything else, such as a numbered
room inside a larger one, is kept out as an `overlap` diagnostic for review.
**Why:** on floor 3 of the 028C2 trial, an enclosing stair polygon overlapped
its treads and blocked the whole floor. Merging numbered rooms would hide real
destinations.

**Corridor decomposition.** All corridor candidates are unioned, and room
footprints are subtracted, so a large corridor proposal cannot paint over
offices. A result with holes is cut into vertical strips at every distinct x
coordinate, because a polygon cannot carry holes. Each valid piece becomes a
`coverage-corridor-N`.

**Analytical joins.** Corridor pieces that share a boundary at least 2 px long
get a `coverage-open-i-j` "Open circulation join". It is a seam inside one
circulation area, not an invented door. Stage 9 still has to verify it.

**Doors.** Raw door observations are resolved to the reconciled rooms, using
the ID map, room numbers or corridor containment. A crop-edge door with only
one side is matched to a single adjacent region within 3 px. Each door is then
snapped onto the shared boundary: half-width at most 12 px, clamped inside the
boundary. A door that does not meet both boundaries is recorded as a
`door-boundary` diagnostic. `canonicalizeDoorways` drops collinear duplicates.
It prefers base doors, then real doors over joins, then higher confidence.

**Finishing.**

- A region without any door gets `access: "unknown"`.
- Walls come from `traceBoundaryWalls`.
- An inventory label can rename an "Unlabelled" region that contains it.
- `coverage.items` lists every expected label with its `spaceId`, or `null`
  when no region was found.

After all tiles, `stabilizeGeometry` reuses the IDs of existing regions and
doors that match uniquely, by label and by door midpoint. Connector and photo
references then survive a re-run.

## 7. Targeted repairs

Up to `maxRepairTiles` (default 2) extra reads, one label each. The loop picks
the next `coverage.items` entry that meets all of these:

- not `excluded`;
- has no `spaceId`;
- `kind` is not `corridor`;
- not attempted already in this run.

Rooms come before stairs and elevators.

- **The crop.** The bounding box of the region containing the label, or a
  120×120 px box around it, plus 20 px. It is rendered at zoom 7 with the
  "missed or misread" note.
- **The result.** It enters reconciliation as a refinement section, with +25
  score when it is not clipped.

**Why:** corridor labels are usually carried by unlabelled corridor pieces, not
by missing geometry. Spending repairs on them, as happened with "2003" on
floor 2 of 028C2, wasted calls.

After repairs, the proposal queue receives: tile failures, geometry errors
(`geometryIssues`) and inventory labels with no mapped region.

## 8. Region semantics

`semanticCandidates` in `server/pipelines/region-semantics.js` picks regions
that match `/open to below|void|shaft|chase|lower|stair/`. A region matches if
any of these hold:

- its label matches;
- an inventory item mapped to it matches;
- it contains a `stair` inventory item;
- its room number is cited in an extraction issue that matches.

`verifyRegionSemantics` checks them in batches of 8, up to
`maxSemanticBatches` (default 4, so 32 regions):

- **Crops.** Each region gets two crops: the bounding box plus 15 px at zoom 4
  (at most 1 MP) unmarked, then the same view with a dashed magenta polygon
  outline. The model is told to judge the original.

Each region gets exactly one role. Roles map to changes as follows:

| Role | Change when supported |
| --- | --- |
| `void`, `other-level`, `stair-flight` | `access: "nonwalkable"` |
| `landing` | `kind: "lobby"` |
| `circulation` | `kind: "corridor"` |
| `room` | none |
| `unclear`, or a missing or duplicate answer | none; verdict `uncertain` |

A clear role is recorded with verdict `supported` and confidence 0.85. An
`unclear` role is queued. During the source apply (stage 10), it becomes a
`proposed` classification record with verdict `uncertain`.
`regionNeedsSemanticReview` then treats the region as **held**: doors into it
are not graph nodes (`doorNodeProblem`). The prompt forbids inventing
inter-floor connections and connecting separate inset drawings.

Regions beyond the allowance are queued as "Region classification allowance
reached".

## 9. Opening verification

`verifyOpeningQueue` puts every proposal door through `verifyDoorBatch`.

**Crops.**

- **Area.** The door's bounding box plus 22 px.
- **Rendering.** Zoom 9, at most 0.6 MP, from the original PDF when mapped.
- **Two images.** The unmarked **original**, then a **locator** copy with the
  segment drawn in magenta. The prompt says to judge the original, not the
  overlay.

**Batches.** Up to 8 openings per call. The first batches hold real door
candidates, and analytical joins follow in their own batches. A batch never
mixes the two. In total there are at most `maxDoorBatches` batches (default
50), with doors filling the allowance first. Batches run in `concurrency`
workers.

- **Doors** are asked what the drawing shows: door, double-door,
  open-passage, wall, glazing, annotation or unclear. A label, adjacency or
  routing benefit "is never evidence".
- **Joins** get `JOIN_PROMPT`, a seam question. Answer "open-passage" only if
  no wall, glazing or door leaf is drawn along the segment; "wall" or
  "glazing" if one is drawn. **Why:** in the 028C2 trial, joins asked the door
  question were judged as doors, then failed the 26 px door width.

**Mapping the answer to a type.**

- One linked space: `exterior-door`.
- A join not seen as a door: `decomposition-join`.
- Otherwise `double-door` and `open-passage` keep their names, and anything
  else becomes `door`.

**Verdict.** `supported` requires the observation to be door, double-door or
open-passage, **and** `validateOpening` to pass locally against the geometry
without the opening itself. `unclear` gives `uncertain`. Anything else gives
`not-supported`. Every unsupported opening is queued.

**Cache.** Each answer is cached per opening under
`<cacheDir>/opening-checks/<openingCheckKey>.json`. The key covers:

- the source hash and the original-asset hash;
- the transform;
- the segment, rounded to 0.001 px;
- the provider, model and effort;
- a join version, for joins only.

A re-run, or a batch that differs from an earlier one, therefore pays only for
openings it has not seen. If an answer is missing or duplicated, the shared
response cache entry is deleted. Answers already saved stay.

## 10. The access transaction

All geometry and access changes go through `applyAccessDecisions(building,
floorId, decisions, { reviewer, reviewStatus, notes, reason })` in
`shared/building/access.js`. A `reviewer` is required.

**Source proposal (`op: "replace-source"`, alone in its transaction).**
`runSmartMap` applies this to its draft only when all of these hold:

- no geometry errors;
- no tile failures;
- every sensitive region was inspected;
- the source alignment is `reviewed`.

`applySourceProposal` then:

1. **Merges.** `mergeProposal` replaces only the geometry this source owns.
2. **Classifies.** Supported classifications are applied (non-walkable, lobby
   or corridor). A classification without original-source crops throws.
3. **Validates.** Any geometry error throws. `geometryChanged` bumps the
   revision and keeps the last 10 versions in history.
4. **Records openings.** For each owned door it runs `validateOpening`. The
   door is `accepted` only if the verdict is `supported`, crops exist, the
   check passed and no side is held. Otherwise it stays `proposed`, with the
   reason "Opening remains disabled until source and geometry checks pass".
   Endpoints are snapped to the validated segment.
5. **Writes records.** Every record has `review.status: "agent-inspected"`,
   whatever the caller passed.
6. **Rebuilds.** Walls are re-traced, access flags are reconciled, and the
   graph is rebuilt.
7. **Checks routes.** Accepted openings whose route check fails are
   **downgraded** to `proposed`, and the graph is rebuilt again. Nothing
   throws.

**Ordinary transactions.** Operations always run in this order, whatever the
array order:

1. **`carve`** subtracts a new region from overlapping ones. It throws if that
   would delete or split one.
2. **`classify`** changes the kind, label or access.
3. **`reject-door`** removes a door and records a `rejected-door`.
4. **`opening`** runs `validateOpening` against the draft as it stands. Any
   failure throws, and duplicate door IDs throw.
5. **`unresolved`** only appends a record.

Then:

- **Wall gaps.** `reconcileWalls` regenerates the boundary-traced walls of the
  affected regions, cuts other walls under new openings (`cutWallGap`), and
  closes removed doors that have no traced walls (`<doorId>:closed`).
- **Records.** Every record is stamped with
  `{ status: reviewStatus, reviewer, at, notes }` and the new revision.
- **Ownership.** `assignSourceOwnership` gives new IDs to the source that owns
  the neighbouring region.
- **Access flags.** `reconcileAccessFlags` clears `unknown` once a usable door
  exists, and sets it when none remains.
- **Geometry check.** Any **new** geometry error throws.
- **Route check.** `buildGraph` rebuilds the floor graph. `routeAccessResults`
  then checks every region touched by a new opening: it needs a reviewed
  doorway node, no bad edges at that node, and reachability to another room's
  doorway. Any failure throws, so the whole transaction is all-or-nothing.

**`validateOpening` checks**, in order:

- **References.** Known regions; neither side non-walkable; an exterior door
  has exactly one side, and an interior opening has two different ones.
- **Boundary.** The two regions share a boundary. Endpoints lie within 2.5 px
  of it (they are snapped), and the opening does not run past its end.
- **Size and frame.** Width is at least 2 px and at most
  `openingWidthLimit`, and the opening lies inside the floor frame.
- **Sides.** The two sides are the named regions. For an exterior door, one
  side is unmapped space.
- **Conflicts.** No overlap with an existing door, and no wall crossing it.

**`openingWidthLimit(floor, spaceId, type)`** gives a limit in pixels, not
metres:

- base: door 14, double-door 26, exterior-door 26; open-passage and
  decomposition-join have no limit;
- × `max(1, source.width / 1280)`;
- × the transform scale.

The limits were tuned for 1280 px sources. The multiplier keeps them
meaningful for 2400 px pages and scaled floors.

**Evidence.** Records go in `floors[].access.records`, validated by
`AccessRecordSchema` (`shared/building/access-state.js`). Evidence holds the
method, a description, the provider and model, the prompt version, confidence,
`crops[]` and `verifier`. Each crop records the source and asset hashes, the
renderer, page, rotation, source and floor rectangles, the transform and the
pixel scale, so a reviewer can re-render the exact view.

## 11. Assumed doorways fallback

`placeAssumedDoorways(building, floorId, { spaceIds, roomify })` in
`shared/building/assumed-doors.js` is the fallback for regions whose doorway
the source review could not establish:

- `roomsNeedingDoors` finds regions whose access state is missing, unknown,
  stale-unknown or unresolved, or that are held.
- `build-from-plan.js` runs it on every reviewed floor by default.
  `--no-assumed-doors` turns it off.
- The editor calls it through `/doorways/place` (see [api.md](api.md)).

The exact order:

1. **Stairs, lobbies and held regions become rooms.** When `roomify` is set,
   regions that need a door and are `kind: "lobby"` or held are reclassified
   as `kind: "room"` in one `classify` transaction. Landings are already
   lobbies after stages 5 and 8, so this covers stairs. Corridor pieces stay
   corridors. Labels matching
   `duct|shaft|chase|roof|balcony|void|open to below|riser` are never
   converted. **Why:** the map has no separate stair type, and a region left
   held can never route.
2. **Source-supported doors are re-enabled.** `enableSupportedDoors` takes
   each `proposed` opening whose verdict was `supported`, that has crops, and
   whose regions are no longer held. It re-validates the opening and applies it
   as reject-plus-opening, which is still subject to the route check.
   **Why:** a door the model actually saw outranks any assumption.
3. **Assumed doors are placed.** For each remaining region:
   - **Skipped regions.** A region labelled as a non-room is skipped unless a
     developer chose "Make it a room". A still-held region is skipped too.
   - **Edge choice.** `neighbourEdges` ranks shared edges of at least 4 px:
     corridors, then lobbies, then neighbouring rooms, longest first. Held and
     non-walkable neighbours are excluded.
   - **Position.** `placeOn` tries t = 0.5 (the midpoint), then 0.35, 0.65,
     0.2 and 0.8 on each edge in turn. It keeps the first position that passes
     `validateOpening`.
   - **Width.** min(0.75 × door limit, 0.8 × edge length), and at least 2 px.
   - **Door ID.** Never reused, even from history.
   - **Record.** `evidence.method: "assumed"`, status `accepted`, label
     "Assumed doorway", reviewer "Assumed-doorway fallback".
   - **Reporting.** A region with no usable edge is reported in `skipped`. If
     a walkable space comes within 15 px without touching, the gap size is
     reported too.
4. **Route pre-check.** Before anything is applied, `checkRouteAccess` builds
   the graph on a draft, for up to 5 rounds. Each round drops the regions
   whose new door does not reach another room (for example, a hallway that is
   itself cut off) and re-checks the rest. All survivors are then applied in
   one transaction.
5. **Second re-enable pass, with redundant assumed doors dropped.** Some
   supported openings pass the route check only once their neighbours have
   doors, so `enableSupportedDoors` runs again. An assumed door in a room that
   now has a re-enabled interior opening is rejected ("Replaced by a
   source-supported opening"). This is kept only if the number of ready rooms
   does not fall; otherwise the assumed doors stay.
6. **Unclear openings are bridged.** `bridgeComponents` makes up to 12 rounds.
   In each round it looks for a detected two-sided opening that meets all of
   these:
   - its record is not accepted and its verdict is `uncertain`;
   - neither side is held or non-walkable;
   - its two sides lie in different path components, not counting the
     opening's own node;
   - it still validates.

   The opening is re-applied at its detected position with method `assumed`.
   **Why:** this joins disconnected parts of the floor. "wall" and "glazing"
   verdicts are `not-supported` and are never overridden.

The function returns `placed`, `skipped`, `roomed`, `enabled` and `bridged`.
The CLI writes them to `assumed-doors.json`.

## 12. Developer controls

These are all in `shared/building/assumed-doors.js`, are exposed under
`/doorways/*` ([api.md](api.md)), and go through `applyAccessDecisions`.

- **Make it a room** (`defineAsRoom`). Earlier `proposed` classifications for
  the region are marked `rejected` ("Superseded by a developer room
  decision"). The region gets `kind: "room"`, a `manual` classification and
  status `human-reviewed`, then an assumed door straight away
  (`placeAssumedDoorways` with `roomify: false`).
- **Not a room** (`defineNotRoom`). The region's doors are rejected and it
  becomes `access: "nonwalkable"` (`manual`, `human-reviewed`). It leaves the
  queue and is never routed through.
- **Add a doorway** (`addAssumedDoor`, with `doorEdgeOptions` for the edge
  picker). With an `edgeKey`, the door goes on that edge. Several doors per
  edge are allowed: `spreadPositions` tries the spots farthest from the doors
  already on the edge. Without a key, hallway edges and not-yet-linked
  neighbours come first. When no free spot is left, an error says so.
- **Move** (`editAssumedDoor` without `confirm`). Moves an assumed door to an
  edge key, a position `t` and a width, as reject-plus-opening. It remains
  `assumed` and `agent-inspected`.
- **Confirm** (`editAssumedDoor` with `confirm: true`). A reviewer name is
  required. Evidence becomes `manual` ("Confirmed by … after comparing with
  the original plan") with status `human-reviewed`. A confirmed door counts as
  `verified`.
- **Remove** (`removeAssumedDoor`). Works only on assumed doors. It records a
  `rejected-door`.

## 13. Graph building and routing

**`buildGraph(building, floorId)`** (`shared/building/graph.js`) rebuilds one
floor and requires `geometryStatus: "reviewed"`.

- **Door nodes.** Each door with no `doorNodeProblem` (usable, and neither side
  held) gets a `<doorId>:nav` node at its midpoint, typed entrance or doorway.
- **Rectangular corridors.** A centre-line spine, with junctions where doors
  project onto it. End-wall doors are inset onto the interior.
- **Other corridors.** Grid cells from the polygon's vertex coordinates, up to
  20,000 cells, plus spine-end extensions. A door joins the nearest spine edge
  it can reach inside the polygon (`pathInside`). Straight degree-two cell
  nodes are removed afterwards.
- **Rooms.** Rooms end at their doors. Doors are linked door-to-door inside the
  room, with no centre hub, unless a connector lands there.
- **Lobbies and connector rooms.** These get a hub node.
- **Validation.** Every edge is checked by `segmentProblem` and `edgeIssue`
  (`shared/building/validation.js`). It must not cross an unusable doorway or
  leave walkable space, and it must not link different source sections or
  floors except through a matching connector. A disabled opening stays in the
  geometry and therefore blocks paths like a wall.

**Endpoints.** `roomDoorNodes` (`shared/building/endpoints.js`) resolves a room
to all of its usable doorway nodes. It returns none when the room is `unknown`
or `nonwalkable`, or when the graph revision is stale. Room centroids are never
route endpoints.

**`routeBuilding(b, from, to)`** (`shared/building/routing.js`) is a
multi-source Dijkstra search. Every doorway node of the start room starts at
cost 0. The search stops at the first doorway node of the destination room it
settles, **so the closest pair of doors wins**, and a room with several doors
is entered and left by the best one.

- **Edge costs.** Metres when every floor with edges has a scale. Otherwise a
  relative cost, normalized by the floor diagonal × `uncalibratedFloorCost`.
  Stairs and elevators add their penalties.
- **Options.** `excludeStairs` and `verifiedAccessible` filter edges.

**`roomAvailability`** reports, for each destination, whether it is `ready`
and, if not, why. **`route-display.js`** only joins same-floor steps and drops
exactly collinear points for drawing. It never changes the graph, costs or
paths.

## 14. Statuses and honesty rules

**Review status** (`record.review.status`):

- `agent-inspected`: anything a model or a rule did. This includes every
  pipeline import, every assumed door and the "Move" control.
  `applySourceProposal` hard-codes it.
- `human-reviewed`: only the explicit developer decisions "Make it a room",
  "Not a room" and "Confirm", each with a named reviewer.
- Agent work never claims `human-reviewed`.

**Door state** (`doorAccessState`):

| State | Meaning |
| --- | --- |
| `legacy` | No record; predates per-opening evidence. |
| `rejected` | Rejected after source comparison. |
| `stale` | Still a proposal, geometry changed, or validation not passed. |
| `assumed` | Accepted, `evidence.method === "assumed"`. |
| `verified` | Accepted, validated, and not assumed. |

`usableDoor` allows `verified`, `legacy` and `assumed`.

**Region state** (`spaceAccessState`) is one of:

- `nonwalkable`;
- `stale-unknown`;
- `unresolved`;
- `unknown`;
- `missing`;
- `verified`, `legacy` or `assumed`: a room counts as `assumed` when its only
  usable doors are assumed.

**Assumed is never verified.** `accessInventory` counts `assumed` separately
from `verified` and `destinationsVerified`. An assumed door is routable but is
still listed for a developer to move, confirm or remove.

**Map header.** `reviewLabel` in `shared/building/design.js` prints:

- "DRAFT" when the floor geometry is not reviewed;
- "AGENT-INSPECTED · NOT HUMAN REVIEWED" when any access record on the floor
  is not `human-reviewed`;
- "PLAN REVIEWED" otherwise.

**Why:** in early trials, agent-only maps were headed "PLAN REVIEWED".

**Final status.** `runSmartMap` finishes as one of:

- `complete`: empty queue;
- `needs-review`: something is queued;
- `limited`: the call, token or deadline budget was hit;
- `cancelled`.

Completed responses stay cached, so a resumed run does not pay again. See
[operations.md](operations.md).

## Points to watch

These follow from the code as written. Each one is worth checking before it is
relied on.

- **Split pieces jump the queue.** A split piece, or a re-split piece, is not
  in `tiles`, so `tiles.indexOf(rect)` gives it order `-1`. It therefore sorts
  ahead of the planned tiles during reconciliation. Scores decide most
  conflicts, so the effect is probably limited to ties.
- **Re-splitting is limited.** It is capped at 4 entries in the piece list, so
  only one failing half can be split again (stage 5).
- **Joins can be starved.** `maxDoorBatches` is shared, with doors filling it
  first. With very many doors, joins may go unverified. They are then queued,
  not silently dropped.
- **Risky default.** `applyAccessDecisions` defaults to `reviewStatus:
  "human-reviewed"`. Every current pipeline caller passes `agent-inspected`,
  but a new caller that leaves the option out would over-claim.
  `applySourceProposal` is safe: it hard-codes `agent-inspected`.
- **Agent transactions mark geometry reviewed.** An ordinary transaction sets
  `geometryStatus: "reviewed"` and marks every `geometry.review.issues` entry
  `resolved: true`, even when the reviewer is an agent. The header relies on
  access records instead. A floor with no access records at all would read
  "PLAN REVIEWED".
- **The transports check different limits.** The Anthropic transport allows
  up to 3.75 MP, while `VISION_MAX_PIXELS` is 3.4 MP. The Vertex transport
  checks only the long edge. Opening and semantic crops do not pass through
  `fitVisionFrame`; they rely on `renderSourceCrop`'s 2048 px clamp and their
  own pixel caps. That clamp has a minimum scale of 0.25, which a source of
  2400 px or less never reaches.
- **The redundancy test is coarse.** In step 5 of the fallback, a room counts
  as covered when any re-enabled interior opening touches it. The ready-room
  count guard keeps this from removing a needed door.
