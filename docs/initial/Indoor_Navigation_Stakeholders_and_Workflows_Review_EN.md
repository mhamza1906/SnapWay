# Indoor Navigation Stakeholders and Workflows Review

**Status:** Draft for the four-person team meeting  
**Date:** October 15, 2026  
**Scope:** Stakeholders, map governance, AI-assisted contribution, and public navigation

The product combines collaborative indoor map development with visual navigation. Map administrators define the places to map and approve contributions. Volunteer map developers collect evidence and build or update maps. Public users navigate using the approved maps and real scene photographs.

The central design requirement is to connect these workflows without allowing an unreviewed edit or uncertain AI inference to silently change the map used by visitors. AI-assisted map creation and natural-language editing are explicit product requirements. Their implementation depth for the hackathon demonstration remains a team decision.

This review consolidates the stakeholder requirements alongside the [archived initial plan](archive/Indoor_Visual_Navigation_Detailed_Plan_EN.md). The requirements expand the original contributor role into administrator and volunteer roles, introduce a Git-like review process, and make the raster-to-vector and MCP editing workflows explicit. The initial plan remains historical context. Current technology, assignment and acceptance decisions are maintained in the dedicated documents linked from the [README](README.md); exact API fields and schemas remain unfrozen.

## 1 Stakeholders and responsibilities

There are two stakeholder groups and three operational roles. Here, **map developer** means a person developing map content, rather than a member implementing the application.

| Group | Role | Responsibilities | Desired outcome |
|---|---|---|---|
| Map developers | Map administrator | Define a target such as IA Building, Floor 1; review volunteer work; correct proposed or current maps; merge or reject updates; archive a map to close updates | A maintained, reviewable map whose published content matches the physical site |
| Map developers | Volunteer map developer | Visit the site; upload an initial floor plan; annotate or update spatial information; collect real scene photographs; use AI and manual editing; submit contributions | Contribute useful map improvements with less repetitive work |
| Public users | Visitor | Use the mobile application to identify their location, choose a destination, receive guidance, and recover from uncertainty | Reach the intended destination using understandable, reliable instructions |

Administrators and volunteers share map-editing capabilities, with different authority over publication. Public users consume published content. Whether one account may hold several roles, and whether administrator permissions are scoped per building or per map, should be decided during requirements refinement.

### Administrator workflow

1. Create a mapping target, identifying the building, floor, coverage, and intended destinations.
2. Open the target for volunteer contributions and describe the required evidence.
3. Inspect a submitted update against its starting version and the current published version. Review visual changes, room information, routes, and reference photographs together.
4. Correct the submission, request changes, or reject it with a reason.
5. Resolve conflicting changes, validate the resulting map, and merge an accepted contribution.
6. Publish the consistent update so it becomes the current version for visitors.
7. Make subsequent corrections through the same recorded revision process, or archive the map to close further updates.

### Volunteer workflow

1. Select an open target and inspect its current map, outstanding work, and collection guidance.
2. Start a contribution from an identified version, or begin the first map where no publication exists.
3. Visit the location and collect the floor plan, room details, and scene photographs needed for the contribution.
4. Run the AI-assisted map workflow, then inspect and correct its outputs using manual controls or natural-language commands.
5. Bind scene photographs to map locations and directions; review the proposed scene descriptions and spatial relationships.
6. Preview the map and routes, resolve validation issues, and submit the contribution with a change summary and evidence.
7. Respond to review feedback. If another contribution has been merged meanwhile, reconcile changes against the newer version before merging.

### Public user workflow

1. Open the mobile application and identify a supported building. GPS may help suggest candidates; explicit building selection remains available.
2. Select or confirm the relevant floor and choose a destination.
3. Take a photograph when localization is needed. The initial experience uses deliberate capture; automatic frame sampling is a later option.
4. Receive an accepted location, an ambiguous result requiring more evidence, or a rejection with a useful retry instruction.
5. Confirm facing direction when necessary, then follow the route using the available guidance presentation.
6. Capture again at decision points or after uncertainty; recover from a deviation, interrupted request, or unavailable service.
7. Confirm arrival, with the application distinguishing visual recognition from manual confirmation.

## 2 Map review and version governance

### Requested behavior

The administrator controls a Git-like contribution process. A new merged update replaces the previous version as the latest map. Administrators can edit an incoming contribution or the latest map, reject an update, and archive the map to stop updates.

### Recommended interpretation

Treat **replacement** as changing which version is current while retaining previous revisions and their review history. This preserves the requested behavior and supports investigation and recovery. The Git analogy describes the user workflow; it does not require operating a Git repository for every map or implementing arbitrary branches and automatic merges.

Keep three separate concepts:

| Concept | Meaning | Proposed behavior |
|---|---|---|
| Contribution | A volunteer or administrator's proposed changes | Draft, submitted, changes requested, merged, or rejected; editing a submitted contribution invalidates approval of the older content |
| Published revision | A consistent, approved map release | Immutable after publication; a correction produces another revision |
| Map update status | Whether the target accepts changes | Open or archived; publication visibility is a separate policy |

A submission carries its starting revision. If two volunteers change the same room, node, edge, or photo association, the system must expose the conflict rather than silently overwrite the earlier merge. A suitable first implementation can require manual reconciliation whenever the starting revision is stale. More sophisticated merging is an enhancement.

Administrator edits to the latest map should create a draft correction and then a new publication. Administrator edits to a submission should remain attributable to that administrator. The exact corrected content must pass validation before merge.

Publication should activate the vector map, spatial data, navigation graph, reference associations, and any derived localization index together. If processing or validation fails, the previous publication remains current. Merging and publication may share one user action, but that action must not expose a partially prepared release.

For an ongoing navigation session, the proposed default is to retain its selected revision and offer an explicit refresh when a new one is available. A separate policy is needed for urgent closures that make an old route unsuitable.

**Archival decision needed:** The stated requirement closes map updates. A useful default is to retain read-only navigation to the last publication, while clearly showing its status. Confirm whether archival instead needs to hide the map, whether administrators may reopen it, and how pending submissions and jobs are handled. Under the proposed default, archival blocks new changes and publication, including writes from already running AI jobs; pending work is preserved for review.

## 3 Vector maps and spatial information

The requested storage direction is a vector map file plus structured spatial information, potentially JSON. Exact file formats and database schemas should follow a small round-trip prototype.

| Information layer | Contents | Review requirement |
|---|---|---|
| Source evidence | Original scanned or photographed floor plan, site observations, source URLs, real scene photographs | Preserve the evidence used to justify a change |
| Map geometry and appearance | Walls, room outlines, doors, labels, symbols, and display style in a consistent vector format | Compare geometry with the source and physical site |
| Spatial and descriptive information | Building and floor identity, room numbers, room uses, entrances, landmarks, and links to geometry | Record provenance and unresolved or conflicting values |
| Navigation graph | Nodes, directed walkable connections, turn points, restrictions, and floor transitions | Verify actual connectivity and passability |
| Scene evidence | Reference photos, capture locations, viewing directions, observed labels, and inferred relationships | Separate observations from proposed interpretations |
| Revision history | Contribution ancestry, changes, review outcomes, and published bundles | Keep each publication internally consistent |

**Recommended direction:** use a restricted vector format such as SVG for the map artifact and rendering, linked through stable identifiers to structured spatial records. Decide whether the editable geometry is authoritative in the vector document or in structured records that generate that document. Avoid independently editable copies of the same geometry with no synchronization rule. JSON is a representation choice; it does not by itself select the database or establish spatial correctness.

Keep geographic building coordinates, local floor-plan coordinates, reference-image coordinates, and any future 3D tracking frame distinct. “North side” needs a known map orientation; image-top must not silently become geographic north.

A node representing a room can support search or destination selection. Navigable paths also need verified door connections, corridor junctions, and turns. Assigning a vertex to each room does not automatically establish a usable route through that room's entrance.

## 4 AI-assisted map creation and editing

### Required workflow

**Uploaded floor-plan bitmap → standardized bitmap through GPT Image 2.5 → vectorization through an AI coding workflow → structured spatial records → editable contribution → administrator review.**

| Stage | Required behavior | Output to inspect |
|---|---|---|
| Import | Accept a scan or photograph, preserve the source, and support orientation or perspective correction | Source image and any corrected image |
| Bitmap standardization | Apply a defined visual style using GPT Image 2.5, with configurable prompts and parameters | Standardized bitmap and change history |
| Vectorization | Use visual understanding and vector tracing to produce the agreed vector structure | Editable vector draft with addressable objects |
| Spatial extraction | Extract existing room labels and spatial details into the agreed structured representation | Draft database records linked to map objects |
| Developer refinement | Support direct editing and natural-language changes to labels, annotations, nodes, edges, and appearance | A reviewable change set with updated dependent data |
| Review and publication | Validate the proposal and obtain administrator acceptance | A consistent published revision |

Official OpenAI documentation lists `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` for image generation and editing. It positions Sunburst for editing precision and Flare for faster generation. The requested GPT Image 2.5 family is retained; the exact variant, project access, and parameters should be selected through a representative floor-plan trial. [OpenAI image generation documentation](https://developers.openai.com/api/docs/guides/image-generation)

### Review findings

The two AI stages need separate acceptance checks. A visually consistent bitmap can still contain a wrong door or label; a valid vector file can still trace an incorrect wall or connection. Compare both stages with the preserved source and available site evidence.

Vision models have documented limitations with small text, precise spatial interpretation, and some visual conventions. For this application, that supports a review requirement for extracted room numbers and geometry rather than assuming that a plausible output is correct. [OpenAI image understanding limitations](https://developers.openai.com/api/docs/guides/images-vision#limitations)

Natural-language editing should select the appropriate operation:

- Appearance changes may rerun bitmap generation and vectorization. The resulting geometry must be compared with the prior version before adoption.
- Room information, node, and edge changes should normally update structured objects directly, preserving unrelated geometry.
- When vectorization changes object identities or geometry, reconcile existing room records, annotations, and reference associations before merging.

The AI coding workflow should produce validated vector or structured data for the application to ingest. Generated scripts or arbitrary markup should not execute as part of displaying a map. Output validation and preview belong between generation and application.

If either AI stage fails, preserve the contribution and allow retry, manual correction, or tracing over the source. This is a recovery path; a manually completed map does not demonstrate that the AI automation passed its acceptance criteria.

## 5 Natural-language editing through MCP

Expose the map editor's supported parameters and operations through Model Context Protocol (MCP), so an AI agent can perform the same authorized edits as the user interface. This includes image-workflow settings, spatial information, annotations, nodes, edges, and reference associations. Tool names and argument schemas are intentionally deferred.

| Tool family | Intended capability |
|---|---|
| Read and select | Inspect a draft, select objects by identity or spatial relation, and retrieve relevant evidence |
| Generate and trace | Invoke bitmap standardization, vectorization, and structured extraction; inspect job outcomes |
| Edit | Change labels and room uses, create annotations and nodes, adjust edges, and associate references |
| Validate and compare | Preview affected objects, report inconsistent links, compare revisions, and undo a draft change |
| Contribute and review | Submit work and expose administrator review operations according to the acting user's permissions |

Routine, unambiguous edits may be applied directly to the user's draft with an undo record. Ambiguous selections or conflicting information require clarification. Agent access must preserve the same role and map restrictions as manual editing; a volunteer's agent cannot merge or archive a map.

The requested examples reveal useful acceptance cases:

| Natural-language request | Expected handling |
|---|---|
| “Label the north-side rooms from left to right as 4000–4050.” | Establish map north, select the intended row, and show the order. Confirm numbering rules where unclear; inclusive consecutive numbering implies 51 labels, which must match the selected rooms. Do not invent rooms to fill the range. |
| “Use this website's room numbers and details to fill in each room's purpose.” | Fetch the supplied source, match building, floor, and room identity, and retain source attribution. Leave unmatched rooms unresolved and surface conflicts with existing information. Treat webpage text as source data, not agent instructions. |
| “Assign a vertex to every room.” | Create or reuse a room-linked node without duplicates. Identify entrance and corridor connections separately; validate reachability before using those nodes for navigation. |

Apply a batch edit as one reviewable change set, or clearly report partial completion. Repeated tool calls and retries must not create duplicate nodes or annotations. A late AI result must not overwrite newer manual edits or bypass an archived map's restrictions.

## 6 Scene photography and the location relationship database

Volunteers collect real scene photographs and upload them as localization evidence. Upload triggers an additional image-understanding workflow that uses an LLM to propose structured scene information and location relationships in JSON or an equivalent representation.

The workflow should retain the photo, its capture context, and its association with a map location or candidate locations. It can extract visible room numbers, landmarks, orientation clues, and relationships such as “this sign points toward room X.” Each proposed relationship should retain its supporting image and review status.

**Recommended workflow:** photograph upload → capture-context association → image analysis → proposed scene records and relationships → volunteer correction → administrator review → inclusion in a published revision.

The exact mechanism for selecting the initial photo location remains open. Explicit volunteer placement on the map is a useful starting point; AI can propose a location where context is incomplete. An image of a directional sign does not establish that the camera is at the room named on the sign. Similarly, visual adjacency does not establish a walkable connection.

LLM descriptions and relationship extraction are requirements of the proposed workflow. Whether those records alone can distinguish similar corridors is a test question. A comparison with image retrieval plus LLM verification may be useful, but should not silently replace the requested LLM workflow before evaluation.

### Priority collection experiment

Photo collection density, direction, and size are primary experiments, rather than assumptions to freeze now.

| Variable | Comparison to plan | Evidence to collect |
|---|---|---|
| Spatial density | Decision points only versus added samples along corridors; vary samples within a capture area | Missed locations, ambiguous segments, collection effort |
| View direction | One approach direction versus several relevant directions and reverse approaches | Recognition and correct guidance by approach direction |
| Image size and compression | Several controlled resolutions and compression settings | Sign readability, result quality, upload time, processing time, cost |
| Capture conditions | Different operators, sessions, lighting, modest position changes, and partial obstruction | Robustness beyond the reference collection session |
| Confusing scenes | Similar corridors, repeated room labels, wrong floors, and unsupported locations | Wrong accepts, appropriate rejection, and recovery effort |

Use separate reference, development, and final evaluation captures. Keep model and prompt settings fixed when comparing a collection variable. Select settings using development data, then assess them on fresh captures. Report counts alongside accepted precision, coverage, unknown-place false accepts, retakes, and latency. Numerical pass thresholds belong in the later acceptance plan.

## 7 Public visual localization and navigation

### Mobile application and Web API

Package the shared frontend with Capacitor for the mobile application. Capacitor supplies a native runtime and a plugin mechanism for device features. [Capacitor documentation](https://capacitorjs.com/docs)

The product also requires a backend Web API for map retrieval, photo submission, localization results, routing, and session updates. Packaging the frontend does not create that server API. The native app and a proposed browser fallback should use the same navigation services; device adapters handle differences in capture and sensor access.

### Localization workflow

The requested workflow combines scene recognition with building context from GPS and LLM-assisted matching. A proposed sequence is:

1. Use GPS and known building information to suggest candidate buildings, with manual correction available.
2. Establish or request floor context without treating building proximity as proof of the floor.
3. Associate a captured image with its capture time, active session, and map revision.
4. Analyze the image and match its evidence against the approved scene records and references for candidate locations.
5. Return an accepted location, ambiguity, rejection, or service error. Allow “no supported match.”
6. Plan the route through reviewed walkable connections and render the next instruction.

LLM matching should be constrained to supplied building and map evidence. It must not invent a building, room, or connection to complete an answer. Whether matching needs image retrieval, OCR, or additional verification remains an evaluation decision.

Keep **building identity, floor identity, map location, facing direction, and metric camera pose** separate. A recognized room or checkpoint may not establish the phone's orientation. If direction is unknown, show a reference landmark and ask the visitor to align before giving relative turn instructions.

A result describes the photograph at capture time. A later capture, destination change, or user movement can make it unsuitable for current guidance. Retain the last confirmed location during processing and prevent obsolete results from overwriting current state. If offline, cached maps and references can support explicitly labelled manual guidance; they do not establish a new visual location.

### Navigation development options

These are progressively more demanding options, not commitments to deliver every level during the event. Presentation improvements and localization improvements can be developed independently.

| Level | Experience | Additional work and evidence |
|---|---|---|
| N0 Manual capture and static guidance | Take a photo, recognize a checkpoint, and show the next landmark, reference scene, and 2D route | Demonstrate correct matching or rejection, direction confirmation, and physical arrival |
| N1 Animated guidance | Animate a turn or path on a static scene or schematic | Verify that animation communicates the intended instruction; screen-space animation must not imply geometric registration |
| N2 Sensor-assisted guidance | Use orientation or motion signals to update an arrow or estimated progress; pressure may support a floor-change hypothesis | Establish initial direction and map alignment; measure drift, missing-sensor behavior, and recovery |
| N3 Repeated frame localization | Sample camera frames and repeatedly recognize or re-localize the visitor | Bound sampling and concurrency; test stale results, noisy location changes, bandwidth, battery, and tracking interruptions |
| N4 3D map and registered guidance | Use a reconstructed indoor scene and camera pose to place guidance relative to the physical environment | Evaluate a suitable open-source reconstruction/localization pipeline, calibrate frames, align it to the map, and verify tracking loss and re-localization |

Android documents that gyroscopes measure rotation rate and pressure sensors measure ambient pressure; sensor availability varies by device. Those measurements are inputs to estimation, not direct room identifiers. The proposed sensor level therefore needs calibration and independent validation. [Android sensor overview](https://developer.android.com/develop/sensors-and-location/sensors/sensors_overview)

ARCore illustrates the extra machinery used for pose tracking: visual features and inertial measurements estimate camera position and orientation. For this project, aligning a tracking frame or reconstructed scene to the approved floor map remains separate work. Repeated LLM recognition alone does not demonstrate continuous geometric tracking. [ARCore fundamental concepts](https://developers.google.com/ar/develop/fundamentals)

## 8 Initial acceptance and regression design

The following checks translate the two requirement groups into observable outcomes. They are a starting point for the dedicated test plan, with no claim that the workflows already exist.

| Area | Initial acceptance evidence | Important failure or regression case |
|---|---|---|
| Role permissions | Volunteer edits and submits; administrator corrects, merges, rejects, and archives; visitor reads a publication | Volunteer or volunteer agent attempts an administrator action |
| Contribution review | Two contributions show their changes and starting versions | A second merge would overwrite the first; require reconciliation |
| Publication | Vector geometry, records, graph, and references activate consistently | A failed build or missing asset leaves the previous version available |
| Archival | Closing updates prevents further changes under the selected policy | An AI job completes after archival or a pending contribution attempts to merge |
| Raster standardization | Style is consistent and reviewed doors, boundaries, and labels are preserved | Generation adds a passage, changes a room number, or drops a doorway |
| Vectorization and editing | Output remains editable and linked to the correct records after save and reload | Re-vectorization disconnects photos, duplicates rooms, or destroys previous annotations |
| MCP operations | The three example commands produce the intended, attributable changes | Ambiguous north, wrong room count, conflicting website information, retry duplication |
| Scene ingestion | A real uploaded photo produces inspectable LLM records and reviewed map associations | A directional sign is mistaken for the camera location |
| Visual localization | Fresh supported photos localize correctly or request more evidence | Wrong floor, visually similar corridor, unsupported scene, delayed result |
| Guidance | A visitor follows verified connections to the destination | Correct node but wrong heading, unreachable destination, route deviation |
| Mobile delivery | The Capacitor app captures and uses the Web API on the intended phone | Permission denial, background/resume, interrupted upload, missing sensor |

Proposed progression is **workflow agreement → isolated capability trials → a small real contributor-to-visitor loop → target-route validation → optional navigation upgrades**. Infrastructure trials may use a separate minimal application. They establish deployment or device compatibility, not product or localization success.

Regression scope should follow the change: geometry or edge changes require route and association checks; prompt/model/reference changes require relevant extraction or localization evaluation; permission/version changes require review and publication tests; device changes require capture and lifecycle tests. Preserve known failure cases, and use fresh evaluation captures after tuning localization against earlier failures.

## 9 Review conclusions and meeting decisions

The largest uncertainties are whether map generation preserves useful geometry, whether scene records distinguish similar places, and whether the intended navigation level can provide justified direction information. The first small trials should address these uncertainties before committing to a large route or continuous tracking.

| Decision for the meeting | Proposed starting point | Why it matters |
|---|---|---|
| Mapping scope | One named building and floor, with a verified short route before expansion | Bounds collection, review, and navigation work |
| Meaning of merge and replacement | Retain history; publish a new consistent revision; reconcile stale contributions manually | Prevents silent loss of accepted work |
| Archive behavior | Close writes while retaining read-only navigation; confirm reopening and withdrawal rules | Separates closing development from disabling public use |
| Vector and structured data authority | Select one authoritative geometry representation and stable object links after a round-trip trial | Avoids divergence during AI and manual edits |
| AI editing behavior | Allow reversible draft edits; clarify ambiguity; keep administrator control over publication | Preserves editing speed and role boundaries |
| Reference collection | Prioritize density, direction, and image-size experiments | Determines volunteer workload and supported capture conditions |
| Minimum demonstration scope | Propose one volunteer contribution, one administrator correction and merge, real photo ingestion, and N0 navigation | Demonstrates all three roles and the shared product loop |
| AI demonstration depth | Decide which real generation, vectorization, MCP editing, and scene-analysis operations must be shown | Keeps manual recovery distinct from successful automation |
| Navigation ambition | Establish N0 first; select upgrades only after their individual tests pass | Protects time for measured reliability |

The next requirements documents can use three user journeys as their backbone: **administrator governance**, **volunteer contribution**, and **public navigation**. Shared architecture work then defines the boundaries between version management, map editing, AI workflows, scene data, localization, and guidance. Detailed schemas and task assignments should follow those decisions.
