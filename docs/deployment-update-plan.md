# Deployment update plan: Django authority with private Node computation

Date: October 17, 2026. Status: selected stage conclusion; implementation and server capacity acceptance are pending.

## 1. Decision

Keep the existing Node pipeline as one private computation service on the current Vultr VM. Django owns browser-facing business APIs, authentication, map permissions, shared records, durable jobs and publication. A single authoring Celery worker invokes Node through a bounded internal contract. Do not rewrite the image/geometry pipeline in Python during this stage.

This is the selected direction for the next deployment increment. It preserves the useful tested pipeline while avoiding a full language migration. It adds the already planned private Redis/Celery execution path to the existing native Caddy/Gunicorn deployment; it introduces no container platform, extra VM or public Node endpoint. Lower resource usage is a measurement goal, not a demonstrated consequence of this decision.

The [architecture baseline](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md), [integration boundary](pipeline/navigation-ai-workflow-plan.md#101-nodedjango-responsibility-and-integration-proposal) and [gap audit](audits/2026-10-17-main-sync-gaps.md) remain the context. This document selects the deployment approach; it does not claim implemented services or replace existing API contracts.

## 2. Current state and intended boundary

The current [release package](../scripts/package_release.py) excludes `apps/pipeline`. The [deployment controller](../infra/deploy.py) creates Gunicorn services and Django proxy routes, but no Node service, Node dependencies or pipeline readiness probe. The current deployment has no provisioned authoring worker/broker through this controller. Documentation records a 2 vCPU / 4 GB RAM VM; current server utilization and disk capacity have not been measured in this assessment.

The latest inspected remote main is `7af9eae`, following the earlier merged baseline `2dfd1ef`. The newer iOS changes have been fetched but are not merged into this acceptance branch. They must be reviewed before implementing deployment changes; this plan does not perform another merge.

The intended request path is:

```text
Angular / mobile client
  -> HTTPS Caddy -> Django: authorize, create durable Job, return job ID
  -> Redis dispatch -> one Celery authoring worker
  -> private Node: compute proposal and artifacts
  -> worker: validate freshness, store private assets and Django draft records
  -> Django: expose status and authorized review/publication
```

| Component | Stage responsibility |
|---|---|
| Caddy and Django | Remain the public application boundary; preserve session/CSRF and target Membership checks |
| PostgreSQL | Canonical job/attempt, target, revision, permission and asset metadata; no second local production database |
| Private Redis | Bounded task dispatch; never the sole durable source of job status or asset content |
| One Celery authoring worker | Dispatch, progress, deadlines, validated write-back and reconciliation |
| One private Node process | Existing AI/image/geometry operations behind a narrow internal adapter; no independent shared publication authority |
| Private persistent filesystem | Initial image/SVG artifacts and transient Node workspaces, outside immutable releases |

Use loopback binding plus an internal service credential for the Node adapter, and expose only the necessary compute operations to the worker. Origin filtering is not authentication. Do not add Caddy forwarding for the existing general `/pipeline/**` local-tool API. Node does not receive database credentials or permission to impersonate human reviewers. The worker resolves authorized assets; callers cannot submit arbitrary filesystem paths.

Public endpoints and their payloads must be specified with the backend team before implementation. Adapt Node's building/graph representation internally rather than forcing existing Django endpoints or records to adopt it. The [integration plan](pipeline/navigation-ai-workflow-plan.md#101-nodedjango-responsibility-and-integration-proposal) defines identity, coordinate, direction, revision and provenance requirements.

## 3. Resource policy for the first rehearsal

Run one heavy authoring job at a time across all heavy entry points, with internal tile/image concurrency set to one. Enforce admission atomically in the worker/service boundary; the current Node active-map check is not a global resource scheduler. Bound queued work and reject excess submissions explicitly rather than accumulating images in memory.

| Resource | Initial policy |
|---|---|
| Node processes | One; no cluster or process manager that multiplies workers |
| Worker | One authoring execution slot, low prefetch; no automatic CPU-count concurrency |
| Node memory | Rehearsal starting budget: systemd `MemoryHigh=768M`, `MemoryMax=1G`; these are proposed limits, not measured requirements or proof that a task fits |
| Node CPU | Initial `CPUQuota=100%` to limit Node to roughly one core of the two-core VM; measure the whole stack as Python and other processes still consume CPU |
| Image processing | Bound input pixels, output dimensions, Sharp cache and processing threads; apply limits to every image/PDF route |
| Transport | Prefer asset references and binary/file transfer; stop forwarding whole buildings with repeated Base64 image content. Replace the global 150 MB JSON allowance with operation-specific bounded metadata payloads |
| VM memory | Keep at least 1 GiB `MemAvailable` at the observed combined peak, including API release overlap; record worker/broker/Node memory separately |
| Navigation demo | Drain/pause heavy authoring before the field navigation session; continuous tracking runs on the phone, with cloud requests separately bounded |

Treat the Node memory ceiling as a failure boundary: if exceeded, the job must become interrupted/failed with a recoverable attempt, while the API remains available. Do not silently raise limits or retry indefinitely. Measure the worker/broker and establish their service limits from the same rehearsal before enabling production authoring.

The important peak is compressed image -> decoded pixels -> processing buffers -> serialized copies. A 40-million-pixel RGBA buffer alone is approximately 153 MiB; actual processing may retain additional buffers. The local Windows pipeline dependency tree is about 108 MiB and its current `.local` directory about 17.6 MiB. These are local disk observations, not Linux runtime memory estimates or forecasts of production storage.

Sharp provides independent cache and thread controls ([official documentation](https://sharp.pixelplumbing.com/api-utility/)). Node's `--max-old-space-size` limits V8 old space rather than total process memory ([official documentation](https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib)); use OS-level accounting/limits for native buffers as well. Porting the same image workload into a Celery process does not eliminate these costs.

## 4. Persistence and configuration

- Keep provider and internal-service credentials in protected server environment configuration, outside Git/releases. Define the exact variable contract before adding services; inject only the subset each process requires. Node needs model credentials, not `DATABASE_URL`, `DATABASE_MIGRATOR` or Django's secret key.
- Retain Django-owned media/index storage under the existing shared persistent root. Add a distinct writable pipeline workspace there, with per-job/attempt paths, asset hashes, private permissions and explicit cleanup. Node's current relative `.local`/`output` paths must be made configurable before using immutable release directories.
- PostgreSQL remains metadata authority. The IA-4 prebuilt catalog/SQLite is an internal fixture/import mechanism, not another shared business database. Import accepted demo assets through Django's asset contract and preserve original SVG bytes/provenance.
- Record interrupted work and validate source revision/hash before write-back. Preserve useful stage caches for explicit resume; do not let an old attempt overwrite a newer draft. Reconcile queued/running jobs after broker/process restart; durable jobs alone do not guarantee reliable dispatch.
- Bound journals, intermediate images, failed-job retention and release/dependency caches. Define expiry for reproducible temporary files, while retaining active/previous releases, accepted assets and original acceptance evidence. Reclaim only unreferenced artifacts; never delete source evidence with a blanket age rule.
- Browser Local Storage records are disposable personal test data and need no migration. Clearing them is a separate action; this plan performs no deletion.

Initial deployment uses private local files already supported by the architecture. R2 integration is not a prerequisite for this increment; external storage can follow after its adapter is verified.

## 5. Deployment implementation sequence

1. **Restore branch readiness and specify the adapter.** Resolve R-01's CI classifier mismatch and recorded lint debt without rewriting preserved audit evidence. Review the newly fetched main changes. Define one authorized source -> durable job -> Node proposal -> stored draft contract, including retries, idempotency, cancellation, source identity and permissions.
2. **Prove one local Linux integration slice.** Implement the Django/worker adapter and narrow private Node operation. Start with a deterministic fixture, then a manually enabled real-provider trial. Keep image generation, semantic extraction and the IA-4 mock distinct; no paid Vectorizer call is needed.
3. **Extend packaging.** Include committed pipeline runtime/shared code and its lockfile; exclude `.env*` secrets, `.local`, outputs, experiments and personal files. Pin a Linux-tested Node version supporting the modules used, including native SQLite. Install production dependencies with `npm ci --omit=dev` into a reusable Linux/architecture/runtime/lockfile-keyed dependency directory, outside the immutable release. Never copy Windows `node_modules` onto Linux.
4. **Add native services.** Extend the reviewed server installer/controller for the private Redis broker, one authoring worker and one private Node service, with independent identities/permissions as needed, persistent paths, restricted environment injection, resource limits and readiness. Keep Angular builds and tests in CI, not on the VM.
5. **Promote with a short authoring maintenance window.** Stop new authoring admission, drain or explicitly interrupt/checkpoint the active attempt, then stop the worker before switching Node. Start/probe the new Node version, start its compatible worker, run the adapter smoke check and reopen admission. Existing public reads/navigation stay available; do not introduce a second Node slot merely to avoid this short authoring pause.
6. **Rehearse and enable.** Record CPU, RSS/cgroup memory, VM available memory, disk growth, request latency and failure recovery with the actual IA workload. Enable the authoring capability only after the gates below pass. Publish the measured operating limits and rollback procedure.

Node and its worker must use the same release/adapter version. Extend deployment component hashes and manifests so pipeline-only changes are packaged/promoted, API-only compatible releases can reuse unchanged compute artifacts, and frontend/docs-only changes do not restart compute. Preserve the existing API blue/green behavior. Store the previous compatible Node/worker pair for rollback; database/schema compatibility still requires independent checks.

## 6. Acceptance and rollback

| Gate | Evidence required before enabling the capability |
|---|---|
| Authorization | Anonymous and wrong-target writes denied; browser cannot reach private compute; no client-supplied reviewer authority |
| Persistence | Real job/attempt and asset/draft records survive restart; duplicate dispatch and stale results cannot duplicate/publish data |
| Capacity | Real image and largest intended demo input complete within limits; no OOM/sustained swapping; at least 1 GiB VM headroom at measured peak |
| Isolation | Health, login/session and published-route reads remain responsive during compute; proposed pilot gate: p95 server response under 1 second and no new 5xx for these non-model requests under the agreed demo load |
| Failure | Deadline, Node termination, broker restart and provider rejection reach honest recoverable states without automatic repeated paid calls |
| Release | Pipeline-only packaging, incompatible adapter rejection, drain, failed-start preservation and previous-pair rollback demonstrated |
| Honest demo | IA-4 missing fixture remains pending; IA-1 navigation is separate; live Vectorizer stays disabled with empty credentials |

Keep offline contract/deployment checks in affected-path CI, using deterministic small fixtures and dependency caches. Model calls, real image performance and physical-device walks remain explicit manual acceptance; do not run them for each push. Existing isolated green tests do not establish this new integration.

If a gate fails, leave authoring disabled and continue the prebuilt-map navigation demo. First reduce copies/resolution and keep execution serial. If necessary, schedule authoring outside navigation or move computation off the VM in a separately reviewed increment. Consider a Python migration only when a measured, isolated Node overhead or substantial maintenance burden justifies it; language consolidation alone is not the capacity remedy.

Rollback closes admission, stops the worker, records/reconciles interrupted attempts, restores the previous compatible Node/worker pair and probes it before reopening. Never roll back or overwrite accepted assets and database revisions as a side effect of restoring executables.

## 7. Stage conclusion

The selected plan is one Django business authority plus one private, resource-bounded Node compute service, using the existing planned background-worker stack on the current VM. This is simpler for the present stage than rewriting the pipeline or adding another hosting platform. Its implementation, actual capacity, deployment changes and IA-4 fixture remain open work; this documentation update installs nothing and triggers no deployment.
