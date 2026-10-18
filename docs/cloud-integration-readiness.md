# Main/mobile integration: cloud and localization readiness

October 18, 2026. This record accompanies the integration of main into
`feature/map-authoring-pipeline`. It records actual checks and the remaining
production boundary; it does not claim deployed Sam Ibrahim navigation.
Canonical matching remains [MegaLoc](localization-megaloc.md); cloud deployment
uses the existing [Vultr release process](deployment.md) and
[single environment contract](environment-sync.md). Execution details and private
backup paths remain in ignored `local/ACTIONS.md`.

Implementation: [ab0c726](https://github.com/mhamza1906/SnapWay/commit/ab0c726).

## Checked services and storage

| Component | Observed state |
| --- | --- |
| Public Vultr API | `https://snapway.work/api/health/live/` and `/api/health/ready/` return 200 JSON. These checks do not establish feature release identity or localization readiness. |
| This contributor's database | SQLite, with 156 reference-photo records. These local map records have not been transferred into Tiger Data. |
| Cloudflare R2 | Configured for reference photos, underlays, shared PDFs and revision-index assets. Private bucket permissions remain unchanged. |
| Local localization engine | Initially unavailable; now started on loopback port 8790 with current code, existing runtime, cached pinned weights and CPU with 8 threads. Health confirms MegaLoc ready, Vertex disabled, and frame retention disabled. This does not start a cloud engine. |
| Google Maps | Browser key configured; expose only the existing client-config allowlist. Website-key presence does not prove native WebView authorization. |
| Private env contract | `local/.env` is missing; Django still uses the existing legacy `local/env/api.env` fallback. No values were printed or changed. Obtain the consolidated private configuration through the team's external channel, run the contract migration/check, and restart affected services. |

## Native networking

Read-only production OPTIONS requests included Authorization/content-type headers
for both `/api/client-config/` and `/api/navigation/localize/`:

| Origin | HTTP result | CORS result |
| --- | --- | --- |
| `https://localhost` (Android) | 200 | Exact origin and requested headers allowed. |
| `capacitor://localhost` (iOS) | 200 | No allow-origin response, so direct JavaScript calls are blocked. |

Those checks describe direct WebView HTTP. The integrated native bundle now
uses the existing Capacitor HTTP bridge for application XHR/fetch, so this iOS
CORS omission does not block that native transport. No production CORS or SSH
configuration was changed. If direct WebView networking is selected later, the
production owner must add `capacitor://localhost` to the existing
`CORS_ALLOWED_ORIGINS`, retaining approved entries, and reload Django through the
release workflow. Visitor calls use scoped Navigation Authorization capabilities;
no shared engine token belongs in the app. These preflights do not approve
cross-origin contributor sessions: cookie SameSite policy and OAuth callbacks
still require the established hosted authentication flow. Do not add a wildcard
origin or ship a server credential in either native bundle.

Google Maps JavaScript uses a restricted website key. A hosted, same-origin map
view can keep that web authorization and existing Maps loader; an opaque native
origin must not be assumed equivalent to an approved website referrer.

## Matching and route boundaries

Reference embeddings are built once from the contributor's existing photos using
[the index service](../apps/api/maps/services/reference_index.py), saved as private
R2 ZIP assets under `indexes/<target>/<revision>/<hash>.zip`, and registered as
ready `RevisionArtifact` rows. The engine's
[global catalog](../apps/place-match/placematch/catalog_index.py) loads matching
vectors into RAM and embeds only each incoming frame. No phone-video retention,
model downloads or paid provider calls are required for this path.

Production catalog eligibility requires current publications; DEBUG also permits
unfrozen draft indexes. The Sam authoring project and its 11 photo walks remain
agent-inspected drafts. A ready index does not certify access, publish a map, or
turn an uncertain match into a confirmed location.

Main's [published route service](../apps/api/navigation/services/routing.py)
requires open, verified edges and exact revision-pinned `FloorConnection` rows.
`FloorConnector` catalog metadata does not automatically create those transfers.
Sam's source-authored Node route preview remains an inferred authoring feature.
Do not silently merge isolated walk targets, publish drafts, invent physical
measurements, or mark inferred connections human-reviewed to enable the visitor
route screen.

During the merge, [graph payloads](../apps/api/maps/services/graph.py) retain
stable IDs, room IDs and optimistic versions alongside saved directional-photo
progress. [Photo replacement](../apps/api/maps/services/references.py) retains
R2-only directional storage, validates image bytes and removes dependent scene
relationships safely. Photo-walk uploads explicitly declare validated `direction_frame=walking_relative`,
with no invented absolute plan heading; older imported walks retain that rule
without a new client field. Advanced editor uploads keep the default plan frame.
Unknown frames and attempts to label imported walk views as absolute plan views
fail without storage writes. The
[walk importer](../apps/api/maps/management/commands/import_photo_walks.py) retains
the source SVG coordinate frame independently of display-raster dimensions.

## Built and verified reference indexes

The existing index service built exactly two owned Sam draft indexes and stored
both ZIPs in R2. Each archive was downloaded again and checked against its full
SHA-256 and byte size. Archive vectors have 8,448 columns and map exactly to the
existing reference-photo/node IDs.

| Walk | Ready artifact ID | Reference vectors | Photographed nodes | ZIP bytes |
| --- | --- | ---: | ---: | ---: |
| Level 1 circulation 2 | `0b9a3b5a-7133-4170-bf57-f2ed0b1659be` | 104 | 26 | 3,265,018 |
| Level 2 circulation 2 | `067a4314-1847-4aae-9f16-0b13ca3560bf` | 52 | 13 | 1,633,000 |

Level 1 ZIP SHA-256:
`67e35f288eaa384ffd2a33618fe9fd8244f3cf6e209ef7819a963f5223585c7b`.
Level 2 ZIP SHA-256:
`d7f89f1da65f75678d4193793a160cf30444cbef96de0e6e75987e3c9e69952c`.

A consistent SQLite backup and complete before/after snapshots confirm all
156 reference-photo rows and all 629 nodes across the 11 Sam drafts are unchanged.
No publication, review decision, graph verification or cloud-database transfer
was created. The other planned stops have no reference embeddings until photos
are supplied.

The current DEBUG catalog admits these unfrozen draft indexes without changing
eligibility rules. The engine loaded all 156 vectors into RAM. Repeating the
index build skipped embedding, and repeating catalog sync performed no R2 fetch.
A query using one exact existing reference image returned its own node as top
candidate and `likely_match`. The current Django localization view, internally
authenticated as the existing owner and calling the real engine, also returned
200 with the correct `matched_node` and a signed location handoff. This is an
integrity/transport smoke check, not an
independent accuracy result. That first local request took about 2.38 seconds,
including 2.24 seconds for embedding; it is not a live-phone performance benchmark.

The reused calibration is identified as `sha256:f9e628afac13`; it has not been
recalibrated or validated for this building. No provider calls, package installs,
model downloads or stored incoming video were used. The API's normal signed-in
DEBUG path can see the ready draft indexes; public visitor sessions remain
restricted to published maps and cannot use these unpublished walks.

## Deployment work still required

The [follow-up Vultr runtime preparation](cloud-runtime-packaging.md#current-state) installed pinned Node, locked Python dependencies and verified MegaLoc weights successfully. One synthetic CPU inference passed. The CI identity cannot install permanent systemd services; the prepared administrator command is documented there. Protected API configuration, calibration/catalog synchronization and Sam metadata transfer remain separate.

The [read-only CI audit](https://github.com/mhamza1906/SnapWay/actions/runs/39115318153)
successfully authenticated using the existing GitHub Actions Vultr identity,
without the contributor's local SSH key. On October 18 it observed 3 CPU threads,
7,935 MiB RAM (7,263 MiB available), 8,191 MiB swap and about 208 GiB free disk.
Only `snapway-api-green.service` was listed as active. `python3`, `uv` and `caddy`
were available to that identity; `node` was absent from its PATH. Private ports
5175 and 8790 did not respond. Public liveness/readiness returned 200; the new
hosted-map route returned 404 because this feature is not deployed. No protected
env file was read, and no server configuration or application data was changed.
These observations supersede the older two-CPU/four-GB estimate for capacity
planning, without demonstrating model speed or readiness on this host.

The [default release packager](../scripts/package_release.py) ships API and web.
The new opt-in [mobile runtime package](cloud-runtime-packaging.md) also includes
Node pipeline/Sam renderer sources and `apps/place-match`, plus unit templates;
it does not install or activate those services. The existing Vultr
controller starts the API, not a localization engine. Therefore deploying this
API alone cannot run `build_reference_index`'s normal subprocess or provide live
MegaLoc inference. Use the selected deployment boundary and obtain the server
owner's capacity/operational acceptance before provisioning compute. Existing
MegaLoc device selection supports Apple MPS or CPU; simply renting a CUDA GPU
does not enable CUDA selection in this implementation.

Keep Tiger Data as production metadata authority and R2 as private blob storage.
Moving this contributor's local records requires a backed-up, identity-preserving
transfer of map/revision/node/photo/asset relationships, permissions and R2 keys;
changing `DATABASE_URL` alone does not copy them. Keep the local prototype intact
until that migration is independently checked. No production records, server
environment, bucket policy, cloud resource or deployment were changed by this
audit.

## Validation

Backend merge regressions cover graph editing and optimistic conflicts, photo
slots/R2 signing/failure preservation, source coordinates, workspace lifecycle,
private draft access, reference indexes and published photo routes. The full
local API run reached 202 passing cases and 19 PostgreSQL-only skips; its sole
failure was a missing OpenAPI declaration on the added draft-list GET. After
adding that declaration, all 18 configuration cases pass. The new walk-heading
regression and the final focused media/editor run pass (33 tests). Migration
state inspection reports no model changes pending generation. PostgreSQL trigger
checks and physical-device/live recognition acceptance remain separate gates.

Implementation and regression references: [API routes](../apps/api/maps/urls.py),
[graph transport](../apps/api/maps/views_graph.py),
[photo/import regressions](../apps/api/tests/test_node_media.py),
[editor gesture/heading regressions](../apps/api/tests/test_editor_gestures.py).

## Developer phone test entry

The source-preserving [photo-walk editor](../apps/web/src/app/features/photo-walk-editor/photo-walk-editor.ts)
now offers **Test live matching** in both the map editor and phone collection
layout. Its [UI](../apps/web/src/app/features/photo-walk-editor/photo-walk-editor.html)
loads the existing authorized index-status API, shows the indexed photo count,
and enables the camera only for a ready saved index. It reuses the visitor camera
without a publication ID, so the existing signed-in developer matching and catalog
eligibility rules remain authoritative. A likely match highlights a node only
when the returned revision and node belong to the currently open draft; it never
renames nodes, writes routes, or publishes a map. Uncertain, unsupported and other
revision results do not force the selected stop. Closing the modal stops the
existing camera lifecycle. New or replaced reference photos still require an
index rebuild. Pending capture uploads and point identities are unchanged.
[Focused regressions](../apps/web/src/app/features/photo-walk-editor/photo-walk-editor.spec.ts)
cover ready-index gating, explicit camera opening, in-revision matching, stale or
uncertain results, single-shot closure and relative-direction upload semantics.
The [phone styling](../apps/web/src/app/features/photo-walk-editor/phone-walk.scss)
keeps the actions usable on small screens. All 11 photo-walk tests pass.
