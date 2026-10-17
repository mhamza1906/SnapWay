# Indoor Navigation Hackathon Plan

**Updated:** October 16, 2026  
**Current focus:** Stage 1 — Map Platform  
**Status:** Requirements, acceptance/testing, architecture, integration research, and initial Stage 1 allocation are documented. This folder does not establish that implementation, deployment, provider trials, or product acceptance have been completed.

This project combines collaborative indoor map development with public visual navigation. Administrators define mapping targets and review, correct, merge, reject or archive contributions. Volunteers build editable maps from floor-plan images, add structured information and reference photographs, and use manual or AI-assisted editing. Public users later navigate from reviewed publications through an Android application.

The current allocation covers the **Map Platform**. Navigation pipelines, Android delivery and other later-stage assignments remain open. The full product baseline includes a verified building/floor, a reviewed map, fresh-photo localization or a useful rejection, and static route guidance. Animated guidance, sensors, continuous frame recognition and 3D navigation are separately gated extensions.

## Document guide

For a first read, follow the table from top to bottom. For an implementation task, use the relevant architecture/integration document together with its acceptance cases.

| Document | What it answers |
|---|---|
| [Stakeholders and workflows](Indoor_Navigation_Stakeholders_and_Workflows_Review_EN.md) | Who uses the system, what administrators/volunteers/public users do, and how contributions become reviewed maps |
| [Stage 1 assignment plan](Indoor_Navigation_Stage_1_Assignment_Plan_EN.md) | Current leads, module handoffs, XP cross-review/reassignment, and unassigned later work |
| [Stage acceptance and test plan](Indoor_Navigation_Acceptance_and_Test_Plan_EN.md) | Gate criteria, test data, metrics, blockers, regression triggers, fallbacks, evidence, and Definition of Done |
| [Acceptance test catalogue](Indoor_Navigation_Test_Catalog_EN.md) | Individual scenarios for identity, governance, maps, AI, MCP, references, localization, routing, apps, jobs, operations, extensions and end-to-end acceptance |
| [Architecture and dependencies](Indoor_Navigation_Architecture_and_Dependencies_EN.md) | MVC responsibilities, Angular components, Django modules, data authority, publication, dependencies and deployment design |
| [Android architecture](Indoor_Navigation_Android_Architecture_EN.md) | Canonical Android design: Capacitor visitor build, native adapters, camera, lifecycle, permissions and APK delivery |
| [Infrastructure integration](Indoor_Navigation_Infrastructure_Integration_EN.md) | Future toolchain/database/OAuth/domain/hosting setup, configuration mapping, independent deployment trials and recovery |
| [AI and Google Maps integration](Indoor_Navigation_AI_and_Maps_Integration_EN.md) | Selected model roles, provider connection procedures, SDK examples, Maps services, and isolated integration probes |
| [Open-source reuse plan](Indoor_Navigation_Open_Source_Reuse_Plan_EN.md) | Pinned repository audits, reusable algorithms/workflows, dependencies, licensing observations, defects and extraction priorities |
| [Configuration template](.env.example) | Planned variables and safe placeholders for backend, workers, MCP, public builds, Android and deployment |

This README is an index and summary. The acceptance documents govern test outcomes; the architecture and integration guides govern current technical choices; the assignment plan governs current staffing. Later explicit team decisions update the relevant document. Archived documents provide historical context and do not override these records.

## Current Stage 1 allocation

| Workstream | Current lead |
|---|---|
| Frontend | **Erfang** |
| Backend — basic APIs | **Hamza** |
| Database schema design; deployment and CI/CD | **Eric** |
| Basic AI — image generation, vector building, MCP and tool calling | **Arjun** |

Follow the agreed Extreme Programming approach: collective ownership, small reviewable tasks, cross-review, pairing and flexible reassignment. Record a current owner and handoff for each task. Arjun's Stage 1 allocation excludes navigation pipelines. Later-stage leads and unassigned acceptance/review roles remain placeholders.

**Stage 1 is a development allocation, not acceptance gate G1.** Finishing the Map Platform does not pass unexecuted camera, localization, navigation or field requirements.

## Technical baseline

| Area | Selected direction |
|---|---|
| Frontend | Angular with componentized MVC responsibilities, typed state/services and reusable UI components |
| Backend | Django + Django REST Framework modular monolith; shared authorized domain services for REST, jobs and MCP |
| Android | Capacitor visitor entry build; native Android adapters where needed; Android only at present |
| Database | Tiger Data managed PostgreSQL; structured map geometry, relational records and versioned artifacts |
| Hosting and domain | Vultr Ubuntu VM; GoDaddy domain/DNS |
| Identity | Google OAuth/OpenID Connect for map developers; application-owned permissions; public navigation does not require developer login |
| Outdoor navigation | Google Maps URL handoff first; embedded Maps/Routes/Places or native SDKs only for the selected additional capability |
| Deployment | GitHub Actions, cached dependencies, affected-target builds, versioned artifacts and systemd/Caddy service switching; no Docker workflow |

Keep one geometry authority and publish a consistent revision of map, records and required derived assets. AI outputs are proposals until validated and reviewed. Indoor route computation uses reviewed topology. A plausible model response does not establish a doorway, physical position or heading.

Application API fields, exact schemas, dependency lockfiles and account-specific availability still require the planned implementation/integration work. The folder contains preparation instructions and configuration templates, not installed dependencies.

## Selected AI roles

| Role | Selected model |
|---|---|
| Bitmap generation and editing | GPT Image 2.5 Sunburst — `gpt-image-2.5-sunburst` |
| Primary vision and difficult vector modeling | Gemini 4 Argon — `gemini-4-argon` |
| Routine multimodal interpretation and edit planning | Gemini 3.8 Flash — `gemini-3.8-flash` |
| Vector-modeling backup | Claude Opus 5.5 — `claude-opus-5-5` |
| NLP retrieval | Gemini Embedding 2 — `gemini-embedding-2`; initial 768-dimensional proposal |

Use the [AI integration guide](Indoor_Navigation_AI_and_Maps_Integration_EN.md) for sources, account checks, capability boundaries and controlled backup behavior. Embedding activation and real provider calls remain gated by configuration and the planned probes. Model selection is not evidence of map fidelity or localization performance.

## Acceptance and iteration

The existing **G0–G5/GX** gates progress from scope/test readiness through independent trials, a small real product loop, core acceptance, target-route evaluation and demonstration release; extensions have their own gate. Consult the acceptance plan for exact criteria and the catalogue for test actions.

Each iteration identifies affected requirements, runs appropriate checks, records evidence, assigns failures and retests the fix plus required regressions. Partial evidence does not pass a whole case. Current assignments do not change thresholds, blocker handling, fallback disclosures, reviewer obligations or DoD. Later unexecuted work remains visible instead of being counted as passed.

## Prompt preparation and working files

**Each member prepares their own AI prompts for their tasks. There is no separate centralized Prompt handbook or team-wide Prompt preparation deliverable.** Arjun owns prompts needed by his assigned AI workflows, not every teammate's development prompts. Personal prompt drafts and experiments belong under ignored `local/`.

When a prompt becomes part of a product workflow, its responsible implementer still maintains the required version, input/output evidence, validation and regression record with that feature. Existing AI acceptance requirements remain in force.

Use [`.gitignore`](.gitignore) to exclude `local/`. Keep personal tests, logs, research snapshots, SKILL files, private environment values and trial artifacts there. Reviewed shared tests and sanitized fixtures may be promoted deliberately into tracked project assets. Real credentials must never enter `.env.example`, public frontend assets or the APK.

```text
Hackathon-Plan/
├── README.md                         Current summary and document index
├── Indoor_Navigation_*.md            Current planning documents listed above
├── .env.example                     Configuration inventory; no real credentials
├── .gitignore                       Includes /local/
├── archive/
│   ├── Indoor_Visual_Navigation_Detailed_Plan_EN.md
│   └── Previous Research
└── local/                           Ignored personal development material
```

The application directory layout shown inside the architecture document is a future implementation proposal. It does not describe folders already created here. Recreate `local/` after a fresh clone because Git does not preserve ignored directories.

## Historical references

| Archived file | How to use it |
|---|---|
| [Original detailed plan](archive/Indoor_Visual_Navigation_Detailed_Plan_EN.md) | Original proposal, older implementation options, scheduling/staffing examples and earlier assumptions; use current documents for active decisions |
| [Previous Research](<archive/Previous Research>) | Earlier research notes and repository leads; use the current reuse audit for re-evaluated extraction decisions and evidence limitations |

Both files are retained for reference. Their older model choices, deployment approaches, staffing, schedules and API-freezing proposals are not the current baseline. Historical research measurements are not reproduced project results.
