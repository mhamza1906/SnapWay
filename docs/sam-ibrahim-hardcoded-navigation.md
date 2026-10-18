# Sam Ibrahim: offline SVG navigation experiment

This experiment manually reconstructs selected room boundaries, circulation, doorway thresholds and navigation graphs from the six original vectorized SVGs, compared with the 45-page `Sam_Ibrahim_Indoor_Navigation_Review.pdf`. It preserves the report's complete inventory and unresolved stair/room relationships. It is an incomplete, unverified navigation draft for later integration.

Branch: `feature/sam-ibrahim-hardcoded-navigation`, based on local `feature/map-authoring-pipeline` commit `9f5e2ca`. Work began at `dfa97f7` (vectorizer.ai plus SVG reading) and the isolated branch was advanced to the new local tip before completion; the imported pure pipeline modules were unchanged between those revisions. The source checkout contained an unfinished merge at the start, so this work uses a separate checkout, `SnapWay-sam-hardcoded`. All implementation files are in [experiments/sam-ibrahim-hardcoded](../experiments/sam-ibrahim-hardcoded/). Existing application, backend and pipeline files are unchanged relative to the final base. No providers, network requests, environment files or credentials are used. No dependencies were added.

## Reproduce and inspect

Use Node 22 or later and the pipeline's existing installed dependencies. From the repository root:

```sh
node --test experiments/sam-ibrahim-hardcoded/*.test.mjs
node experiments/sam-ibrahim-hardcoded/cli.mjs check
node experiments/sam-ibrahim-hardcoded/cli.mjs build
node experiments/sam-ibrahim-hardcoded/cli.mjs inspect L2-R06
node experiments/sam-ibrahim-hardcoded/cli.mjs inspect L2:P06
node experiments/sam-ibrahim-hardcoded/cli.mjs route L1-R01 L1-R02 --draft
node experiments/sam-ibrahim-hardcoded/cli.mjs route L3-R01 L3-R19 --draft --stairs-free
```

The isolated [package.json](../experiments/sam-ibrahim-hardcoded/package.json) also exposes `build`, `check` and `test`. There is no server or application build step. In the development worktree, an ignored symlink points to the source checkout's existing `apps/pipeline/node_modules`. A fresh checkout must have the dependencies already specified by `apps/pipeline/package.json`; this experiment does not install them or change the lockfile.

`build` writes only to the experiment's ignored `output/`, or a directory supplied with `--out`. The [ignore file](../experiments/sam-ibrahim-hardcoded/.gitignore) excludes generated artifacts and Python caches. Outputs include:

| File | Contents |
| --- | --- |
| `building.draft.json` | Existing pipeline building schema; explicit SVG polygons, assumed doors and validated same-floor graph |
| `navigation-bundle.draft.json` | Existing navigation export, still unverified |
| `navigation-graph.draft.json` | Actual routing nodes and edges, with an empty connector list |
| `geometry-vertices.json` | Individually identified polygon vertices in SVG viewBox units; these are not destination nodes |
| `review-graph.json` | Complete observations, portal candidates, room correspondences, core matches and unanswered questions |
| `coverage.json` | Per-floor mapped, unmapped, unresolved and currently routable IDs |
| `capture-plans.draft.json` | Existing pipeline's manual reference-photo suggestions, without photos or metric distances |
| `pipeline-report.json` | Provenance, unresolved thresholds, candidate landings, discarded room-transit edges and availability |
| `source-audit.json`, `summary.json` | Hash/reference checks and current coverage/counts |
| `L*-source-comparison.svg` | Original source with manual geometry and threshold overlays |
| `L*-selected-source-shapes.svg` | Highlighted original SVG elements cited by the geometry and core observations |
| `L*-navigation.draft.svg` | Original source with actual navigation nodes and edge polylines |

Optional PDF comparison panels require locally rendered full pages named `page-03.png` through `page-08.png`:

```sh
node experiments/sam-ibrahim-hardcoded/cli.mjs compare \
  --report-images /absolute/path/to/rendered-review-pages
```

These panels sit beside the SVG rather than being aligned onto it. The PDF and rendered images remain external. The complete inventory is already checked in, so ordinary builds need neither the PDF nor Python. To reproduce extraction, use [tools/extract-review.py](../experiments/sam-ibrahim-hardcoded/tools/extract-review.py) with an existing Python environment containing `pypdf` and Pillow, and `--source-root /absolute/path/to/Hack_The_valley`. The extractor checks the specific PDF hash and inventory counts; it is not a generic floor-plan parser.

## How this replaces the automated steps

| Existing pipeline work | Manual experiment |
| --- | --- |
| Crop/vectorize source plans, then read SVG elements | Freeze the existing original SVGs byte-for-byte; enumerate their shapes with the same path-first IDs |
| Classify spaces and establish identities | Transcribe every printed PDF region and portal relationship; manually associate selected identities with source shapes |
| Trace geometry | Author explicit vertices in the original SVG viewBox; do not turn PDF annotation boxes into walkable polygons |
| Decide openings and access | Author threshold segments and apply them through the existing `applyAccessDecisions` transaction, explicitly `agent-inspected` and `assumed` |
| Build graphs and choose destination endpoints | Reuse existing graph and routing modules; rooms terminate at doorway endpoints, with interior through-room paths removed locally |
| Match floors | Preserve named-core correspondences as separate candidate links; no unverified cross-floor connector is inserted |
| Export navigation and propose capture points | Reuse existing navigation-bundle and capture-point helpers, retaining unknown scale and empty photo collections |

The adapter imports only pure modules under `apps/pipeline/shared/`. It does not invoke the SVG-reading model, vectorization service, pipeline orchestration or server. The pipeline automatically treats some large multi-door rooms as circulation; the experiment filters edges entering any terminal room's interior so tiered lecture rooms cannot become shortcuts. That behavior is contained in the experiment.

The manually authored lower-floor `spines` and landing `approachPath` lines are review aids. The routing graph is built by the unchanged pipeline from the polygons and accepted draft thresholds; those hand-positioned lines do not inject edges or force connections. Unsupported branches remain unresolved.

## Source frames and evidence

[source-manifest.json](../experiments/sam-ibrahim-hardcoded/data/source-manifest.json) records source hashes, dimensions, frames and six local frozen-source mappings. The frozen files are [B](../experiments/sam-ibrahim-hardcoded/source/Level-B-original.svg), [1](../experiments/sam-ibrahim-hardcoded/source/Level-1-original.svg), [2](../experiments/sam-ibrahim-hardcoded/source/Level-2-original.svg), [3](../experiments/sam-ibrahim-hardcoded/source/Level-3-original.svg), [4](../experiments/sam-ibrahim-hardcoded/source/Level-4-original.svg) and [5](../experiments/sam-ibrahim-hardcoded/source/Level-5-original.svg). Earlier cleaned derivatives are catalogued only; they are not source evidence for these outlines.

The report's normalized crop frame differs from each original SVG frame. `L2:report-crop-normalized` therefore cannot be used as `svg-original-L2`. The manifest's `L2:original-svg-viewbox` and code's `svg-original-L2` are aliases for the same original source frame; their naming difference is not a geometric transformation. The same convention applies to the other floors. `crossFrameTransform` remains null. Report centres are observations, never walkable endpoints. Geometry is authored in SVG units, stored as normalized tuples, and converted back to SVG units by the adapter. There is no metres-per-unit scale.

`pN` follows `compactSvg` at the base commit: all paths are numbered first, followed by supported non-path elements. It is not global DOM ordering. The audit rejects changed source hashes, mismatched dimensions/frames and missing shape IDs, including nested doorway and landing-anchor references. A valid reference proves the cited shape exists; it does not prove that a hand-traced outline, doorway, name or physical connection is correct.

## PDF findings retained in code

The complete [review inventory](../experiments/sam-ibrahim-hardcoded/data/review-inventory.json) contains 366 regions and 330 portal candidates. Portal IDs repeat between floors and are globally qualified, such as `L2:P06` and `L5:P001`, while retaining their printed labels. The [review questions](../experiments/sam-ibrahim-hardcoded/data/review-questions.json) preserve Q01–Q10 and the discrepancies/completeness observations.

| Level | Printed regions | Portal candidates | Overview page |
| --- | ---: | ---: | ---: |
| 5 | 105 | 95 | 3 |
| 4 | 115 | 108 | 4 |
| 3 | 41 | 35 | 5 |
| 2 | 39 | 36 | 6 |
| 1 | 34 | 29 | 7 |
| B | 32 | 27 | 8 |

- Cloud: two Level 2 portal observations; the Level 3 depiction has no resolved doorway. Its footprint is not a route or a floor connector.
- Conveyor: two Level 2 and three Level 3 portal observations, with unresolved `IA2150`/`IA2150A` identity and entrance elevations. No room-interior stair/terrace link is inferred.
- The unnamed eastern tiered classroom on B/1 may correspond across levels. It is distinct from the basement Green Room; repeated seating does not establish a connection.
- Stair cores A–D and elevators B/C have 30 adjacent-floor identity matches. The additional B/1 core match and 12 unresolved open stair flights are also retained. Their 62 landing/endpoint records have unknown actual landing coordinates/elevations; a source depiction anchor is separate.
- Roof gardens are Level 4 features. Unresolved voids, garden access, exterior exit groups and service-space access are not silently made walkable.
- Official classroom and door totals are completeness evidence, not a substitute for establishing each doorway.

## Current route coverage and limitations

Selected outlines exist on all six floors. Examples exercised in both directions include Collaboratorium–Green Room, Brainstorm–Dark Matter, Mission Control–Rhythm, Hive–the southeast Level 3 rooms, the west/southwest Level 4 rooms, and the Level 5 north/central rooms. `coverage.json` is the authoritative list; preserved inventory entries are not all traced geometry.

The Level 2 Corner Shop, Spot and Cloud thresholds remain positioned candidates because the existing graph builder does not attach their corridor branches. Corner Shop lost its branch after the north corridor was corrected to avoid the Keystone rim; source-preserving partition trials did not restore it. Keystone's southeast threshold is also unresolved after comparing its curved boundary. No rescue edge crosses these gaps. The separate Level 5 west and central traces remain disconnected. Lower-floor service areas, several tiered rooms and most small upper-floor enclosures remain untraced.

The routing wrapper requires `allowDraft: true` (`--draft` in the CLI). Default strict requests return no route. Cross-floor requests return no route even in draft mode. `--accessible` also returns no route because no verified accessible network exists. `--stairs-free` only filters accepted graph edges; it does not establish accessibility. Generated schema review flags indicate deterministic geometry checks, not human or field approval. Every review record explicitly says `agent-inspected`.

For later integration, treat this as proposed authoring data. Recheck source geometry, doorway widths/elevations, scale, corridor continuity, landing locations, stair re-entry and elevator service before accepting routes. No user position is inferred, and no localization result is produced.

## Implementation and verification

- [data/lower-floors.mjs](../experiments/sam-ibrahim-hardcoded/data/lower-floors.mjs) and [data/upper-floors.mjs](../experiments/sam-ibrahim-hardcoded/data/upper-floors.mjs): explicit vertices, thresholds, source references and unresolved approaches.
- [review-graph.mjs](../experiments/sam-ibrahim-hardcoded/review-graph.mjs): full evidence graph, room identities and non-traversable stair/elevator relationships.
- [pipeline-adapter.mjs](../experiments/sam-ibrahim-hardcoded/pipeline-adapter.mjs): schema/access/graph/routing/export adapter and terminal-room filter.
- [model.mjs](../experiments/sam-ibrahim-hardcoded/model.mjs): deterministic assembly, vertex IDs, coverage and capture suggestions.
- [svg-tools.mjs](../experiments/sam-ibrahim-hardcoded/svg-tools.mjs): original source inspection, reference audit and static comparison views.
- [render-navigation.mjs](../experiments/sam-ibrahim-hardcoded/render-navigation.mjs): graph visualization from generated nodes and edges; optional route presentation uses the existing display helper.
- [cli.mjs](../experiments/sam-ibrahim-hardcoded/cli.mjs): build, check, inspect, route and compare commands.
- Tests: [model](../experiments/sam-ibrahim-hardcoded/model.test.mjs), [adapter](../experiments/sam-ibrahim-hardcoded/pipeline-adapter.test.mjs), [SVG evidence](../experiments/sam-ibrahim-hardcoded/svg-tools.test.mjs), and [navigation renderer](../experiments/sam-ibrahim-hardcoded/render-navigation.test.mjs).

Tests cover complete inventory/reference integrity, source tampering, frame mismatches, schema round-trips, every retained graph edge, representative bidirectional routes, inaccessible/unresolved cases, no cross-floor or tiered-room shortcuts, deterministic adapter output and absence of metric/photo claims. Source comparisons were visually inspected against the original SVGs and PDF imagery. This is code/geometry validation, not physical route validation.

Final verification on 2026-10-18: all 26 experiment tests pass. The existing access, building, capture-point, centreline and route-display suites pass 58 tests, with nine skipped for the absent optional Waterloo fixture. The initial-document checker passes all 14 documents. Re-extracting the PDF produces byte-identical inventory, questions and source-manifest files; two independent builds produce ten byte-identical JSON artifacts; all 18 generated SVGs parse as valid XML. The final graph has 140 nodes and 132 edges, with 429 geometry vertices, 67 traced regions (50 inventory regions plus 17 circulation partitions), 65 draft thresholds including analytical partition joins, and 33 manual capture plans. There are zero verified cross-floor edges. No application, backend, existing pipeline or dependency files differ from base `9f5e2ca`.

Development actions are recorded in the contributor's ignored `local/ACTIONS.md`. This document is the shared feature record. Implementation commit: [36157d9](https://github.com/mhamza1906/SnapWay/commit/36157d9), based on `9f5e2ca`. Both the experiment and this record are saved locally; the implementation link becomes available remotely after the branch is pushed. No push or integration was performed.
