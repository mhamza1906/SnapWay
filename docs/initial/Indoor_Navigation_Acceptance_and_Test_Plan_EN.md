# Indoor Navigation Stage Acceptance and Test Plan

**Status:** Planning baseline for implementation and team review  
**Date:** October 16, 2026  
**Execution status:** Tests are designed but have not been executed  
**Companion:** [Executable test catalogue](Indoor_Navigation_Test_Catalog_EN.md)

This plan defines how the team will demonstrate that map administration, volunteer contribution, AI-assisted editing, and public visual navigation work together. Progress is determined by recorded evidence at stage gates. A build, plausible AI response, or completed screen alone does not satisfy a user workflow.

The sources are the [stakeholder and workflow review](Indoor_Navigation_Stakeholders_and_Workflows_Review_EN.md) and the [archived initial detailed plan](archive/Indoor_Visual_Navigation_Detailed_Plan_EN.md). The latest requirements take precedence: administrator and volunteer roles are distinct; the GPT Image 2.5 bitmap workflow, AI vectorization, MCP editing, and LLM scene records are core product capabilities. The initial plan's classification of AI map assistance as optional no longer governs those capabilities. Authentication follows the subsequent decision: establish permissions first, use real minimal authentication early, and add third-party login later if selected.

The scope here is acceptance and testing. APIs, database fields, MCP tool signatures, and implementation architecture remain unfrozen. Test-record examples describe evidence, not application schemas. Stage gates use dependencies rather than calendar dates or a promise to finish integration in four hours.

## 1 Release scope and acceptance policy

### Core baseline

The proposed full baseline includes one named building, one verified floor, and an initially short route expanded toward the original approximately 200-metre demonstration target. Measure and record the actual route; do not label a shorter route as 200 metres. Include at least one real navigation decision point. Additional floors require their own transition tests.

The full baseline demonstrates:

1. An administrator creates a mapping target and manages submissions, corrections, merges, rejection, and archival.
2. A volunteer contributes to a new or existing map using real source imagery, AI bitmap standardization, vectorization, structured information, manual editing, and MCP editing.
3. Real scene photographs produce inspectable LLM descriptions and relationships linked to reviewed map locations.
4. A consistent publication becomes available without exposing drafts or partially updated data.
5. A public user uses the Capacitor Android app and backend Web API to capture a fresh photo, localize or receive a useful rejection, obtain a valid route, and reach a destination using static guidance.
6. The selected deployment, persistence, asynchronous processing, and recovery paths work on the intended device and network.

The HTTPS browser is a separately tested fallback. Animated guidance, reference tours, sensor assistance, repeated frame localization, 3D registration, embedded outdoor maps, and extra route modes are conditional extensions. Every enabled or demonstrated extension must pass its applicable tests.

### Product decisions used by the tests

Use these proposed defaults until the team records a different decision. A change updates the affected cases before they are run; it does not retroactively turn a failure into a pass.

| Topic | Test baseline |
|---|---|
| Map authority | Administrator authority is scoped to the assigned map or target; a volunteer cannot publish or archive it |
| Public access | Published maps and navigation do not require a developer account; costly jobs and their results have scoped session access |
| Replacement | A merge activates a new revision and retains earlier history; administrator corrections also create a new revision |
| Conflicts | A contribution based on an outdated revision requires explicit reconciliation; no silent last-write-wins merge |
| Archival | Close editing, submission, merge, and publication, including late AI writes; retain the latest map for read-only navigation |
| Reopening | Optional; if implemented, only an authorized administrator can reopen and it must be tested |
| Active navigation | Stay on one consistent revision until explicit refresh; never mix an old route with new geometry |
| Urgent invalidation | If the selected revision is withdrawn or a route is explicitly invalidated, stop affected guidance and request refresh or assistance |
| Geometry authority | Choose one authoritative representation during G0; vector and structured data must round-trip without contradictory geometry |
| Unknown direction | Use landmark alignment or reference selection before issuing relative left/right instructions |

### Result states

Individual tests use **Not run**, **Blocked**, **Pass**, **Fail**, or **Not applicable**. Not applicable requires a reason and a disabled or excluded feature. A case with several required assertions passes only when every assertion passes.

Stage decisions use **Pass**, **Blocked**, **Fail**, or **Reduced-scope demo approved**. The last state records a release decision, not a full product pass. Keep the unmet tests visible.

No scope exception can permit unauthorized publication, silent data loss, inconsistent published assets, or known confidently wrong instructions at a critical turn. A backup video, mock response, manual location selection, or browser fallback must retain its actual classification.

## 2 Responsibilities and evidence ownership

### Current allocation: Stage 1 — Map Platform

| Workstream | Current lead |
|---|---|
| Frontend | Erfang |
| Backend — basic APIs | Hamza |
| Database schema design and deployment/CI/CD | Eric |
| Basic AI pipelines — image generation, vector building, MCP and tool calling | Arjun |

This allocation applies only to Stage 1 Map Platform work; navigation AI pipelines and all later-stage assignments remain placeholders. It records agreed responsibilities, not completed implementation or accepted tests. Following the team's XP approach, teammates may cross-review, pair and reassign tasks at any time, preserving a clear current owner and handoff. See the [Stage 1 assignment plan](Indoor_Navigation_Stage_1_Assignment_Plan_EN.md) for boundaries and coordination.

**Stage 1 is not acceptance gate G1.** G0–G5/GX criteria, test data, thresholds, defect/blocker rules, regression triggers and DoD remain unchanged. Map Platform evidence contributes to applicable cases; it cannot pass unexecuted navigation, device or field requirements.

### Acceptance responsibility placeholders

These placeholders are responsibilities, not additional headcount or a global mapping to the Stage 1 names above. Four people can hold several roles. Later-stage ownership and unassigned acceptance/review roles stay placeholders until explicitly allocated. Wherever practical, someone other than the implementer checks a release-critical result.

| Placeholder | Responsibility |
|---|---|
| `{{PRODUCT_OWNER}}` | Scope, supported conditions, requirement decisions, and disclosed demo reductions |
| `{{QA_LEAD}}` | Case selection, traceability, evidence completeness, regression scope, and gate report |
| `{{MAP_REVIEWER}}` | Ground truth, map fidelity, physical passability, and publication review |
| `{{AI_OWNER}}` | Generation, vectorization, MCP, scene extraction, localization experiments, and model records |
| `{{APP_OWNER}}` | Contributor and visitor interfaces, capture, navigation state, device behavior |
| `{{PLATFORM_OWNER}}` | Identity, permissions, jobs, persistence, deployment, and recovery |
| `{{FIELD_TESTER}}` | Independent photo collection and real-route operation |
| `{{RELEASE_OWNER}}` | Tagged release, configuration record, rollback readiness, and final release decision |

Each test run has an executor, an evidence link, and a reviewer where required. Gate owners may request fixes; gate approval is supported by recorded tests rather than verbal confidence.

Each member prepares their own task prompts; there is no centralized Prompt handbook/preparation deliverable. Product workflow prompts still retain the versions, evidence, validation and regression obligations specified in this plan.

## 3 Stage gates

Work on independent modules may proceed in parallel. A failed prerequisite prevents acceptance of dependent behavior, but does not stop unrelated design or fixture-based development.

| Gate | Entry condition | Required exit evidence | Accountable roles |
|---|---|---|---|
| G0 Scope and test readiness | Current requirements available | Selected scope and defaults; requirement-to-test coverage; ground-truth method; environments and test identities; approved evaluation protocol; initial thresholds recorded | `{{PRODUCT_OWNER}}`, `{{QA_LEAD}}` |
| G1 Independent capability and infrastructure trials | G0 decisions sufficient for each trial | Separate minimal deployment reachable from the phone; real minimal auth; persistence/restart check; installed camera trial; real outputs from bitmap, vectorization, scene analysis, and localization trials; measured limitations | `{{PLATFORM_OWNER}}`, `{{APP_OWNER}}`, `{{AI_OWNER}}` |
| G2 Small real product loop | Selected G1 dependencies usable | A real volunteer contribution passes administrator correction and merge; fresh real capture uses the resulting publication and reaches a destination through a small graph; one reject/retry and one late-result case work | `{{QA_LEAD}}`, all module owners |
| G3 Core feature and failure acceptance | G2 repeatable on a named build | All core catalogue cases pass, including the three MCP examples, version conflicts, archival, artifact round-trip, scene review, routing, permissions, and recovery; no unresolved blocker or major core defect | `{{QA_LEAD}}`, `{{MAP_REVIEWER}}` |
| G4 Target route and quantitative validation | G3 candidate and collection settings frozen | Independent target-route evaluation meets the declared metrics; physical route verified; real network/device checks; field issues reproduced and resolved; supported conditions documented | `{{FIELD_TESTER}}`, `{{AI_OWNER}}`, `{{QA_LEAD}}` |
| G5 Demonstration release | G4 and applicable extension gates pass | Three complete rehearsals by at least two operators on the final candidate; verified screen sharing; release packet, backup recording, and rollback record; no critical wrong instruction | `{{RELEASE_OWNER}}`, `{{QA_LEAD}}`, `{{PRODUCT_OWNER}}` |
| GX Extension acceptance | Stable core and isolated extension trial | Applicable extension cases pass; enabling and disabling the extension preserve core behavior; affected G4/G5 checks repeated | Extension owner, `{{QA_LEAD}}` |

**G1 boundary:** a minimal page, upload, database write, or provider call proves only that isolated path. Generic scene data is acceptable for plumbing, but cannot pass target-building localization acceptance.

**G2 boundary:** use at least two reference checkpoints and one destination, with enough graph structure to verify a turn or branch. Use real service outputs and server-side permissions. G2 proves the small loop; it does not imply that every AI edit or the whole target route is accepted.

**G3 boundary:** all specified core AI operations need real successful runs on declared fixtures, plus controlled failure tests. Manual repair may establish publishable map correctness, but cannot replace evidence that the automation itself performs the requested operation. A failure to meet that requirement remains a failed capability or a disclosed scope reduction.

**G4 boundary:** freeze build, publication, reference manifest, model/prompt configuration, and rejection settings before final evaluation. The latest passing record must match the candidate presented at G5.

## 4 Test environments and data

### Environment progression

| Environment | Purpose | Valid evidence |
|---|---|---|
| Local fixtures | Fast deterministic tests of permissions, geometry, jobs, state transitions, and errors | Component and integration correctness with controlled inputs |
| Independent trial application | Verify dependencies, credentials, HTTPS, storage, worker, provider access, and device packaging | Technical readiness; separate from the real project's acceptance |
| Shared staging application | Exercise the real contributor-to-visitor product and injected failures | Integrated behavior on a named build with test accounts and data |
| Field and release candidate | Evaluate the intended building, phone, network, route, and presentation | Quantitative performance and demonstration readiness |

Use dedicated test accounts and disposable test maps for mutation and failure injection. Do not alter the live route publication while another teammate evaluates it. Restart, broker interruption, rollback, and restore tests use an isolated deployment or scheduled test window.

Record the selected environment values without recording secrets: origin, build, runtime/device, storage profile, model/prompt version, feature flags, deadlines, resource limits, and map/index identities. A clean setup must fail clearly when required configuration is missing. Browser/APK assets and logs must not contain private server keys.

### Data packs

| Pack | Contents and minimum preparation | Ground truth and use |
|---|---|---|
| D1 Identity and governance | Administrator for map A, administrator or non-owner for map B, two volunteers, two guest sessions; open and archived targets; overlapping contributions | Permission matrix and expected state transitions; deterministic tests |
| D2 Plans and geometry | A clean scan, oblique photograph, and difficult low-quality plan; a non-square map; known doors, rooms, labels, and north orientation | `{{MAP_REVIEWER}}` labels critical geometry and text from source and site evidence |
| D3 Graph and revisions | A connected branch, blocked/reversed edges, unreachable destination, duplicate or missing IDs, incompatible revisions; optional floor connector and step-free fixtures | Expected allowed edges and valid routes; alternative equal-cost paths may both be valid |
| D4 MCP edits | A controlled 51-room row for inclusive 4000–4050 numbering; a mismatched room count; an accessible test webpage with matching, conflicting, and unknown room records | Expected selected objects and edits; preserve a dated copy of website evidence |
| D5 Reference gallery | Initially 8–12 target-route checkpoints with 4–8 useful real views per checkpoint, adjusted through experiments | Location/capture-zone and direction verified by a person; collection session recorded |
| D6 Development queries | Separate capture sessions with supported views, reverse approaches, similar corridors, wrong floors, and unknown scenes | Used for settings and rejection calibration; never described as untouched final evidence |
| D7 Final evaluation | At least three fresh supported photos per checkpoint, plus 10–20 genuinely unsupported inputs; include every critical turn | Prefer another operator/session; label support and ground truth before revealing results |
| D8 Failure fixtures | Corrupt/oversized images, invalid model output, provider timeout/429, delayed jobs, duplicate requests, missing assets, and network interruption | Controlled fault injection; never counted as real model accuracy evidence |

The collection counts are starting test budgets, not a guarantee of recognition. A single panorama's crops and adjacent video frames remain in the same split. Ground-truth labels include building, floor, checkpoint or declared capture region, and direction where known. A difficult but supported photo belongs in the supported set, not the unknown set.

Keep real scene references unaltered except recorded preprocessing. Generated map images are not real localization evidence. Retain originals and hashes or equivalent identifiers so corrections and reproductions use the intended assets.

Store manifests and test records in version control; store large or sensitive image assets in controlled storage with stable references. Record collection permission, retention, and deletion choices appropriate to the actual site. Test retention behavior when implemented without deleting the evaluation evidence still needed for the release.

## 5 Experiments and measurement rules

### Map automation experiment

Run the complete bitmap and vectorization pipeline on all three D2 plan types. Inspect source, standardized bitmap, vector rendering, and extracted records side by side. Repeat a representative input three times to expose output variation. Preserve every attempt, including failures and manual corrections.

Measure missing/added doors, wall connectivity errors, incorrect/missing room labels, broken object associations, time to a valid editable draft, and human correction time. For the declared publication, require zero unresolved route-critical geometry or label errors. Generated drafts may contain flagged uncertainty, but must not silently publish it.

To evaluate the goal of faster map development, have a volunteer perform the same bounded task manually and with AI assistance on comparable fixtures. Record total elapsed time, correction effort, and final correctness. A speed improvement is a measured product outcome, not an assumed consequence of calling AI. A pipeline that works but is slower can pass functional acceptance while failing a speed claim.

### Reference collection and localization experiment

1. Fix representative locations, independent development queries, model/prompt settings, and the current decision policy.
2. Compare reference counts such as 1, 2, 4, and 8 per checkpoint using documented subsets. Test spatial spacing separately from view-direction coverage.
3. Compare relevant approach directions, then image size/compression settings. A starting comparison can use long edges of 768, 1024, and 1600 pixels, retaining an original-resolution control for small signs.
4. Record recognition, rejection, upload and processing time, collection effort, and API usage. If factors interact, run a small follow-up comparison rather than attributing all improvement to one factor.
5. Choose a configuration on development data. Freeze it and collect or unlock fresh final queries. If an alternative matcher is compared, keep the same input split and report it separately.

Do not select reference counts, prompts, thresholds, or capture zones using final outcomes and continue calling that set unseen. After tuning, retain previous failures as regression fixtures and create a fresh final evaluation set for the affected conditions.

### Quantitative acceptance

The initial plan's targets are retained below as proposed release targets. They are neither measured results nor model guarantees. Confirm or revise them at G0/G1 before final evaluation, with the reason recorded. Review later exceptions as explicit scope decisions; do not silently lower thresholds after seeing failures.

| Measure | Definition | Proposed target or rule |
|---|---|---|
| Raw node accuracy | Correct top-ranked locations / supported queries, before rejection | Report counts and per-checkpoint results; diagnostic only |
| Accepted precision | Correct accepted locations / all accepted locations, including wrong accepts on unsupported inputs | At least 95%; undefined and failed acceptance if no results are accepted |
| Supported-query coverage | Accepted supported queries / all supported queries | At least 80%; show wrong accepts separately |
| Correct supported coverage | Correct accepted supported queries / all supported queries | Always report alongside coverage, so accepting a wrong node cannot hide weak performance |
| Unknown false acceptance | Unsupported inputs assigned an accepted location / unsupported inputs | Zero observed accepts in the designated 10–20-input rejection set; report sample size |
| Critical guidance | Wrong actionable instruction at a critical turn or verified closure | Zero in final evaluation and final rehearsals |
| Warm capture latency | Capture action to usable result rendered on the phone, including upload, queueing, polling, and retries for that capture | Median at most 3 seconds and p95 at most 5 seconds on the declared runtime/network profile |
| Cold behavior | First request after app/server/model startup | Three cold trials; report separately; complete or enter a recoverable timeout state |
| Continuous capture use | Successive manual captures on the intended phone | Twenty captures without crash, locked camera, stale overwrite, or unbounded job accumulation |
| Rehearsal completion | Full route using the actual app, service, and presentation arrangement | Three completed rehearsals by at least two operators within the actual presentation allowance |

Use at least 40 warm timed attempts per claimed runtime/network profile for the initial latency report. Performance-only repeats may reuse fixtures but must not inflate the count of independent accuracy queries. Report supported, rejected, cold, and network-failure cohorts separately. Use nearest-rank p95, state the sample count, and acknowledge that small samples give coarse estimates.

Every intended test attempt remains in the run manifest. For latency gate calculation, attempts without a usable terminal result count as unbounded completion times rather than being dropped; separately report their observed timeout and error durations. An explicit, useful ambiguity/rejection result is a terminal outcome, but service failure is not successful localization. Record the user's complete recovery time separately from a single capture's latency.

Use the phone's monotonic clock for end-to-end duration. Server timing spans explain processing and queue delays; do not subtract unsynchronized clocks or sum overlapping spans. Report localizer node classification separately from any claimed heading or metric pose accuracy.

### Test operating limits

Before a real-provider run, record its finite call/cost budget and processing deadlines. Initial behavioral defaults for trials are a 20-second localization deadline, a 300-second deadline per long map-processing job, and at most two automatic transient retries within the original deadline. Validate these defaults during G1; record any change before evaluating the candidate. Do not apply navigation latency targets to long bitmap or batch-index jobs.

A deadline must end visible waiting and prevent late writes from corrupting newer state. Client cancellation may not stop already-running provider work; that work remains counted against the run budget. Budget exhaustion pauses the experiment with a recorded result rather than triggering an unlimited agent retry loop.

## 6 Requirement coverage

The companion catalogue defines the actual steps and assertions. Each row below must remain represented when requirements change.

Source references below use **Review** for the stakeholder review and **Initial** for the original plan linked above. The later authentication decision takes precedence over Initial's Google-login schedule.

| Requirement group | Source sections | Catalogue suite | Baseline classification |
|---|---|---|---|
| Minimal login, three roles, map ownership, public sessions | Review 1–2; Initial 11; later authentication decision | AUTH | Core; external OAuth conditional |
| Targets, contributions, correction, merge, rejection, history, archival | Review 1–2 | GOV | Core |
| Vector editing, structured information, coordinates, source preservation, export | Review 3–4; Initial 4–5, 11, 17 | MAP | Core |
| GPT Image 2.5 bitmap processing, AI vectorization, extraction, repair | Review 4 | AI | Core |
| MCP tool parity, all three natural-language examples, batches and boundaries | Review 5 | MCP | Core |
| Real photos, directions, LLM scene relationships, reviewed associations | Review 6; Initial 6, 20 | REF | Core |
| GPS/building context, visual matching, uncertainty, independent evaluation | Review 7; Initial 7, 13 | LOC | Core; automatic building selection may have a disclosed manual fallback |
| Reviewed graph, direction-aware static guidance, arrival, deviation | Review 7; Initial 4, 9–10 | NAV | Core; extra floors and step-free claims conditional |
| Capacitor capture, Web API, permissions, lifecycle, offline/browser behavior | Review 7; Initial 8–10, 23 | APP | Core APK; browser a separately accepted fallback |
| Jobs, deduplication, stale results, deadlines, worker and broker recovery | Review 2, 5, 7; Initial 8, 11, 23 | JOB | Core |
| Configuration, CI, deployment, persistence, observability, restore | Initial 18–19, 21–25 | OPS | Core selected deployment; unused providers not applicable |
| Panorama, animation, sensors, repeated frames, 3D, outdoor embedding, obstruction checks | Review 7; Initial 2, 8–10 | EXT | Conditional; required if enabled or demonstrated |
| Complete product, independent walking, rehearsal and handoff | Review 1, 8–9; Initial 13–17, 25 | E2E | Core |

## 7 Daily execution and defect workflow

Use the following cycle throughout development, with an integration checkpoint at least every two focused working hours and before a field walk:

1. Select the next gate and change scope; identify applicable catalogue cases and dependencies.
2. Record the build, data, model/prompt configuration, runtime, expected outcomes, and test budget.
3. Run fast deterministic checks before using scarce device time or paid providers.
4. Deploy one named candidate, run a smoke test, then execute the affected real-service and field cases.
5. Record actual outcomes and evidence. Open defects with exact reproduction inputs and the original revision identifiers.
6. Assign each defect one owner, choose a fix or explicit scope reduction, and preserve a failing fixture where useful.
7. Retest the original failure, then run the impacted regression suites. Use fresh evaluation photos when tuning invalidated independent evidence.
8. Have the designated reviewer assess evidence and record the gate result. Promote the known-good candidate or retain the previous one.

Avoid concurrent deployments and uncontrolled live-map edits during a test run. During rest rotations, leave the current build, open failures, reproduction steps, and next action in the handoff record; avoid changes that require an unavailable owner's review.

| Severity | Examples | Required action |
|---|---|---|
| S0 Blocker | Unauthorized publication/access to private data; silent accepted-work loss; mixed publication; confidently wrong critical-turn guidance | Stop the affected release path, preserve evidence, fix or disable the entire affected capability; no waiver for the core invariant |
| S1 Major | Core workflow unusable, repeated incorrect matching, camera cannot recover, jobs never terminate, required AI operation unavailable | Blocks the relevant core gate; fix or record an explicit reduced-scope demo decision |
| S2 Moderate | Recoverable usability/performance defect outside a hard gate, with a tested workaround | Record impact, owner, workaround, and reviewer acceptance; no hidden waiver of a metric target |
| S3 Minor | Cosmetic issue that does not obscure required information or controls | Track and fix when worthwhile; relevant display check is sufficient |

A defect closes only after the original case and required regressions pass on an identified candidate. “Could not reproduce,” “works on my machine,” or a replaced fixture without explanation does not close it. A non-reproducible intermittent failure remains recorded with its frequency and evidence.

## 8 Regression triggers and selection

Always run the small shared smoke set after deploying a candidate: authenticated editor access, public read of a publication, one real capture job and result, a route, and correct release identifiers. Expand beyond that only for changes or unresolved failures that justify it.

| Change | Mandatory affected checks |
|---|---|
| Role, login, ownership, session configuration | AUTH; GOV access restrictions; MCP permission parity; contributor and public smoke |
| Merge, archival, revision or publication logic | GOV; stale AI/job behavior; MAP associations; active-session revision checks |
| Geometry, doors, nodes, edges, floor transforms | MAP and NAV; changed reference associations; physical check of changed passages; affected route rehearsal |
| Labels, room purposes, website import | MCP/AI extraction checks; destination lookup; REF/LOC if labels affect matching |
| Bitmap prompt/model or vectorizer | AI; MAP round-trip and fidelity; MCP re-generation; dependent publication and route tests |
| Scene prompt/model, reference gallery, localizer, threshold, preprocessing | REF/LOC; reindex if required; previous failures plus fresh affected evaluation; guidance at affected turns |
| Capture size, compression, camera plugin, native build | APP; image readability and localization quality; latency and relevant lifecycle/network cases |
| Queue, retry, timeout, idempotency, storage | JOB; duplicate publication/upload; OPS recovery; asynchronous APP state |
| Dependency lock, container, migration, environment or deployment | Clean build; OPS; readiness and persistence; core smoke; relevant device build checks |
| Guidance renderer or direction logic | NAV; relevant EXT cases; direction/preview distinction; screen sharing and affected rehearsals |
| Pure visual styling or copy | Relevant screen states, readability and controls; no automatic model reevaluation unless input processing or decision behavior changed |
| Route, device, network, or presentation arrangement | Affected field and timing checks; rehearsal on the actual arrangement |

After any fix during the final rehearsal period, invalidate the affected evidence. Route, localization, direction, or critical device changes restart the sequence of three final rehearsals. An isolated cosmetic fix needs its display/screen-sharing check, not a new AI evaluation. Explain why retained evidence still applies.

## 9 Continuous integration and independent pipeline trials

Keep provider-independent checks in the ordinary development pipeline. Real AI calls belong in bounded integration runs with recorded usage; broad paid model calls need not execute on every commit.

| Trigger | Checks | Evidence |
|---|---|---|
| Local change | Focused validation and tests for modified behavior | Test output and changed case references |
| Pull request | Locked install, type/build checks, deterministic permission/map/job/state tests; agreed contract fixtures once they exist | CI result linked to commit |
| Merge or integration candidate | Build named artifacts, deploy staging, run readiness and smoke | Build IDs, deployment log, smoke evidence |
| AI or data change | Bounded real workflow tests and affected evaluations | Prompt/model/data versions, output artifacts, usage and quality records |
| Android release or relevant native change | Build/install APK and run actual device checks | APK identity, phone/runtime, capture evidence |
| Release candidate | G4 and G5 requirements plus restore/rollback readiness | Signed gate record and release packet |

For the independent deployment rehearsal, use a small application with a page, API health/readiness checks, one persisted record, one stored image, and one background job. Verify clean setup, public HTTPS from the phone, restart/redeploy persistence, failed-job recovery, backup restore, and return to a known-good release. Add a bounded provider probe and selected OAuth callback trial separately. Keep these experiments independent of unfinished map and navigation features.

## 10 Definition of Done

### A feature is done when

- Its intended user behavior and failure behavior are implemented and linked to catalogue cases.
- Required deterministic and real integration checks pass on the identified build; mocks are labelled.
- Relevant server-side permissions, state transitions, revision links, and resource limits work.
- An independent reviewer can reproduce the important result from the recorded evidence.
- Required regressions pass; remaining non-blocking defects have an owner and recorded limitation.
- User instructions, configuration examples, prompts, and operational notes affected by the change are updated.

### An AI workflow is done when

In addition to feature DoD, retain the input, original evidence, output, model and prompt identity, settings, validation result, usage, and human corrections. Demonstrate a genuine successful call, an invalid/uncertain response, and a timeout or provider failure. Confirm that incorrect output cannot silently alter the current publication. For localization, include the independent evaluation and rejection results; for map creation, include fidelity and editable round-trip evidence.

### A published map is done when

Its target and coverage are named; critical geometry, labels, walkability, directions, and reference associations are reviewed; required checks pass; the vector, structured records, graph, references, and derived data agree; and the administrator can identify the exact accepted revision. Draft edits and failed updates cannot change it.

### A demonstration release is done when

All required gates and enabled extension gates pass, no S0/S1 core defects remain, the final route evidence matches the candidate, and the release packet is complete. A reduced-scope release instead requires a visible list of unmet requirements, tested replacements, and the claims that have been withdrawn.

## 11 Fallback and release decisions

| Failure | Tested fallback | What remains unaccepted |
|---|---|---|
| Bitmap or vectorization workflow unreliable | Manual editing/tracing with original evidence and administrator review | Failed AI automation; cannot claim full core acceptance |
| LLM scene matching unreliable | Narrow declared checkpoints, add evidence, or evaluate an alternate matcher; explicit manual selection as last resort | Unvalidated matching conditions; manual confirmation is not visual localization |
| APK camera/build failure | Same workflow in a tested HTTPS browser | Capacitor/device requirement until repaired |
| Temporary connectivity loss | Cached owned map/reference guidance, last confirmed location, explicit manual progress | New server-side localization while offline |
| Panorama, sensor, continuous, or 3D upgrade fails | Disable it and use accepted N0 static guidance | That extension; recheck the core after disabling |
| Full route cannot pass | A shorter verified route and honest length/scope | Original route target; repeat evaluation and rehearsals for the new scope |
| Presentation streaming fails | Tested alternate sharing arrangement or clearly labelled recording | Live streaming evidence if only a recording is shown |

`{{PRODUCT_OWNER}}` and `{{RELEASE_OWNER}}` record the changed scope and its reason; `{{QA_LEAD}}` verifies the replacement path. A failed full baseline stays failed even if a narrower demonstration is acceptable. Recorded-only evidence never becomes a live-service pass.

## 12 Evidence templates and release packet

Use the following records in the team's chosen tracker or files. These fields are testing metadata and do not constrain product APIs.

### Test run record

```text
Run ID and date:
Case ID and requirement:
Executor / reviewer:
Build / APK / environment:
Map revision / data manifest / derived index:
Model / prompt / preprocessing / decision configuration:
Device / runtime / network:
Input fixture and ground truth:
Steps and fault injected if any:
Expected result:
Actual result and manual intervention:
Status: Not run | Blocked | Pass | Fail | Not applicable
Evidence links / capture or job identifiers:
Timing / retries / usage:
Defect link and next action:
```

### Defect and retest record

```text
Defect ID / severity / affected requirement and gate:
Owner: {{OWNER}}
Original run / reproducible input / expected vs actual:
Cause or current hypothesis:
Fix build or tested workaround:
Original case retest:
Regression cases and outcomes:
Fresh evaluation required and completed:
Reviewer / closure or remaining limitation:
```

### Gate decision record

```text
Gate / candidate / scope / date:
Decision: Pass | Blocked | Fail | Reduced-scope demo approved
Required cases and evidence:
Pass / fail / blocked / not-run / not-applicable counts:
Quantitative results with numerators and denominators:
Open defects and dependency blockers:
Changed claims or reduced scope:
Retest and recovery actions / owners:
Reviewer: {{QA_LEAD}}
Scope decision: {{PRODUCT_OWNER}}
Release decision when applicable: {{RELEASE_OWNER}}
```

The final packet contains the application URL; tested APK or explicitly declared browser fallback; commit and deployment identifiers; published map, vector export, reference manifest and model/prompt configuration; requirement coverage and test results; independent accuracy/latency records; three rehearsal records; known limitations and manual recoveries; setup/deploy/restore instructions; dependency and reuse provenance; and the demo script with a labelled backup video. Secrets and unnecessary raw personal imagery do not belong in the packet.
