# Indoor Navigation Acceptance Test Catalogue

**Status:** Designed cases, not executed results  
**Date:** October 16, 2026  
**Governing plan:** [Stage acceptance and test workflow](Indoor_Navigation_Acceptance_and_Test_Plan_EN.md)

This catalogue turns the agreed product direction into repeatable acceptance cases. Use the governing plan for stages, thresholds, datasets, defect handling, regression selection, and Definition of Done. The case identifiers are tracker references; they do not define API routes or database schemas.

For each case, reset or name the starting state, perform the action, compare every required outcome, and save a test run record. Where a row includes several variants, record each variant; one failure makes the case fail. Save before/after state for mutations and the input/output plus model and prompt identity for real AI runs. Do not replace a real-provider or physical check with a mock and report the same kind of pass.

**Execution modes:** D = deterministic component or integration check; R = real provider or service; U = UI inspection; H = physical device or field test. Combined modes mean that both forms of evidence are needed. Failure injection may use controlled doubles even when the corresponding success path requires a real service.

All cases are core unless marked **Conditional** or **Fallback**. Conditional cases become mandatory when their feature is enabled or claimed. Fallback cases must pass before that fallback is used. Assign execution and review to the owner placeholders in the plan. The case result starts as **Not run**.

**Current work allocation:** Stage 1 Map Platform leads are Erfang (frontend), Hamza (basic backend APIs), Eric (schema design and deployment/CI/CD), and Arjun (basic map-authoring AI, MCP and tool calling). Use the [Stage 1 assignment plan](Indoor_Navigation_Stage_1_Assignment_Plan_EN.md) for scope, cross-review and reassignment. Suite owner placeholders below remain stage-independent; later-stage assignments are still open. Stage 1 is not gate G1, and evidence for only the map portion of a multi-part case cannot pass the entire case. No expected result, test status or regression obligation changes with this allocation.

## 1 AUTH Identity and permissions

**Owners:** `{{PLATFORM_OWNER}}`, reviewed by `{{QA_LEAD}}`  
**Data:** D1  
**Stages:** Minimal real identity at G1; integrated roles at G2; complete baseline at G3

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| AUTH-01 Minimal authentication | D U | Log in with the selected real authentication mechanism, reload, log out, and attempt a protected action with the old session. Repeat with invalid credentials or an expired session. | Correct identity persists only while valid; logout/expiry prevents protected writes; failures are understandable. Record session behavior without credential values. |
| AUTH-02 Administrator and volunteer boundaries | D U | As volunteer, call publish, merge, reject, archive, and target-management operations directly as well as through the UI. Repeat authorized actions as the map administrator. | Backend rejects prohibited actions with no side effects; authorized actions work. Hiding buttons alone does not pass. |
| AUTH-03 Map ownership and private drafts | D | Use another map's administrator or unrelated contributor to read/write its private draft, submission, assets, and job results by changing object identifiers. | Access follows the declared map policy; no unintended cross-map write or private-data disclosure. Public publication access is tested separately. |
| AUTH-04 Public navigation sessions | D R U | Without a developer login, read a publication, create navigation context, submit a capture, and obtain its result. Try to inspect or confirm session A's private job through session B. | Public journey works; private jobs and confirmations remain scoped. A public user cannot edit the map. |
| AUTH-05 Session and request limits | D | Exhaust a test session's upload/job allowance, then create multiple guest sessions and reach the configured project cap. For cookie-based writes, exercise missing/invalid CSRF protection; test permitted and denied app origins. | Limits apply across sessions; excess requests are bounded and recoverable. Selected CSRF/CORS behavior permits real clients without exposing protected writes. |
| AUTH-06 Third-party login | R U H | **Conditional:** on the deployed origin, use the selected OAuth flow with two team accounts, denial, invalid callback/state, logout, and reload. Test app return only if native login is enabled. | Actual callbacks and session handling work; denial does not leave a partial login; private client secrets remain server-side. This case may be deferred while minimal real authentication is used. |

## 2 GOV Contribution and publication governance

**Owners:** `{{PLATFORM_OWNER}}`, `{{MAP_REVIEWER}}`  
**Data:** D1 and D3  
**Stages:** First accepted contribution at G2; complete suite at G3

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| GOV-01 Target and contribution creation | D U | Administrator creates a named building/floor target. Volunteer starts the first contribution, then a later contribution from an existing publication. Save, reload, and resume both. | Target identity, starting revision, contributor identity, and content are retained. Draft work does not alter the publication. |
| GOV-02 Review and correction | D U | Submit changed labels, geometry, and a reference association. Administrator compares before/after evidence, edits the submission, requests a further correction, and reviews the revised content. | Changes are inspectable; edits have attribution; feedback survives reload. Approval of an earlier state cannot authorize newly changed content. |
| GOV-03 Merge and replacement | D R U | Merge a valid submission and read the map as a fresh visitor. Inspect history and an existing navigation session. | Exactly one new consistent revision becomes current; prior revision remains identifiable. Existing sessions follow the chosen refresh policy, without mixed assets. |
| GOV-04 Rejection | D U | Reject a submission with a reason; reload it and try to publish through its previous approval/job state. | Rejection and reason persist; rejected content never becomes current. Any resubmission follows the defined review path rather than reusing stale approval. |
| GOV-05 Conflicting and concurrent updates | D | Two volunteers edit the same object from one base. Merge the first, then try the second; also attempt simultaneous publication. Reconcile and retry. | Outdated/conflicting work cannot silently erase accepted changes. Publication is serialized or equivalently protected; the reconciled result is reviewed explicitly. |
| GOV-06 Administrator correction of current map | D U | Administrator changes the latest map's room label or blocked edge, while a visitor reads the old revision. Publish the correction. | Editing creates a tracked draft/new revision; the old publication is not modified in place. The new revision shows the correction and attribution. |
| GOV-07 Archive and late work | D U | Archive a target with a draft, submitted contribution, and running AI job. Attempt UI/API/MCP writes, merge, and apply the late result. Read the last publication as a visitor. | Under the selected baseline, all writes/publication are blocked, pending work remains inspectable, and read-only navigation remains available with archive status. Test reopen permissions if implemented. |
| GOV-08 Failed publication and invalidation | D R | Fail index/asset preparation during merge; retry the request. Separately withdraw/invalidate an active revision and try to continue affected guidance. | Failed preparation leaves the prior complete publication active; retry cannot duplicate a release. Explicitly invalidated guidance stops and offers refresh/help. Save state and event evidence. |

## 3 MAP Geometry and structured map data

**Owners:** `{{APP_OWNER}}`, `{{MAP_REVIEWER}}`  
**Data:** D2 and D3  
**Stages:** Selected geometry approach at G1; core checks at G3; physical truth at G4

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| MAP-01 Source preservation and correction | D U | Import a scan and oblique photograph; rotate, crop, and correct perspective. Compare the source and corrected coordinates of known features. | Original remains retrievable; correction mapping is recorded; transformed overlays align. Reloading does not apply the transform twice. |
| MAP-02 Vector and record round-trip | D U | Save, export, reload/import a map with rooms, labels, nodes, edges, and references. Compare semantic content rather than file byte order. | Editable geometry and stable associations survive; no missing IDs, duplicate objects, broken references, or conflicting geometry copies. Export identifies required external assets. |
| MAP-03 Manual editor behavior | D U | Pan/zoom; select, move, add/delete nodes; create/delete/reverse edges; edit paths, labels, costs, and annotations. Undo a supported draft edit and reload. | Changes apply to intended objects and persist. Unrelated geometry stays unchanged; invalid deletion or orphaned links are rejected or explicitly repaired. |
| MAP-04 Coordinate and orientation integrity | D U | Use a non-square plan, rotate the display, and inspect known landmarks. Issue a north-based selection with known and unknown north. Request distances with and without calibration. | Aspect ratio and coordinate frames remain correct; unknown north is not guessed. Precise metric distance/ETA is absent without verified scale. |
| MAP-05 Topology validation | D | Load duplicate IDs, missing endpoints, negative weights, a disconnected destination, reversed/closed edges, and a path cutting through a wall. | Structural errors block publication or routing appropriately. Human geometry review catches physically invalid paths beyond automated graph checks. |
| MAP-06 Spatial record consistency | D U | Change a room number/purpose and its geometry association; delete or replace a linked object. Search the destination and preview its reference. | Labels, records, search, and references agree; unresolved associations are visible and cannot silently pass publication. Track source provenance for factual attributes. |
| MAP-07 Physical map validation | H U | Walk every demonstration edge and critical doorway with the source and current vector map. Verify target labels and the destination. | Reviewed geometry reflects actual passability and labels; closures are recorded. Every critical turn has a verified instruction and reference where required. |

## 4 AI Bitmap standardization and vectorization

**Owners:** `{{AI_OWNER}}`, reviewed by `{{MAP_REVIEWER}}`  
**Data:** D2 and D8  
**Stages:** Real capability trials at G1; full editing workflow at G3

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| AI-01 Bitmap standardization | R U | Run the selected GPT Image 2.5 workflow on the clean, oblique, and difficult plan fixtures with the specified style. Repeat a representative input three times. | Outputs and failures are preserved; style can be inspected; differences in critical doors, walls, and labels are flagged and cannot silently become approved geometry. Record model/settings, duration, and correction effort. |
| AI-02 Editable vector generation | R D U | Feed a reviewed standardized bitmap to the real coding/vectorization workflow. Parse and render the result, edit an object, save, and reload. | Output follows the selected allowed vector structure, remains editable, and has stable object links. Invalid structure or executable content is rejected or safely normalized before use. |
| AI-03 Structured extraction | R D U | Extract room labels and spatial details from known fixtures including unreadable text and repeated labels. Compare with ground truth. | Correct supported values link to the right objects; uncertainty and conflicting labels remain explicit; no invented identifier is accepted as verified data. |
| AI-04 Natural-language re-edit | R U | Request a local appearance change, then a structural correction; rerun bitmap/vector stages as appropriate on a map with existing annotations and photos. | Intended changes are previewable; unrelated changes are identified; previous links survive or require explicit reconciliation. Prior draft/publication remains recoverable. |
| AI-05 Failure and retry | D R U | Inject invalid output, provider timeout/429, partial completion, and a retry; make a manual edit while generation is pending. | Waiting terminates within the run's deadline; retry is bounded; errors preserve useful inputs. A late or duplicate result cannot overwrite newer work or publish automatically. |
| AI-06 Useful automation and publication | R U | Complete one genuine bitmap-to-vector-to-records workflow, correct identified issues, and submit it for review. Compare a bounded task's AI-assisted effort with manual completion. | A usable editable contribution results; critical errors are resolved before publication. Report generated errors, corrections, and elapsed time separately; claim faster development only if measured. |

## 5 MCP Natural-language map operations

**Owners:** `{{AI_OWNER}}`, `{{APP_OWNER}}`; permissions reviewed by `{{PLATFORM_OWNER}}`  
**Data:** D1, D2, D4, and D8  
**Stages:** An initial real command at G2; all required commands and boundaries at G3

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| MCP-01 Tool coverage and parity | D R U | Inventory supported editor parameters and operations, including image workflow settings, annotations, node/edge edits, and photo bindings. Perform representative equivalents through UI and agent tools. | MCP can express the declared editing capabilities with the same validations and permissions. Missing core operations remain tracked, not marked not applicable. |
| MCP-02 Sequential room numbering | R D U | On the 51-room north-side fixture, request left-to-right numbering 4000–4050. Repeat with a different selected count, rotated display, unknown north, and unspecified numbering increments. | Clear request produces exactly the intended 51 labels in map-relative order. Ambiguities/count conflicts cause clarification; no room is invented and unrelated labels remain unchanged. |
| MCP-03 Website enrichment | R D U | Supply the controlled accessible webpage; match building/floor/room records and populate purposes. Repeat with duplicates, contradictory entries, unavailable page, and instruction-like text embedded in content. | Matching facts retain source attribution; conflicts/unmatched rooms remain unresolved; fetch failure preserves data. Page content cannot grant permissions or redirect the agent into unrelated actions. |
| MCP-04 Room vertices | R D U | Ask for one vertex per room, repeat the same command, and inspect a room with two entrances and one with unknown connectivity. | Creates/reuses one room-linked destination vertex per intended room without duplicates; doorway and corridor routing connections are reviewed separately. No invented walkable edge. |
| MCP-05 Batches and undo | D R U | Apply a multi-object annotation/edge update; inject failure partway through; retry and undo where supported. | Atomic application or explicit partial status matches the documented behavior; completed work is attributable; retry does not duplicate edits; undo does not corrupt later work. |
| MCP-06 Permission and revision boundaries | D R | Use a volunteer's agent to merge/archive or edit another map. Complete an AI edit after a newer manual edit, rejected submission, or archive. | Same backend restrictions as the UI; rejected/stale actions have no unauthorized side effects. Logs identify the acting role and target version. |
| MCP-07 Bounded workflow behavior | D R U | Request an impossible selection, an unsupported edit, and an iterative image repair that reaches its call/time budget. | Agent explains the unresolved operation, preserves the draft, and stops at limits; no invented success or indefinite tool loop. Save the transcript and resulting map diff. |

## 6 REF Scene collection and relationship records

**Owners:** `{{AI_OWNER}}`, `{{MAP_REVIEWER}}`, `{{FIELD_TESTER}}`  
**Data:** D5–D8  
**Stages:** Real ingestion at G2; consistency at G3; collection experiment at G4

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| REF-01 Real photo ingestion | R D U | Upload real checkpoint photos with location, direction, and session context; run the LLM scene workflow and reload its records. | Original photo and context remain associated; observable labels/landmarks and proposed relationships are inspectable, attributable, and reviewable. |
| REF-02 Relationship correctness | R U | Use a sign pointing to a distant room, repeated door labels, a nearby visible room, and an ambiguous viewpoint. Compare the generated JSON-like records with ground truth. | Camera location, visible objects, and directions-to-other-places are distinct. Uncertain relationships do not become verified walkable connections. |
| REF-03 Human correction and map updates | D U | Correct a photo's node/view association; change or remove the linked map object; rerun extraction. | Current associations are consistent; obsolete derived records are invalidated or reconciled. Old publication remains stable until a complete new one is accepted. |
| REF-04 Gallery and derived-data compatibility | D R | Build the selected reference representation/index, restart and reload it, then attempt to mix an old model/preprocessing profile or map revision. | Compatible data reproduces retrieval/lookup behavior; incompatible data is rejected or rebuilt. If embeddings are used, gallery and query configuration match. |
| REF-05 Collection experiment and split audit | R H | Execute the density, direction, and image-size comparisons from the plan; audit session IDs, near-duplicates, panorama crops, and held-out sets. | Findings identify a supported collection policy with measured tradeoffs. Reference or tuning images do not masquerade as independent final queries. |

## 7 LOC Visual localization and evaluation

**Owners:** `{{AI_OWNER}}`, independently checked by `{{FIELD_TESTER}}` and `{{QA_LEAD}}`  
**Data:** D5–D8  
**Stages:** Genuine matching at G1/G2; rejection/state behavior at G3; independent metrics at G4

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| LOC-01 Fresh supported captures | R H | Capture new images at declared checkpoints and supported capture zones, including every critical turn and reverse approaches included in scope. | Correct location or explicit uncertainty/rejection; record per-checkpoint outcomes and counts. Reference-image reuse cannot pass this case. |
| LOC-02 Building and floor context | D R H | Supply useful, imprecise, missing, and denied GPS; include nearby buildings and repeated room labels on different floors. Correct a suggested building manually. | Suggestions stay within supplied evidence; GPS alone does not establish an indoor floor. Wrong context is recoverable; manual context is recorded separately from visual recognition. |
| LOC-03 Ambiguous candidates | D R | Present similar corridors and multiple reference photos of one node competing with a different node. If using retrieval, inspect distinct-node ranking and margin logic. | Ambiguity is assessed between locations rather than duplicate images; uncertainty can be returned. Similarity or an LLM's asserted confidence is not presented as a calibrated probability without calibration evidence. |
| LOC-04 Unsupported and misleading views | R H | Run the preregistered unsupported set: wrong floor/building, unrelated room, outside-map scene, and misleading directional sign. | No unsupported photo receives an accepted location in the final rejection set. Save every outcome; a sign's destination is not automatically the camera location. |
| LOC-05 Capture quality | D R H | Test corrupt image, rotation, small sign, blur, low light, overexposure, obstruction, ceiling/floor framing, and a sharp low-texture wall. | Unreadable inputs fail usefully; weak evidence prompts an appropriate retry. Quality checks do not confuse low texture with proven blur or claim obstacle avoidance. |
| LOC-06 Latency and reliability | R H | Execute the declared warm and cold cohorts, using real processing and recording upload, queue, inference, verification, polling, errors, and retries. | Meet the plan's targets on claimed profiles or record a failed target. Preserve failures/timeouts and sample sizes; separate latency evidence from independent accuracy evidence. |
| LOC-07 Heading and pose boundaries | D R H | Obtain a correct node with unknown heading; capture opposite views from the same node; request a direction-dependent instruction. | Location, direction, and pose remain distinct. Unknown direction triggers landmark alignment or confirmation; no metric pose or registered arrow is inferred solely from node recognition. |
| LOC-08 Frozen final evaluation | R H | Freeze the candidate, run all D7 inputs without tuning, and calculate precision, coverage, correct coverage, false accepts, and critical-turn errors. | Metrics and numerators/denominators meet the declared gate. All failures remain listed. Tuning after this run invalidates affected final evidence and requires fresh evaluation. |

## 8 NAV Routes and static guidance

**Owners:** `{{APP_OWNER}}`, `{{MAP_REVIEWER}}`; routing implementation owner assigned later  
**Data:** D3, D5, and target route  
**Stages:** Small route at G2; constraints at G3; real-route acceptance at G4/G5

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| NAV-01 Route computation | D | Compute routes on directed, weighted graphs with alternative equal-cost paths, closures, reversed edges, and unreachable destinations. Include invalid negative costs. | Route uses only valid allowed edges and a consistent cost unit; unreachable/invalid requests have explicit outcomes. No wall-crossing shortcut or arbitrary route is invented. |
| NAV-02 Directions and landmarks | D U H | At each critical turn, compare accepted location, confirmed facing direction, outgoing edge, reference image, arrow, and instruction; repeat the reverse approach. | All representations agree with the physical route. Relative turns require verified direction; static graphics are labelled appropriately when schematic. |
| NAV-03 Preview and manual confirmation | D U | Preview the next reference/checkpoint, then manually confirm progress and arrival. Compare state before and after each action. | Browsing does not move the visitor. Manual confirmation is explicit and distinguishable from visual recognition; no accuracy metric counts it as a successful visual fix. |
| NAV-04 Deviation and restart | R H | Walk a short wrong branch, turn back, and restart the app mid-route. Capture at an unexpected but supported location. | Valid new evidence can override route expectation; route is recalculated from an accepted/explicitly confirmed position. Unknown places are not forced onto the expected next node. |
| NAV-05 Destination and revision changes | D R U | Change destination during localization; publish a new map during navigation; request refresh; attempt a route with incompatible revision data. | Old results do not overwrite the new journey; refresh recalculates consistently; mismatch is rejected or resolved explicitly. |
| NAV-06 Floor transitions and step-free modes | D H | **Conditional:** traverse a verified stair/elevator connector, test wrong-floor confirmation, and request step-free routing with unknown or stair-only connectivity. | Correct floors and verified connectors are used; unknown access is not labelled step-free. No permitted route yields a clear unavailable result. Test all transitions included in the demo. |

## 9 APP Mobile capture and visitor experience

**Owners:** `{{APP_OWNER}}`, `{{FIELD_TESTER}}`  
**Data:** D5 and D8; intended Android phone; selected fallback browser  
**Stages:** Camera trial at G1; integrated experience at G3; actual presentation setup at G5

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| APP-01 APK and shared Web API | R H | Install the named Capacitor APK, verify its API origin/build identity, capture a real image, and complete a route request. Update the APK using the intended signing identity. | Installed app reaches the intended service and remains usable after update. Build success alone is insufficient; record installed artifact and actual device. |
| APP-02 Permission and capability states | U H | Deny then grant camera permission; leave a permission request pending; test unavailable sensor/focus controls and denied location permission. | UI explains the state and offers recovery; required capture works after grant. Optional hardware absence does not block N0; no false claim of available capability. |
| APP-03 Image fidelity and preview | R H | Capture rear-camera views in portrait/landscape with small labels; compare preview crop, encoded image, rotation, compression, and uploaded bytes. Keep preview active during inference. | Server receives the intended upright view; important detail survives selected processing; UI stays responsive and only one camera owner is active. |
| APP-04 Lifecycle and repeated use | R H | Perform three cold app starts, twenty successive captures, background/resume, screen lock/unlock, camera-screen exit/return, and interrupted capture. | No crash, camera leak, duplicate active preview, stale overwrite, or indefinite spinner. Resume either recovers the valid job or requests a fresh capture. |
| APP-05 Offline and network transitions | R H | Preload owned route assets; lose network, cross Wi-Fi/cellular or hotspot, encounter an unavailable/captive network, and interrupt an upload. | Cached guidance and last-confirmed time remain clear; bounded recovery works; moving after capture requires fresh confirmation. Network status alone is not treated as proof of API reachability. |
| APP-06 HTTPS browser fallback | R H | **Fallback:** run the same capture/localize/route flow in the intended phone browser, with permission denial, reload, and tab background/resume. | Browser path has its own passing device and security-context evidence. It does not count as APK acceptance. |
| APP-07 UI states and presentation visibility | U H | Inspect contributor and visitor loading/empty/error/offline states, long labels, narrow screen, one-handed capture, retry controls, and the projected camera preview during screen sharing. | Controls and state are readable; preview versus confirmed position is distinguishable; the audience actually sees the intended camera/result surface. No essential control is hidden or unusable. |

## 10 JOB Asynchronous processing and recovery

**Owners:** `{{PLATFORM_OWNER}}`, `{{APP_OWNER}}`, `{{AI_OWNER}}`  
**Data:** D8 plus real successful job examples  
**Stages:** Basic async behavior at G2; complete failure suite at G3

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| JOB-01 Duplicate submission | D R | Repeat the same capture/upload/publish request after a lost response; retry while processing and after completion. | Logical operation is deduplicated according to its identity; one publication/result association is retained. Record any unavoidable provider work rather than promising universal exactly-once execution. |
| JOB-02 Out-of-order results | D U | Delay capture A, submit B, then return A after B. Repeat with destination change, cancellation, map refresh, and explicit user movement. | Incompatible results cannot become current guidance. Last confirmed location remains available; movement or stale context triggers a new capture where needed. |
| JOB-03 Dispatch failure | D R | Commit a job while the broker is unavailable or fail dispatch after the database transaction. Restore connectivity and run the bounded recovery path. | Dispatch failure is visible; job does not remain silently queued forever; recovery does not duplicate publication or authorized state changes. |
| JOB-04 Worker crash and repeated delivery | D R | Stop the worker during execution, expire the job lease/deadline, restart, and simulate repeated delivery. | Persistent state reaches a defined retry or terminal outcome; idempotent result handling prevents corrupt/duplicate writes. Repeated provider cost is recorded if incurred. |
| JOB-05 Deadlines and cancellation | D R U | Trigger provider timeout, 429, decode failure, user cancellation, and a late provider success after deadline. | Retry count and original deadline bound work; visible waiting ends; terminal reason is useful. Late completion cannot overwrite a newer edit/capture or bypass archive/rejection. |
| JOB-06 Contention and resource bounds | D R | Run representative indexing/map jobs while multiple sessions localize; reach the configured worker and project limits. | Intended demo load remains within declared bounds or gets a clear busy/retry result. Readiness and queue delay are observable; no unbounded backlog or hidden model reload per request. |

## 11 OPS Delivery and operational readiness

**Owners:** `{{PLATFORM_OWNER}}`, `{{RELEASE_OWNER}}`  
**Data:** Independent trial app, disposable staging deployment, selected release data  
**Stages:** Independent evidence at G1; product evidence at G3; final identifiers and restore readiness at G5

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| OPS-01 Clean setup and configuration | D R | Start from a clean checkout using selected lockfiles and documented setup. Remove one required configuration value. Inspect distributed frontend/APK assets and logs for seeded test secrets. | Reproducible build/startup; missing configuration fails clearly without secret values. Only public configuration is distributed. Record versions and setup time. |
| OPS-02 Independent deployment path | R H | Deploy the minimal page/API/database/image/job application separately; reach it over public HTTPS from phone Wi-Fi and cellular/hotspot. | Public entry, persistence, worker completion, and actual phone connectivity work without map/navigation features. Save the repeatable procedure and release identifier. |
| OPS-03 CI and artifact identity | D R | Introduce a controlled build/test failure, then fix it; build and deploy a commit-tagged candidate, serialize deployment, and install its APK. | Broken checks prevent promotion; Web/API/worker/APK identities are traceable; concurrent deployment cannot produce an unidentifiable mixture. |
| OPS-04 Routing and readiness | D R H | Exercise API errors, frontend deep links, auth/admin/static routes where used, APK preflight, unavailable DB/worker/index, and cold model startup. | API errors do not turn into SPA HTML; required assets load; readiness distinguishes an alive process from a usable service. Invalid origins fail while the real app origin works. |
| OPS-05 Persistence and backup restore | R | Store a reviewed draft, publication, photos, and job records. Restart/redeploy containers or services. Restore a backup into an isolated environment and read the restored map/reference set. | Required data survives restart/redeploy; restore recovers a consistent documented state and usable assets. A backup file's existence alone does not pass. |
| OPS-06 Release rollback and migration | R | In staging, promote a candidate with a controlled failure, then restore the last compatible application release. For schema changes, exercise the documented compatible migration or backup recovery path. | Recovery returns a known coherent build/data combination. Application rollback is not mistaken for automatic reversal of database changes. Record recovery duration and data consequences. |
| OPS-07 Observability and bounded operation | D R | Trace one successful and one failed request through client, API, worker, and provider; exercise configured upload/job/spending limits and test-data retention behavior. | Relevant capture/job/build/map/model identities and timings are available without secrets; usage and failures are counted; limits stop additional work as intended. Evidence required for acceptance remains retained. |

## 12 EXT Conditional navigation enhancements

**Owners:** `{{APP_OWNER}}`, `{{AI_OWNER}}`, `{{FIELD_TESTER}}`  
**Data:** Relevant core packs plus extension-specific ground truth  
**Stage:** GX, followed by affected G4/G5 checks

All cases in this section are **Conditional**. Disabled features do not block core acceptance. Features shown in the demonstration cannot bypass these gates by being called experimental; instead, present a clearly separate experiment with its measured limitations.

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| EXT-01 Directional-photo and panorama tour | D U H | Browse linked references, follow forward/reverse hotspots, select a route branch, and return to the last confirmed checkpoint. Test the actual panorama format. | Links match reviewed outgoing edges and view orientation; browsing does not update physical location. Panorama annotations are not blindly copied onto a fresh camera image. |
| EXT-02 Animated guidance | U H | Render animations for each supported turn and reverse approach; compare with static guidance and actual facing direction. | Animation communicates the correct route and does not imply world registration when schematic. Disabling it preserves N0 behavior. |
| EXT-03 Sensor-assisted motion and floor hints | R H | Calibrate the actual device; test standing turns, walking, walking backward, drift, absent sensors, and known stair/elevator movement where enabled. | Progress is labelled estimated and constrained to evidence; uncertainty stops advancement and prompts confirmation. A pressure change does not silently assign an unverified floor. |
| EXT-04 Automatic frame sampling | D R H | Enable the selected cadence during walking, stop/pause it, delay results, lose network, and move between similar scenes. | Sampling respects consent/control, concurrency, battery/network budget, and stale-result rules; no uncontrolled call loop or unsupported location oscillation. Quantitative settings are recorded before the run. |
| EXT-05 3D reconstruction and registered guidance | R H | Use the chosen open-source/reconstruction pipeline and an independently checked scene/map alignment. Measure pose and arrow placement at known checkpoints; lose and recover tracking. | Observed error meets a tolerance declared before the trial; arrows stay on intended physical route segments; tracking loss removes misleading overlays. Record reconstruction provenance, calibration, and actual limits. A 3D model alone does not pass localization. |
| EXT-06 Outdoor integration | R H | Open entrance navigation via the selected Maps handoff or embedded map; deny GPS; simulate proximity without entering; enter and leave indoor mode. Test enabled API requests/restrictions if embedded. | Handoff reaches the intended entrance; proximity is a suggestion, not proof of entry. Explicit indoor state survives GPS drift. Only enabled services are claimed and tested. |
| EXT-07 Disable and recover | D R H | Disable each enabled extension during its failure state and resume the core route. If an observer page exists, inspect it while navigation proceeds. | N0 guidance and confirmed state remain coherent. An observer cannot secretly alter the walker's location. Rerun the affected core smoke and guidance cases after feature switching. |
| EXT-08 Semantic obstruction and scene suitability | R H | If enabled, classify views with a person, column, partial landmark obstruction, plain wall, and clear reference scene; include both usable and unusable views. | Measure classification errors and useful retry behavior. Optional obstruction recognition cannot silently alter graph walkability or claim reliable pedestrian obstacle avoidance; any approved closure follows map review. |

## 13 E2E Product acceptance and release

**Owners:** `{{QA_LEAD}}`, `{{FIELD_TESTER}}`, `{{RELEASE_OWNER}}`  
**Data:** Small integrated fixture first, then the real target route  
**Stages:** G2 through G5

| Case | Mode | Setup and action | Expected result and evidence |
|---|---|---|---|
| E2E-01 Small real contributor-to-visitor loop | R U H | Administrator opens target; volunteer uploads a plan, uses real AI bitmap/vector processing, edits through MCP, uploads real scene photos, and submits. Administrator corrects and merges. Visitor captures fresh evidence and follows the small route. | Same accepted revision connects all three roles. Real AI outputs, review evidence, phone result, and physical arrival are recorded. A mock or manually selected location is not substituted for visual success. |
| E2E-02 Update under active use | D R U H | Keep a visitor on revision A while a volunteer proposes B; administrator requests correction, rejects one proposal, then merges a valid alternative. Refresh the visitor; separately archive the target. | Active and new sessions remain coherent; feedback/rejection/merge history is visible; the visitor sees B only under the selected refresh policy; archival blocks updates as specified. |
| E2E-03 Independent target-route walk | R H | A tester who did not prepare the reference walk uses the declared capture conditions to navigate the full selected route, with a short deviation/turn-back and a fresh localization. | Destination is reached with zero confidently wrong critical instruction; all retakes, manual confirmations, outside coaching, and service failures are recorded. Outside coaching is a failed unaided segment even if the walk eventually finishes. |
| E2E-04 Final rehearsal and handoff | R H U | Run three complete final-candidate rehearsals across at least two operators with the actual sharing arrangement; verify the release packet and replay the labelled backup video. | Route and presentation fit the actual allowance; evidence identifies one coherent candidate. Required gates pass or reduced scope is explicit. Another teammate can find setup, recovery, artifacts, metrics, and known limitations. |

## 14 Suggested execution order

1. At G0, adopt the scope/defaults, map responsibilities to placeholders, prepare fixtures, and link each case to its source requirement. No product case is passed during planning.
2. At G1, prioritize OPS-01/02, AUTH-01, APP-01/02/03, AI-01/02, REF-01, a tiny NAV-01 graph, and a genuine LOC-01 trial. Record unresolved blockers early.
3. At G2, run E2E-01 with the smallest real dataset, GOV-03, JOB-02, and a rejection/retry case. Capture the first coherent working candidate.
4. At G3, complete the remaining core cases, including all governance/MCP failure paths. Automate deterministic checks where they protect important behavior; use targeted manual checks for reversible visual edits.
5. At G4, finish physical review and collection experiments, freeze settings, then run LOC-08, LOC-06, and E2E-03 on the target conditions.
6. Run applicable EXT cases independently after a stable core. Repeat affected regression and route evidence before including the enhancement in the release.
7. At G5, execute E2E-04 and review every core case's latest applicable result. Failures and blocked/not-run cases cannot be hidden in a total pass percentage.

Use the governing plan's record templates for execution. The catalogue is complete as a test design baseline; its results remain unproven until the application, fixtures, and real environments are available.
