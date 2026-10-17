# Latest main integration: environment, feature and refactoring gaps

Date: 2026-10-17, America/Toronto. Branch: `acceptance/map-authoring-pipeline`.
This audit compares implementation with the [complete navigation/AI plan](../pipeline/navigation-ai-workflow-plan.md), including authorized continuous camera/IMU tracking. Its scope is inspection and recording, not implementing the identified product gaps.

## 1. Synchronization baseline and overall finding

- Plans were already committed through `3bb9ab1`; the worktree was clean before synchronization.
- Ran `git fetch origin` and merged remote main **`2dfd1ef`** into the acceptance branch in **`1922769`**, without text conflicts. The acceptance branch was not merged into local main; no push, PR or deployment was performed.
- **Identity/permission foundations and Web/API delivery now have substantive implementations and live evidence. The main remaining work is product integration, one data authority, real navigation assets and device capabilities.** The merged branch still has reproducible CI failures; green remote main does not establish merge readiness of this branch.

P0 blocks the next accepted real workflow or branch integration. P1 is required for the complete target but can follow the static loop. Priorities reflect acceptance dependencies rather than advertised model capabilities.

Categories: **E, environment/external preparation** includes configuration, running services, manual assets and devices; **F, features** means missing user behavior/APIs/background processing; **R, refactoring/integration** means adapting, migrating or unifying existing implementations. Each issue has one primary category, with cross-references for dependencies.

**A real Vectorizer.AI key, subscription and automatic conversion are excluded from the gap list**, as explicitly disabled for this event. IA-4 mock assets/import/readiness are E-04; frontend integration and runtime delivery are F-04/R-03.

## 2. Capabilities present on latest main

| Existing capability | Code / evidence | What it does not establish |
|---|---|---|
| Google OAuth backend entrypoints, Django sessions, identity/logout | [Auth routes](../../apps/api/accounts/urls.py), [views](../../apps/api/accounts/views.py), [OAuth record](../backend-oauth.md); auth tests passed in the local suite | Integrated Angular login, ordinary email authentication or accepted live Google consent |
| MapTarget-scoped admin/volunteer Membership, grant/revoke services, DRF permissions and bootstrap tooling | [Permissions](../../apps/api/maps/permissions.py), [services](../../apps/api/maps/services/membership.py), [diagnostic view](../../apps/api/maps/views.py), [feature record](../backend-permissions.md) | Completed map business APIs or automatic propagation of Django authority into Node |
| CI, gated deployment, packaging, migrations, health checks and release-switch/failure handling | [CI](../../.github/workflows/ci.yml), [deployment workflow](../../.github/workflows/deploy.yml), [controller](../../infra/deploy.py), [packaging](../../scripts/package_release.py) | Deployed pipeline/workers, product readiness or rehearsed disaster recovery |
| Latest main successfully checked/deployed | [Run 39038792613](https://github.com/mhamza1906/SnapWay/actions/runs/39038792613): Linux/Windows backend, PostgreSQL, Web, package and deploy succeeded; deployment flag rechecked as `true` | Successful CI for the merged acceptance branch or deployment of its unpushed pipeline |

Read-only public observations at approximately 11:08 local time: `/api/health/live/` returned full main SHA `2dfd1efcfd6a2008b5c4c6d3e6b43cb26202fd32`; `/api/health/ready/` reported database ok; `/api/auth/me/` reported anonymous identity. All were JSON 200. They establish framework operation, not live OAuth authorization or product completion.

On the same host, `/pipeline/api/health` and `/pipeline/api/vectorization/status` returned **200 HTML**, consistent with [Caddy SPA fallback](../../infra/deploy.py) and [packaging that excludes Node](../../scripts/package_release.py). They are not functioning pipeline APIs. HTTP 200 alone is insufficient.

## 3. E: Environment and external preparation

| ID / priority | Observed state and evidence | Closure evidence |
|---|---|---|
| **E-01 / P0: Real Google OAuth configuration** | Local `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `local/env/api.env` are empty. Production credentials, Console consent/test users and exact callbacks were not inspected; local absence does not prove production absence | Configure local/HTTPS callbacks and complete actual consent; `me` returns session/membership and logout invalidates it. Google identity never grants map authority automatically |
| **E-02 / P0: Local shared-database connectivity** | PostgreSQL URL exists locally, but read-only `SELECT 1` raised `OperationalError`; no connection/secret was printed. Public readiness reports DB ok, so this is not evidence of a complete Tiger outage | Diagnose actual local network/TLS/account/connection cause; verify read-only connectivity/table state before separately authorized migrations/seeds. A URL is not connectivity |
| **E-03 / P0: Broker/worker runtime** | Django has broker configuration, but its local Redis TCP endpoint is unreachable; the release controller creates API units, not the two business-queue worker units. Actual consumers are unverified | Provide appropriate local Redis/Celery runtime and authoring/localization workers with reserved capacity; F-06 still supplies real tasks. An open port is not task readiness |
| **E-04 / P0: IA-4 mock prebuild package** | Route is fixed to `ia-4`, returning `503 DEMO_ASSET_PENDING` when absent. Local SQLite contains only the 440,127-byte `ia-1` SVG; no real IA-4 source/SVG is imported. Synthetic test rectangles are not deliverables | Manually export/review real floor-4 assets in Figma, preserve source/provenance hashes and use the [import command](../pipeline/vectorizer-api-demo.md). Verify that mock/disclosure return floor 4, never floor 1 |
| **E-05 / P0: Navigation field assets** | IA-1 presentation SVG exists with `navigationReady=false`; no complete accepted package of reviewed IA graph, metric calibration, four-direction references and independent query photos was established | Choose a real short start/destination route, confirm openings/stairs/headings/distances in the field, collect reference/held-out photos, publish and walk it. Do not block the first loop on whole-building collection |
| **E-06 / P1: Target Android phone and calibration setup** | Capacitor wrapper exists, but dependency inventory lacks Motion/ARCore/VIO and DevicePreview is simulated. Phone model, camera/IMU, debugging connection and calibration are unverified | Prepare a target device, repeatable route/anchor and recording setup; measure clocks/rates/drift/lifecycle under plan section 9.7. SDK/adapter implementation is F-08 |
| **E-07 / P1: Deployed model/email configuration acceptance** | Local OpenAI key exists; Vertex settings exist in Node `.env.prod`. Their presence does not prove deployed validity or access for the new Flash role. Real email delivery is unverified | Resolve R-04, then verify the actual model endpoint/access/quota and sending service with complete usage/timing records. No model requests or Vectorizer purchase are required by this audit |

All four local R2 values are present; no object write or validity test was performed. **R2 purchase/reactivation is not a mandatory dependency gap** because persistent private filesystem storage is supported. F-03/F-06 still need authorized asset writing/delivery; validate R2 integration/access if it is selected.

## 4. F: Missing product features

| ID / priority | Missing behavior against the plan | Existing foundation / completion boundary |
|---|---|---|
| **F-01 / P0: Real frontend identity and permissions** | Google entrypoint, session loading/logout, membership-filtered targets, expired/denied recovery, CSRF-protected writes and identity-aware navigation | Backend `me/logout` and Membership exist; [welcome](../../apps/web/src/app/features/welcome/welcome.ts)/[settings](../../apps/web/src/app/features/settings/settings.ts) still call `setRole`, without a complete Auth facade. Replace demo-role authority rather than building another permission truth |
| **F-02 / P1: Email/password and verification** | Previously requested registration, verification, login, reset and email-delivery workflow | [Settings](../../apps/api/config/settings/base.py) use `SOCIALACCOUNT_ONLY=True` and `ACCOUNT_EMAIL_VERIFICATION="none"`. This identifies missing ordinary email authentication, not invalid Google identity verification; defer only with an explicit scope decision |
| **F-03 / P0: Map services and publication loop** | Target/contribution/revision/asset CRUD, membership UI operations, server graph edits/review/publication, public reads and controlled media delivery | [Maps routes](../../apps/api/maps/urls.py) expose only diagnostic access. Rich [models](../../apps/api/maps/models.py) are not services. Apply existing membership/scope checks; existing Admin/commands can bootstrap initial members |
| **F-04 / P0: Product image-edit workflow and construction demo integration** | Source optimization, immediate raster review, natural-language regeneration, acceptance/rollback and semantic invalidation; IA-4 mock selection/result/provenance display | [Real-call experiment](../../apps/pipeline/experiments/fullchain-pilot.mjs) exists; [authoring UI](../../apps/web/src/app/features/authoring/authoring.ts) lacks the complete new loop. Mock route exists; assets are E-04, delivery R-03, and UI/job wiring remains |
| **F-05 / P0: Updated semantic graph and Flash assistance** | Gemini 4 proposals for accepted images: node classes, label evidence, corridor samples, complete edge geometry/distance relations; Flash constrained ChangeSets and manual review | Node already implements extraction, geometry, doors, routing/checks and persistent snapshots: AI code is not absent. [Actual IA acceptance](2026-10-17-gpt-fullchain-pilot.md) failed and the new model roles/contracts remain incomplete; reuse validated parts and measure additions |
| **F-06 / P0: Four-direction references and asynchronous scene understanding** | Direction slots/calibration, non-blocking uploads, declared exclusions, Gemini 4 descriptors, progress/bounded retries/version checks, association review and index publication | ReferencePhoto/SceneRelationship/Job/JobAttempt are persistence foundations. [Jobs](../../apps/api/jobs/models.py) lacks photo task/dispatch implementation; [Celery configuration](../../apps/api/config/celery.py) is initialization. Node map snapshots are not photo-analysis workers |
| **F-07 / P0: Public static scene navigation** | Published scope/destination resolution, capture-confirmed position/heading, departure-directed real photos, manual progress/arrival/recovery and the no-indoor-map flow | [Navigation](../../apps/web/src/app/features/navigation/navigation.ts) uses PrototypeRepository/DevicePreview and simulated localization/arrival. Local Dijkstra runs, but real session/localization/route APIs are absent. UI migration is R-05 |
| **F-08 / P1: Dynamic camera and geometric tracking** | Camera/accelerometer/gyro, native Tracking adapter, shared camera frames, clock/frame/epoch handling, anchoring/drift recovery, Gemini slow-path fusion and screen/world overlays | [DevicePreview](../../apps/web/src/app/core/device-preview.ts) explicitly avoids hardware; no native engine exists. Accept layers under sections 9.4-9.7, with static guidance first. Model node judgments are not full camera pose |

Retrieval, candidates and indexes belong within F-06/F-07/F-08. Do not turn purchasing a specific embedding service into an assumed dependency; evaluate the specified Gemini workflow before choosing retrieval from accuracy/latency evidence.

## 5. R: Refactoring and integration gaps

| ID / priority | Required adaptation | Evidence / boundary |
|---|---|---|
| **R-01 / P0: Merged CI contract and script quality** | Align the classifier's three-result contract/tests; bring experiment/analysis Python under Ruff while preserving evidence bytes; rerun before PR | [Classifier](../../scripts/ci_changes.py) returns backend/web/pipeline; [new infra tests](../../infra/tests/test_package_release.py) expect two results, causing seven failures. Three existing branch scripts yield 89 Ruff diagnostics and format failures. The former is a semantic integration conflict; the latter is existing branch debt, not a main regression |
| **R-02 / P0: One data authority and graph contract** | Explicit adapters/DTOs across Local Storage prototype, Node building JSON/files and Django revisions/relations; unify IDs, frames, scale, direction/cost/verification/publication and migrate drafts | [PrototypeRepository](../../apps/web/src/app/core/prototype.repository.ts), [prototype models](../../apps/web/src/app/core/prototype.models.ts), [Node schema](../../apps/pipeline/shared/building/schema.js), [Django models](../../apps/api/maps/models.py). Prototype edges have basic blocked/accessibility state, are bidirectional and lack verified metric scale; these are not equivalent serializations |
| **R-03 / P0: Pipeline/task/permission delivery boundary** | Decide between an internal Node service and migrating required workflows into Django workers; include release/startup/queues/persistent paths/authorized proxy/readiness while retaining browser contracts | Releases exclude `apps/pipeline`, Caddy lacks its handler, public URLs return HTML. Node has Origin/loopback checks, not Django membership. **Do not simply expose the entire Node API publicly**. This is integration of a new slice, not failure of current Web/API deployment |
| **R-04 / P1: Environment, provider-role and storage configuration contract** | Clarify/unify Django `local/env/api.env`, Node `.env.prod` and production `/etc/indoor-nav/api.env`; define Image/Gemini/Flash roles, storage and budget records | The "only private env" documentation describes Django but conflicts in scope with Node dotenv; production templates lack the new pipeline contract. Do not silently duplicate keys or treat R2 values as activated storage |
| **R-05 / P1: Move frontend prototype to the new journeys** | Developer raster/graph/reference workflow; Public photo/camera workflow replacing indoor-map emphasis and simulated results/roles, with existing API boundaries respected | [NavigationMap](../../apps/web/src/app/features/navigation/navigation-map.ts) and [template](../../apps/web/src/app/features/navigation/navigation.html) remain map/simulation-based. Preserve historical prototype only as a distinct demo; style/layout/animation iteration follows the new workflow |
| **R-06 / P1: Cross-layer acceptance beyond isolated mock tests** | Keep fast offline CI; add necessary identity/permission/assets/jobs/publication/static-route contracts, with real provider/device trials local or explicitly manual and concise shared evidence | Passing frontend/Node units do not establish the complete workflow. `required` aggregates run/skip status; runtime readiness checks DB only. Add checks by slice without charging model calls on each CI run |

The three Ruff files are [meter_image_cli.py](../../apps/pipeline/experiments/meter_image_cli.py), [stage_fullchain.py](../../apps/pipeline/experiments/stage_fullchain.py) and the [Figma analysis script](assets/2026-10-17-figma-vectorization/analyze.py). This audit records failures without hiding them through exclusions or rewriting historical evidence. Resolve R-02/R-03 as concrete slices; current planning authorization does not justify an unreviewed replacement of teammates' published APIs.

## 6. Verification results and limitations

| Check | Result |
|---|---|
| Git integration | Merge `1922769`, no text conflicts |
| Remote main CI/deployment | Run `39038792613` succeeded; public release matches `2dfd1ef` |
| Merged Python API/MCP/infra suite | **67 passed, 16 PostgreSQL-only skipped, 7 failed**, approximately 23 seconds; all failures are two-result/three-result classifier mismatch |
| Merged Ruff checks | **89 diagnostics; 3 files fail formatting**; checks are not all green |
| Django check / migration drift | No system-check issues; `makemigrations --check --dry-run --settings=config.settings.test` reports no changes |
| Node pipeline | **151 passed, 18 optional Waterloo-fixture skips, zero failures**, about 4.5 seconds, including mock contracts |
| Angular | **11 test files / 59 tests passed**; browser production build passed; no APK/real-device rerun |
| Local environment | Empty OAuth pair, failed read-only DB connection, unreachable broker; OpenAI/Vertex/R2 presence neither exposes values nor proves validity |
| Public HTTP | JSON live/ready/anonymous identity succeeded; pipeline URLs are HTML fallback |
| Manual assets | Local catalog contains only `ia-1`; real IA-4 fixture remains pending |

Private evidence remains in ignored `local/test-results/main-sync-gap-audit/`: `probe.py/probe.json` for read-only configuration/DB/TCP/public HTTP and `lint.json` for aggregated diagnostics. The [sanitized shared snapshot](assets/2026-10-17-main-sync/verification.json) retains results/baselines without secret values, database URLs or user records.

No Google consent, shared DB migration/write, model/Vectorizer request, R2 write, SSH deployment or hardware test was performed. Public readiness checks SQL/basic user-table access, not indexes, authoring or navigation. Main and merged-branch results remain distinct.

## 7. Recommended order

1. **Restore integration readiness:** R-01; concurrently prepare E-01/E-02, actual IA-4 assets E-04 and a short IA-1 route E-05. Reuse the existing backend/delivery foundations.
2. **Connect identity and one data authority:** F-01/F-03 plus R-02; resolve R-03/R-04 before F-04/F-05. Start with one target/contribution loop rather than all pages.
3. **Complete references to static navigation:** E-03 plus F-06/F-07; confirm real publication, references, position/heading, walkability and arrival in the field.
4. **Add continuous dynamics:** E-06 plus F-08, progressing from sensor data to pose, anchoring and delayed cloud fusion. Implement F-02 in parallel if required for the first demo; otherwise explicitly retain it as deferred scope.

Asset preparation, deployment configuration and coding can progress concurrently. Clickable UI, existing models, model JSON and green CI each prove a different layer; none substitutes for the other acceptance evidence.
