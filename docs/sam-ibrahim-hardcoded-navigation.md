# Sam Ibrahim: hardcoded SVG project and cross-floor routes

Sam Ibrahim is integrated into the main authoring application on `feature/map-authoring-pipeline`. The project manually traces selected rooms, circulation, doorway thresholds and six named stair/elevator cores from the six original SVGs, compared with the 45-page `Sam_Ibrahim_Indoor_Navigation_Review.pdf`. It enables explicitly inferred cross-floor routes at the user's request. It is an agent-inspected project draft, not a field-verified navigation or accessibility map.

The earlier isolated experiment remains available as a strict reference. Its code and original SVGs were brought onto the feature branch by merge `2e005d8` (experiment commits `36157d9` and `0a9fa3c`). Git `main` was not changed. No dependencies, provider settings, credentials, AI pipeline orchestration or shared pathfinding algorithms were changed. The new integration adds a built-in building, project renderer, route-preview API fields and small authoring UI changes. No model or vectorization calls are needed to build this project.

## Open and reproduce

With the normal development services running, open `/authoring` and choose **Open Sam Ibrahim project**. Select start and destination rooms from any floor, choose **Stairs or elevator**, **Prefer stairs** or **Elevator · exclude stairs**, then preview the route. Floor tabs retain each floor's route overlay; the result lists stair/elevator transitions. Elevator-only excludes stair edges; it does not certify accessibility. The original SVG is the map underlay, with clickable traced rooms and thresholds plus labelled core landings.

Use Node 22 or later and the existing dependencies in `apps/pipeline`. From the repository root:

```sh
node experiments/sam-ibrahim-hardcoded/project-cli.mjs build
node experiments/sam-ibrahim-hardcoded/project-cli.mjs build --install
node experiments/sam-ibrahim-hardcoded/project-cli.mjs route LB-R02 L5-R22 --prefer-stairs
node experiments/sam-ibrahim-hardcoded/project-cli.mjs route LB-R02 L5-R22 --stairs-free
node --test experiments/sam-ibrahim-hardcoded/*.test.mjs
```

`build` writes `building.json`, `connections.json`, `summary.json` and six navigation SVGs to ignored `experiments/sam-ibrahim-hardcoded/output/project/`. `--install` also updates the committed [built-in project](../apps/pipeline/public/buildings/sam-ibrahim.json), saving a timestamped backup of the previous file in that output directory first. It never overwrites another building or the user's saved project. The experiment [package scripts](../experiments/sam-ibrahim-hardcoded/package.json) expose `project:build`, `project:install` and `test`.

A fresh checkout requires the repository's normal private environment setup for the full app, described in [the environment contract](environment-sync.md). Offline project generation and tests require no credentials. This worktree lacks `local/.env`; no private settings were created or changed during validation. The fixed-source renderer needs the committed `experiments/sam-ibrahim-hardcoded/source/` files alongside the pipeline service.

## Live preview check and stale-server recovery

After updating this branch, restart the Node pipeline service (`npm run prod` from `apps/pipeline`) so its imported renderer and route API reload. Angular hot reload alone does not update the backend. On 2026-10-18, the running process still served the old generic outline renderer despite the new frontend and project JSON. Restarting the same local service restored the original SVG underlay and six named connector markers without changing map data or credentials. Its existing legacy environment fallback remained configured; the missing consolidated `local/.env` contract issue is separate.

Verified in the user's live Chrome app at `http://127.0.0.1:4200/authoring`: select **Level B · The Collaboratorium** → **Level 5 · L5-R22 west perimeter enclosure**, choose **Prefer stairs**, then **Preview route**. The result traverses Stair C through all six floors. Switching to **Elevator · exclude stairs** and previewing again traverses Elevator C in the tested browser state. Select **Level 5** in the route-floor tabs to see the destination overlay on the original plan. Both modes and overlay retention were checked in the running UI. The source underlay shows untraced rooms too; only the traced destinations in the selectors are routable. **Build with AI** is unnecessary for testing the hardcoded project and replaces its authored geometry.

Photo-point planning was also checked in the live app. See [the photo-point verification and graph-transfer fixes](photo-capture.md#authoring-photo-points-and-graph-transfer) for results and the remaining capture-access blocker.

## Implemented coverage

| Item | Integrated project |
| --- | ---: |
| Floors | 6: B, 1, 2, 3, 4, 5 |
| Traced destination rooms | 50 |
| Rooms currently connected | 50 |
| Routing nodes / edges | 250 / 269 |
| Named cores | 4 stairs (A–D), 2 elevators (B/C) |
| Floor-side landings | 36 |
| Adjacent-floor inferred links | 30 |
| Authored horizontal approaches attached | 32 |
| Horizontal approaches unresolved | 4 |
| Verified cross-floor links | 0 |

Every ordered pair of floors has an exercised stairs route and an elevator route. Every currently available traced room can reach the basement test destination. Level 5's west and central traces now connect through the traced north doorway. Examples include Collaboratorium (`LB-R02`) to Level 5 (`L5-R22`), using Stair C by default or Elevator B with stairs excluded.

The four unresolved horizontal approaches are Stair A on B, 1 and 2, and Stair D on B. Their floor-side positions and inferred vertical core continuity are recorded, but there is no floor-corridor attachment at those landings. Other attached cores provide routes across all six floors. Floor service, re-entry, elevator operation and landing elevations remain assumptions.

The four formerly unavailable Level 2 rooms now have assumed doorway connections: Corner Shop (`L2-R01`), Spot (`L2-R02`), Cloud (`L2-R06`) and Keystone (`L2-R07`). After the user identified visible source openings, [project-only corrections](../experiments/sam-ibrahim-hardcoded/data/project-level2-openings.mjs) retraced Spot's southeast threshold, Cloud's sloping east wall and both east openings, and Keystone's north vestibule and curved south rim. Keystone's earlier misplaced southeast threshold was moved to the visible swing near x307–317 in the original SVG frame; a separate north entrance was added. Cloud and Keystone entrances remain separate terminals, with no graph edge through seating. [Project assembly](../experiments/sam-ibrahim-hardcoded/project.mjs) sends these geometry/opening changes through the existing `applyAccessDecisions` adapter; shared automation and the strict offline experiment are unchanged.

The [installed project](../apps/pipeline/public/buildings/sam-ibrahim.json) was backed up before replacement. [Project regressions](../experiments/sam-ibrahim-hardcoded/project.test.mjs) check all four rooms with same-floor and cross-floor stairs/elevator routes, separate entrance nodes, source evidence and agent-only review. Verification: 35 experiment tests and 232 pipeline tests pass (18 optional-fixture skips); live API and Chrome show Level 2 **11/11 rooms ready** and all four selectable. The user is testing the route previews. Threshold widths and physical access remain unverified.

Most small upper-floor rooms, several tiered rooms and lower service areas are still untraced. The 366 preserved PDF regions are an inventory, not 366 navigable rooms. Unknown scale, empty photo collections and no localization result are retained.

## Manual construction and pipeline reuse

| Automated pipeline step | Project-specific implementation |
| --- | --- |
| Read/vectorize source | Freeze the six existing original SVGs byte-for-byte and audit their hashes and path-first shape IDs |
| Identify spaces | Preserve every printed PDF region/portal and associate selected identities with SVG source shapes |
| Trace geometry | Explicit room vertices, circulation polygons and threshold segments in the original SVG frame |
| Decide access | Existing `applyAccessDecisions` transaction with assumed evidence and `agent-inspected` review |
| Construct paths | Existing graph builder, with terminal-room interior shortcuts removed in the local adapter |
| Connect floors | Explicit named-core landing definitions, validated authored approach polylines and existing `connectLandings` |
| Show the project | Built-in library entry, original-SVG renderer and per-floor route overlays in `/authoring` |

[project.mjs](../experiments/sam-ibrahim-hardcoded/project.mjs) unions only authored circulation, subtracts destination rooms, partitions holes into simple polygons and adds analytical seams. Project-only geometry corrections preserve the west walls beside Level 4/5 Stair A and the narrow openings in Level 4's east passage and Level 5's northwest link. They do not alter the strict reference geometry. It remaps room thresholds and builds through the existing access adapter.

Each accepted connector `approachPath` becomes a graph edge. Its final join may snap at most 25 SVG units to an existing validated corridor edge, which is split at the junction. All approach segments and joins are checked against walkable geometry and terminal-room interiors. The other authored corridor `paths`, `joins` and the older experiment's `spines` remain review aids; merged polygons and derived seams determine normal corridor connectivity. Unresolved approaches get a local landing footprint but no invented horizontal bridge.

Six named cores are connected only between adjacent levels. Every connector records the project assumption and unknown real-world access. Existing schema `reviewed` graph flags indicate deterministic geometry checks; they do not mean human approval. All access review records say `agent-inspected`. The UI and API expose the inferred status, and verified-accessibility requests return no route.

The UI's **Build with AI** controls remain the normal authoring workflow. Re-running them replaces manually traced geometry, so use the project CLI to regenerate the authored baseline. Opening the built-in project provides a fresh copy; ordinary edits are saved through the existing application mechanism. Geometry edits rebuild graph portions and must be route-checked afterward.

## PDF and SVG evidence

[source-manifest.json](../experiments/sam-ibrahim-hardcoded/data/source-manifest.json) records source hashes, dimensions and frames. Frozen originals: [B](../experiments/sam-ibrahim-hardcoded/source/Level-B-original.svg), [1](../experiments/sam-ibrahim-hardcoded/source/Level-1-original.svg), [2](../experiments/sam-ibrahim-hardcoded/source/Level-2-original.svg), [3](../experiments/sam-ibrahim-hardcoded/source/Level-3-original.svg), [4](../experiments/sam-ibrahim-hardcoded/source/Level-4-original.svg), [5](../experiments/sam-ibrahim-hardcoded/source/Level-5-original.svg). Clean redraws are not source evidence. Embedded PNGs in the installed project are display renderings of those SVGs, never the source of graph coordinates.

The PDF's normalized crop frame differs from each original SVG frame. `crossFrameTransform` stays null: report centres and annotation boxes never become walking coordinates. `L2:original-svg-viewbox` and `svg-original-L2` are naming aliases for the same SVG frame, and similarly for other floors. Geometry is authored in SVG units, normalized in the source spec and restored to SVG units by the adapter. There is no metres-per-unit scale.

`pN` follows the pipeline's `compactSvg` path-first enumeration, not DOM order. The audit rejects changed hashes, mismatched dimensions/frames and missing nested references. A valid reference establishes the existence of a source shape, not physical correctness of a doorway or floor connection.

The complete [review inventory](../experiments/sam-ibrahim-hardcoded/data/review-inventory.json) contains 366 regions and 330 portal candidates; [review questions](../experiments/sam-ibrahim-hardcoded/data/review-questions.json) preserve Q01–Q10 and completeness discrepancies. Portal IDs are qualified by floor, such as `L2:P06` and `L5:P001`.

| Level | Printed regions | Portal candidates | PDF overview page |
| --- | ---: | ---: | ---: |
| 5 | 105 | 95 | 3 |
| 4 | 115 | 108 | 4 |
| 3 | 41 | 35 | 5 |
| 2 | 39 | 36 | 6 |
| 1 | 34 | 29 | 7 |
| B | 32 | 27 | 8 |

Cloud's Level 3 projection has no resolved entrance. Conveyor's `IA2150`/`IA2150A` identity and entrance elevations remain unresolved. The eastern B/1 tiered classroom is distinct from the basement Green Room, and repeated seating does not establish a walkable connection. None of these room interiors become stairs or shortcuts. Roof gardens remain Level 4 observations; voids and exterior/service routes are not silently made walkable.

The evidence graph retains 62 candidate landing/endpoint records and 43 candidate relationships, including 30 adjacent named-core matches, a separate B/1 match and 12 unresolved open flights. The integrated project separately selects 36 floor-side named-core landings; it does not enable every candidate relationship.

To regenerate side-by-side comparisons from locally rendered PDF overview pages:

```sh
node experiments/sam-ibrahim-hardcoded/cli.mjs compare --report-images /absolute/path/to/rendered-review-pages
```

The external PDF and page PNGs are not required for ordinary builds. [tools/extract-review.py](../experiments/sam-ibrahim-hardcoded/tools/extract-review.py) reproduces the inventory with an existing Python environment containing `pypdf` and Pillow; it validates this report's specific hash and counts.

## Strict reference and implementation files

The original [cli.mjs](../experiments/sam-ibrahim-hardcoded/cli.mjs) still supports `check`, `build`, `inspect`, `route --draft` and `compare`. Its outputs go to the experiment's ignored `output/`, separate from `output/project/`. Strict routes require draft opt-in and never cross floors; its original graph has 140 nodes and 132 edges. It preserves geometry vertices, review graph, coverage, navigation exports, source overlays and manual capture suggestions for comparison.

- Source geometry and evidence: [lower floors](../experiments/sam-ibrahim-hardcoded/data/lower-floors.mjs), [upper floors](../experiments/sam-ibrahim-hardcoded/data/upper-floors.mjs), [review graph](../experiments/sam-ibrahim-hardcoded/review-graph.mjs), [SVG audit](../experiments/sam-ibrahim-hardcoded/svg-tools.mjs).
- Integrated landing/corridor definitions: [lower connectors](../experiments/sam-ibrahim-hardcoded/data/project-connectors-lower.mjs) and [all-floor connector assembly](../experiments/sam-ibrahim-hardcoded/data/project-connectors.mjs).
- Build and install: [project builder](../experiments/sam-ibrahim-hardcoded/project.mjs), [project CLI](../experiments/sam-ibrahim-hardcoded/project-cli.mjs), [package scripts](../experiments/sam-ibrahim-hardcoded/package.json), [installed building](../apps/pipeline/public/buildings/sam-ibrahim.json).
- Shared-module adapters and rendering: [pipeline adapter](../experiments/sam-ibrahim-hardcoded/pipeline-adapter.mjs), [strict model](../experiments/sam-ibrahim-hardcoded/model.mjs), [offline navigation renderer](../experiments/sam-ibrahim-hardcoded/render-navigation.mjs).
- App service: [source renderer](../apps/pipeline/server/projects/sam-ibrahim.js) and [authoring routes](../apps/pipeline/server/authoring-routes.js).
- App UI: [component](../apps/web/src/app/features/authoring/authoring.ts), [template](../apps/web/src/app/features/authoring/authoring.html), [styles](../apps/web/src/app/features/authoring/authoring.scss), [service contract](../apps/web/src/app/features/authoring/pipeline.service.ts), [component tests](../apps/web/src/app/features/authoring/authoring.spec.ts).
- Project tests: [data/source checks](../experiments/sam-ibrahim-hardcoded/project-connectors.test.mjs), [routes and determinism](../experiments/sam-ibrahim-hardcoded/project.test.mjs), [library/API/rendering](../apps/pipeline/tests/sam-ibrahim-project.test.js). The original experiment tests remain alongside these.

## Verification

Verification on 2026-10-18: 34 experiment/project tests pass; the full pipeline suite passes 230 tests with 18 skips for the absent optional Waterloo regression fixture. The authoring component's 32 tests and production web build pass. Tests exercise all 30 ordered floor pairs with stairs and elevators, all 46 available rooms, unknown accessibility, unresolved thresholds, source hashes/references, every graph edge and reproducible project assembly. API checks cover the built-in library, invalid options, transition instructions and source rendering. Final SVG placements were inspected against original source geometry and PDF imagery. These are software and source checks, not physical validation.

The shared feature record is this document; contributor actions are appended to ignored `local/ACTIONS.md`. Integration implementation: [bfafd37](https://github.com/mhamza1906/SnapWay/commit/bfafd37d28200baa372ecfacee660de98b4b0670); imported experiment: [36157d9](https://github.com/mhamza1906/SnapWay/commit/36157d9). These commits are saved locally; remote links become available after a push. No push or merge into Git `main` is part of this integration.

Level 2 doorway correction: [50f5dc2](https://github.com/mhamza1906/SnapWay/commit/50f5dc2).
