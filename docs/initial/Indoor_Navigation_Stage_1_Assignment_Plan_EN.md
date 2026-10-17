# Indoor Navigation — Stage 1 Assignment Plan

**Date:** October 16, 2026  
**Stage:** Stage 1 — Map Platform  
**Status:** Initial work allocation agreed; implementation and acceptance are not implied  
**Working approach:** Extreme Programming principles, collective ownership, cross-review, and revisable task assignments

This document records the current four-person allocation for the Map Platform only. It does not assign later navigation stages or change the [acceptance plan](Indoor_Navigation_Acceptance_and_Test_Plan_EN.md), [test catalogue](Indoor_Navigation_Test_Catalog_EN.md), or [architecture](Indoor_Navigation_Architecture_and_Dependencies_EN.md). The names identify current coordination leads, not exclusive owners of code or permanent specializations.

## 1. Current allocation

| Stage 1 workstream | Current lead | Responsibility boundary | Handoff to teammates |
|---|---|---|---|
| Frontend | **Erfang** | Angular componentized Map Platform interface: contributor/admin screens, map editing, AI-operation controls, and visible job/review/error states | Components and feature services, representative UI states, integration needs, and evidence for applicable UI behavior |
| Backend — basic APIs | **Hamza** | Django/DRF Map Platform APIs, application permissions and map/contribution operations; application integration of persistence and authoring jobs | API behavior and failure semantics, authorized command services, integration fixtures, and applicable backend evidence |
| Database — schema design; deployment — CI/CD | **Eric** | Map Platform schema design and data-integrity decisions; database/migration coordination; the selected deployment and CI/CD workflow | Schema/migration design, database integration guidance, versioned-release procedure, deployment/recovery evidence, and configuration needs |
| Basic AI pipelines | **Arjun** | GPT Image 2.5 raster generation/editing, Gemini Argon vector building with Opus 5.5 backup, structured map edits, MCP and tool calling | Provider/workflow adapters, workflow-specific prompt/version records, validated proposals, tool behavior, bounded failure/retry handling, and real map-authoring evidence |

Arjun's Stage 1 assignment does **not** include navigation AI pipelines. Scene-localization retrieval, visitor-photo matching, route guidance, continuous recognition, and related later-stage work remain unassigned. Erfang's Stage 1 frontend assignment does not assign the later Android/navigation implementation. The same stage boundary applies to Hamza's and Eric's assignments.

These workstreams organize the already agreed Map Platform requirements; they do not freeze API fields, add new acceptance requirements, or require every listed handoff to exist before parallel work can start. Break work into small reviewable stories and agree the next necessary integration boundary as the stories progress.

## 2. Collaboration across boundaries

| Boundary | Current coordination | Integration rule |
|---|---|---|
| Frontend ↔ backend | Erfang and Hamza | Agree the behavior and examples needed by the next story; develop against labelled fixtures until real integration is available |
| Backend ↔ schema | Hamza and Eric | Coordinate persistence, constraints, ORM/migration changes and revision behavior before integration; schema design and API implementation must describe the same data |
| AI/MCP ↔ backend | Arjun and Hamza | Manual APIs and MCP invoke the same authorized map commands; AI proposes changes and cannot bypass permissions, stale revisions or review |
| AI outputs ↔ schema/editor | Arjun, Eric and Erfang | Align editable geometry and structured records; preserve source artifacts, object associations, provenance and visible validation failures |
| Deployment ↔ all modules | Eric with the affected implementers | Coordinate runtime dependencies, configuration, artifacts and release compatibility; keep personal experiments under ignored `local/` |

Eric's deployment coordination does not automatically assign the global `{{RELEASE_OWNER}}` approval role. Similarly, module leads are not automatically `{{QA_LEAD}}`, `{{PRODUCT_OWNER}}`, or `{{MAP_REVIEWER}}`. Those responsibilities remain placeholders until explicitly assigned.

## 3. XP collaboration and reassignment

**Prompt preparation belongs to each member for their own tasks.** No separate centralized AI Prompt handbook or preparation workstream is planned. Arjun's workflow responsibility does not assign him other members' development prompts. Keep personal drafts under ignored `local/`; prompts adopted into product workflows still need the existing version, evidence, validation and regression records maintained by the responsible implementer.

- Any teammate may review, pair on, improve, or take over another workstream's task. The current lead helps coordinate progress; the assignment is not a code-ownership restriction.
- Select small stories with observable behavior and relevant existing acceptance cases. Use the agreed tests to guide implementation, integrate frequently, and refactor while preserving those checks.
- Choose a reviewer for each task when needed; review pairs can rotate. Preserve the existing requirement for independently reproducible evidence and independent checks of release-critical behavior where practical.
- Reassign a task whenever workload, a blocker, availability, or a better pairing warrants it. Record the outgoing and incoming owner, current work/evidence, unresolved issues and next action so responsibility stays clear. No extra approval hierarchy is introduced by this document.
- When a defect appears, identify one current coordination owner as required by the acceptance plan; others may help diagnose and fix it. Reassignment never resets a failing case or removes its regression obligations.
- Keep the existing integration checkpoints and handoff practice. Coordinate shared schema/migration changes and deployments so concurrent work does not invalidate another teammate's test run.

## 4. Relationship to acceptance and testing

**Stage 1 is a work-allocation milestone, not gate G1.** The existing G0–G5/GX gates keep their definitions. G1 also requires camera, scene-analysis and localization trials; G2 requires the real contributor-to-visitor navigation loop. Completing Map Platform work alone does not pass either whole gate.

Stage 1 work contributes evidence to the applicable portions of **AUTH, GOV, MAP, AI, MCP, JOB and OPS**. Select exact cases and assertions per story using the existing catalogue. Some cases also contain visitor-session, reference, routing or physical checks; map-only evidence does not pass those complete cases. Retain unexecuted later checks as **Not run**, or **Blocked** when an attempted check has a recorded blocker. Deferring an assignment does not make a core requirement **Not applicable**.

Test executors and reviewers are recorded per run. Do not globally replace `{{APP_OWNER}}` with Erfang, `{{AI_OWNER}}` with Arjun, or `{{PLATFORM_OWNER}}` with one person: those placeholders also cover later stages and, in the platform case, span Hamza's and Eric's current workstreams.

Stage gates, test data, thresholds, severity levels, blocker handling, regression triggers, fallback disclosure, evidence requirements and Definition of Done remain governed by the existing acceptance plan. A Stage 1 demonstration may show the map workflow and its evidence; it does not claim full navigation acceptance. No test result is changed by recording these assignments.

## 5. Later-stage ownership

Later stage numbering and assignments are not fixed by this record. These placeholders identify unallocated work without naming a lead or reviewer:

| Later work | Lead | Reviewer |
|---|---|---|
| Android/public-user navigation interface and device integration | `{{LATER_APP_OWNER}}` | `{{LATER_APP_REVIEWER}}` |
| Scene-reference processing, localization and navigation AI | `{{LATER_AI_OWNER}}` | `{{LATER_AI_REVIEWER}}` |
| Navigation backend, routing and visitor-session services | `{{LATER_BACKEND_OWNER}}` | `{{LATER_BACKEND_REVIEWER}}` |
| Later database changes and deployment operations | `{{LATER_PLATFORM_OWNER}}` | `{{LATER_PLATFORM_REVIEWER}}` |
| Field validation, integration acceptance and demonstration release | Existing `{{FIELD_TESTER}}`, `{{QA_LEAD}}`, `{{RELEASE_OWNER}}` | `{{REVIEWER}}` |
| Optional navigation extensions | `{{EXTENSION_OWNER}}` | `{{EXTENSION_REVIEWER}}` |

## 6. Small task record

Use the existing tracker/evidence templates; the following ownership information can be added without defining application API fields:

```text
Stage: Stage 1 — Map Platform
Task / intended behavior:
Current owner:
Reviewer or pairing partner: {{REVIEWER}}
Related requirements / catalogue cases:
Dependencies / handoff needed:
Current status / evidence links:
Blocker / next action:
Reassignment history, if any:
```

This is an allocation update only. It creates no implementation tasks in an external tracker, sends no teammate notifications, and does not install or deploy software.
