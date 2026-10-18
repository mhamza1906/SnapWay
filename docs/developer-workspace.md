# Developer workspace and publication lifecycle

Updated October 18, 2026. Branch: `feature/frontend-iteration`.
This is the active workspace specification, implementation guide and acceptance
record. It supersedes the prototype workspace menus and browser-storage workflow
in [frontend iteration](frontend-iteration.md) and [frontend prototype](frontend-prototype.md).
Personal execution details remain in the contributor's ignored `local/ACTIONS.md`.

## Workspace routes

| Route | Behavior |
| --- | --- |
| `/explore` | Shared Google map. Yellow markers = buildings with current publications; red markers = draft-only floors visible to the signed-in developer (`GET /api/maps/workspace/buildings/`). Header hosts search + locate; classic Map markers (not Advanced Marker / DEMO_MAP_ID). |
| `/my-maps` | Server-owned map cards sorted by the caller's latest edit time, descending; centered grid with one to three cards per row. |
| `/authoring` | **Request new map** for Developers; **Initialize new map** for provisioned administrators. Both use the same existing AI pipeline. Manual editing also works when AI is unavailable. |
| `/graph-editor?target=<uuid>` | Create/resume the caller's pinned editing snapshot; upload underlay, edit graph and attach waypoint photographs. Finish submits for review or immediately approves/publishes when the caller administers this target. |
| `/developer-contribution` | Administrator-only grids for pending submissions, reviewed submissions and archived maps. Scope is enforced by the server. |
| `/developer-contribution/:id` | Latest published version beside the selected submission/historical publication, with synchronized pan/zoom, explicit latest-version refresh and review/archive actions. |
| `/developer-contribution/activity` | Administrator audit activity, most recent 200 events. |
| `/settings` | Download map JSON, navigation graph JSON or an SVG display map; no browser backup or restore. |

Old `/overview`, `/targets` and `/editor/:id` URLs redirect to My maps. Anonymous
`/map` remains public discovery; signed-in Public Users are sent to `/public`
(visitor journey). `/navigate` redirects to `/public`. Developers preview the
visitor journey at `/app-preview`. The separate native visitor entry is preserved.
The verified Developer login landing still passes through the compatible
`/overview` redirect before reaching My maps.

The workspace header uses the existing navy/blue camera/road/arrow wordmark and
a centered title (or, on Explore, the search field + locate control). Page bodies
keep a single supporting sentence—no repeated eyebrow/h1 stacks. Long waits share
one global semi-transparent spinner overlay via `UiService`. The account menu uses
the authenticated Google account's `picture` claim, with HTTPS Google image-host
validation and an initials fallback. Sign out and same-account Public User
switching live in this menu. There is no selectable administrator identity or
self-service administrator registration.
[Google's profile claim documentation](https://developers.google.com/identity/openid-connect/openid-connect)
defines the profile-picture URL; the client does not construct one from email.

## Explore and building identity

Developer Explore loads `GET /api/maps/workspace/buildings/` (developer session):
every open target the caller can see that has building latitude/longitude.
Buildings with any current publication render yellow; draft-only buildings
render red. Public visitor discovery remains
`GET /api/maps/public/buildings/` (published only). Clicking a marker opens a
panel bounded by the map viewport. It progressively reveals 20 floor cards at a
time as the panel scrolls; an accessible Load more button provides the same
operation. Closing the panel leaves every marker on the map. Locate places a
blue user pin and pans the map.

Clicking another Google POI or a map position starts a building selection and
offers the role-appropriate creation flow. Published buildings also have an
accessible mapped-buildings list. A new floor requires a building name, code and
coordinates, or an existing building ID; floor codes are unique within a building.
Google place IDs, when available, identify the same building across requests.
Creating a floor cannot move or rename an existing building's published metadata.

Place-name/address lookup follows Google's
[POI click events](https://developers.google.com/maps/documentation/javascript/examples/event-poi)
and [Place Details](https://developers.google.com/maps/documentation/javascript/place-details)
APIs. These features require **Places API (New)** on the Maps browser key's
project and API restrictions, in addition to Maps JavaScript API. This uses the
existing restricted browser key; it introduces no env key. If Places lookup is
unavailable, selecting a position and entering the building name/coordinates
still works. Geolocation uses browser permission; GPS is not a cookie permission.

## Editing, review and archive rules

1. Starting an edit locks the target and copies the current publication into a
   new contribution/revision. Rooms, map objects, nodes, edges, reference photos,
   relationships and their associations are copied; stable feature IDs and asset
   references are retained. Draft database IDs are new. Resuming returns the
   same draft, even after another publication changes. Requested changes resume
   from the author's declined content in a new draft. An unpublished proposal can
   likewise be used as the author's next snapshot. Unpublished content is copied
   without a parent foreign key, so a later approved copy cannot prevent destruction
   of its still-pending predecessor; published ancestry remains linked.
2. Only its author can mutate an active draft. Other target members cannot read
   another author's private draft or edit it. Administrators can inspect submitted
   content; Developer/Public mode remains a separate session permission boundary.
3. Finishing requires an underlay and at least one waypoint, freezes a SHA-256
   digest of the revision content and creates a matching required SVG artifact.
   A Developer's contribution becomes `submitted` and remains unpublished.
   An administrator's own completion creates approval and publication immediately.
4. Approval locks the same target and publishes the submitted head as the next
   sequence. **The last approved submission wins**, even when its base is older
   than the current publication. Earlier publication rows and frozen revisions
   remain historical records. Existing approvals cannot approve a different head.
   Rejection/requested changes require nonempty feedback.
5. Archiving takes that target lock, removes its current publication from discovery
   and physically deletes every draft/submitted/changes-requested contribution and
   its revision content, artifacts, reviews and dependent jobs. Unreferenced assets
   from discarded work are removed while publication assets and source chains are
   retained. Late requests cannot restore those submissions. Merged/rejected
   history remains available until explicit permanent deletion.
6. Only an administrator of that map can permanently delete an archived map.
   The UI requires a second confirmation. This deletes its versions, memberships,
   map audit records, assets and dependent navigation/job records. The server logs
   the deleted target/user IDs. Blob deletion runs after database commit through
   the existing best-effort storage adapter; a storage outage can require orphan
   blob cleanup even though the database deletion has succeeded.

Mutation lock order is target → contribution → revision. Approval and archival
share the target lock. Normal PostgreSQL snapshot/review/publication immutability
guards remain active. A narrow transaction-local purge scope permits DELETE only
on the specifically archived target; it never permits editing frozen content or
deleting another target's immutable history.

Staff/superusers administer all targets. Database-provisioned target administrators
administer their assigned targets and can initialize new targets as administrators;
ordinary Developers join published targets as volunteers when starting an edit.
Revoked membership cannot be reactivated through the editor. No client-supplied
role/status/approval flag grants authority.

## AI and exports

The existing authoring pipeline, providers and paid-call controls are unchanged.
Upload/build/doorway refinement use the same worker endpoints for both roles.
Continue in My maps editor transfers only the selected floor's geometry, room
records, nodes, directed/weighted connections and rendered SVG into the caller's
Django draft. Other floors and duplicate embedded source images are omitted from
the JSON request. Import does not publish; the editor's explicit finish action
applies the server-side role rule. Import requires an empty draft to protect
manual edits. Pipeline SVG previews render as images rather than trusted HTML.

JSON exports contain geometry, coordinate frame, graph, room metadata and
reference-photo descriptors. Graph exports omit wall geometry. SVG display exports
contain the supplied floor-plan image and vector graph, with an embedded underlay
so the file does not depend on an expiring signed URL. A raster source remains a
raster underlay; this is not a claim of automatic wall vectorization. The existing
Vectorize/mock plan and pending IA-4 fixture are unchanged by this workspace work.

The active web workspace does not instantiate `PrototypeRepository` or maintain
localStorage maps. Existing personal browser test data is ignored. Historical
prototype source/tests and the separate native visitor code remain available for
the Public User teammate's replacement; they are not workspace persistence.

## HTTP contract

All `/api/maps/workspace/` routes require an authenticated Developer-mode session
and return `Cache-Control: no-store`. Mutation requests use Django CSRF protection.

| Method and suffix | Purpose |
| --- | --- |
| GET / POST root | List caller's maps / create building-floor draft. List cards omit `preview_url` so the grid does not download full underlay SVGs/images per card; the UI shows a map icon until dedicated thumbnails exist. |
| GET `buildings/` | Developer Explore markers: open floors with coordinates (yellow if published, red if draft-only). |
| GET/POST `targets/<id>/optimize/…` | Image 2.5 raster optimize status/upload/regenerate; see [map-image-optimize.md](map-image-optimize.md). |
| POST `targets/<id>/vectorize-demo/` | Demo-only fixed IA floor-4 SVG (no Vectorizer.AI). |
| POST `targets/<id>/edit/` | Resume or clone the caller's editing snapshot. |
| POST `contributions/<id>/pipeline/` | Import selected pipeline floor, SVG and graph into an empty owned draft. |
| POST `contributions/<id>/submit/` | Freeze draft, submit or automatically approve/publish according to server authority. |
| GET `contributions/` | Administrator-scoped submission/archive inventory. |
| GET `contributions/<id>/?revision=<uuid>` | Latest/selected comparison and publication history; optional historical selection. |
| POST `contributions/<id>/` | Review with `decision` and `feedback`. |
| POST / DELETE `targets/<id>/archive/` | Archive and discard pending work / permanently delete archived map. |
| GET `targets/<id>/export/?kind=json\|graph\|svg` | Authenticated download; `kind` avoids DRF's reserved `format` parameter. |
| GET `activity/` | Administrator-scoped audit feed. |

Existing `/api/maps/revisions/<id>/...` graph/media routes remain in use with the
new ownership and lifecycle checks. Existing `/api/maps/public/buildings/` adds
optional `place_id`; draft geometry remains private. `/api/auth/me/` adds `picture`.

## Migration and environment handoff

Apply maps migrations `0004` (building place identity/edit timestamps), `0005`
(publication/purge guards) and `0006` (database timestamp defaults for previous-release
writers) using the existing migration credential. They were
successfully applied to the configured development PostgreSQL database after the
member supplied `DATABASE_MIGRATOR`. The runtime account remains a non-owner.
No env names, shared defaults or dependencies changed; the existing
[single-env contract](environment-sync.md) still applies. The production owner
must apply these migrations through the normal deployment controller, which
already selects `DATABASE_MIGRATOR`; do not give runtime services owner credentials.

If another member lacks the migration credential, obtain it through the external
private channel into the existing `local/.env`; retain the root template unchanged.
Run `python scripts/env_contract.py check` after synchronization. Local validation
does not claim that production or another member has synchronized credentials.

## Acceptance

Automated coverage checks Developer pending review versus administrator immediate
publication, two isolated editors and last-approval overwrite, owner-only mutation,
Public-mode denial, archival/pending destruction, permanent deletion, selected-floor
pipeline import and publication-only discovery/exports. Frontend coverage includes
55-floor progressive scrolling and yellow-marker persistence.

The real PostgreSQL smoke uses newly created records within a transaction that is
fully rolled back. It exercises the installed immutability guards, pinned edits,
stale-base acceptance, archive purge and hard deletion. Browser acceptance uses
clearly named temporary QA floors; those fixtures and their memberships/assets
are removed after acceptance. No paid AI model calls are needed for these checks.

Validation: **116 backend/MCP tests passed** in the SQLite profile, with 17
PostgreSQL-only cases skipped there; **all 16 existing PostgreSQL integrity test
bodies** passed separately on rolled-back fixtures, along with the real lifecycle
smoke, published-copy/pending-predecessor regression and actual SQL inserts omitting
the new timestamp fields to simulate the previous release. **80 frontend tests
passed** across 18 files. Final targeted App/graph tests, Web/Visitor production
builds, Prettier, repository Ruff/format, env contract and migration-drift checks
passed. No new dependency or env-template field was introduced.

Chrome acceptance verified real Google Places building lookup/prefill, persistent
yellow markers, bounded floor panels, centered three-column/partial-row grids,
server-saved connection weights, linked comparison zoom, historical selection,
administrator approval/publication, archive destruction of pending work, permanent
deletion through its confirmation, audit activity, exports and Google profile menu.
No physical Android/iOS device acceptance or paid provider inference is claimed.

Implementation commit: `75cb5d7` (local), followed by timestamp compatibility and
final acceptance documentation. Remote publication is a separate handoff.

All temporary browser QA targets, test accounts, memberships and checked storage
objects were removed after acceptance; original account/map records were retained.
The screenshots below show those explicitly labeled, temporary QA maps:

- [Explore and bounded floor panel](assets/2026-10-17-developer-workspace/explore.png)
- [My maps: three columns and centered final row](assets/2026-10-17-developer-workspace/my-maps.png)
- [Latest publication / submitted version comparison](assets/2026-10-17-developer-workspace/comparison.png)
- [Server-owned snapshot and weight editing](assets/2026-10-17-developer-workspace/graph-editor.png)
- [Export-only settings](assets/2026-10-17-developer-workspace/exports.png)

## Implementation files

### API and database

- [apps/api/README.md](../apps/api/README.md)
- [apps/api/accounts/serializers.py](../apps/api/accounts/serializers.py)
- [apps/api/accounts/views.py](../apps/api/accounts/views.py)
- [apps/api/maps/migrations/0004_building_google_place_id_contribution_updated_at_and_more.py](../apps/api/maps/migrations/0004_building_google_place_id_contribution_updated_at_and_more.py)
- [apps/api/maps/migrations/0005_workspace_lifecycle_guards.py](../apps/api/maps/migrations/0005_workspace_lifecycle_guards.py)
- [apps/api/maps/migrations/0006_alter_contribution_updated_at_and_more.py](../apps/api/maps/migrations/0006_alter_contribution_updated_at_and_more.py)
- [apps/api/maps/models.py](../apps/api/maps/models.py)
- [apps/api/maps/services/draft.py](../apps/api/maps/services/draft.py)
- [apps/api/maps/services/graph.py](../apps/api/maps/services/graph.py)
- [apps/api/maps/services/references.py](../apps/api/maps/services/references.py)
- [apps/api/maps/services/retention.py](../apps/api/maps/services/retention.py)
- [apps/api/maps/services/underlay.py](../apps/api/maps/services/underlay.py)
- [apps/api/maps/services/workspace.py](../apps/api/maps/services/workspace.py)
- [apps/api/maps/urls.py](../apps/api/maps/urls.py)
- [apps/api/maps/views.py](../apps/api/maps/views.py)
- [apps/api/maps/views_graph.py](../apps/api/maps/views_graph.py)
- [apps/api/maps/views_workspace.py](../apps/api/maps/views_workspace.py)
- [apps/api/tests/test_database_schema.py](../apps/api/tests/test_database_schema.py)
- [apps/api/tests/test_workspace_lifecycle.py](../apps/api/tests/test_workspace_lifecycle.py)

### Web workspace

- [apps/web/README.md](../apps/web/README.md)
- [apps/web/src/app/app-account.scss](../apps/web/src/app/app-account.scss)
- [apps/web/src/app/app.html](../apps/web/src/app/app.html)
- [apps/web/src/app/app.routes.ts](../apps/web/src/app/app.routes.ts)
- [apps/web/src/app/app.scss](../apps/web/src/app/app.scss)
- [apps/web/src/app/app.spec.ts](../apps/web/src/app/app.spec.ts)
- [apps/web/src/app/app.ts](../apps/web/src/app/app.ts)
- [apps/web/src/app/app-overlays.scss](../apps/web/src/app/app-overlays.scss)
- [apps/web/src/app/core/auth.service.ts](../apps/web/src/app/core/auth.service.ts)
- [apps/web/src/app/core/google-maps.service.ts](../apps/web/src/app/core/google-maps.service.ts)
- [apps/web/src/app/core/graph-api.service.ts](../apps/web/src/app/core/graph-api.service.ts)
- [apps/web/src/app/core/ui.service.ts](../apps/web/src/app/core/ui.service.ts)
- [apps/web/src/app/core/workspace-api.service.ts](../apps/web/src/app/core/workspace-api.service.ts)
- [apps/web/src/app/core/workspace-chrome.service.ts](../apps/web/src/app/core/workspace-chrome.service.ts)
- [apps/web/src/app/features/authoring/authoring.html](../apps/web/src/app/features/authoring/authoring.html)
- [apps/web/src/app/features/authoring/authoring.spec.ts](../apps/web/src/app/features/authoring/authoring.spec.ts)
- [apps/web/src/app/features/authoring/authoring.ts](../apps/web/src/app/features/authoring/authoring.ts)
- [apps/web/src/app/features/developer/activity.ts](../apps/web/src/app/features/developer/activity.ts)
- [apps/web/src/app/features/developer/comparison.scss](../apps/web/src/app/features/developer/comparison.scss)
- [apps/web/src/app/features/developer/comparison.ts](../apps/web/src/app/features/developer/comparison.ts)
- [apps/web/src/app/features/developer/contributions.ts](../apps/web/src/app/features/developer/contributions.ts)
- [apps/web/src/app/features/developer/explore-overlays.scss](../apps/web/src/app/features/developer/explore-overlays.scss)
- [apps/web/src/app/features/developer/explore.scss](../apps/web/src/app/features/developer/explore.scss)
- [apps/web/src/app/features/developer/explore.spec.ts](../apps/web/src/app/features/developer/explore.spec.ts)
- [apps/web/src/app/features/developer/explore.ts](../apps/web/src/app/features/developer/explore.ts)
- [apps/web/src/app/features/developer/exports.scss](../apps/web/src/app/features/developer/exports.scss)
- [apps/web/src/app/features/developer/exports.ts](../apps/web/src/app/features/developer/exports.ts)
- [apps/web/src/app/features/developer/help.ts](../apps/web/src/app/features/developer/help.ts)
- [apps/web/src/app/features/developer/my-maps.ts](../apps/web/src/app/features/developer/my-maps.ts)
- [apps/web/src/app/features/developer/revision-preview.ts](../apps/web/src/app/features/developer/revision-preview.ts)
- [apps/web/src/app/features/developer/workspace.scss](../apps/web/src/app/features/developer/workspace.scss)
- [apps/web/src/app/features/graph-editor/graph-canvas.html](../apps/web/src/app/features/graph-editor/graph-canvas.html)
- [apps/web/src/app/features/graph-editor/graph-editor.html](../apps/web/src/app/features/graph-editor/graph-editor.html)
- [apps/web/src/app/features/graph-editor/graph-editor.scss](../apps/web/src/app/features/graph-editor/graph-editor.scss)
- [apps/web/src/app/features/graph-editor/graph-editor.spec.ts](../apps/web/src/app/features/graph-editor/graph-editor.spec.ts)
- [apps/web/src/app/features/graph-editor/graph-editor.ts](../apps/web/src/app/features/graph-editor/graph-editor.ts)
- [apps/web/src/app/shared/snapway-brand.ts](../apps/web/src/app/shared/snapway-brand.ts)

### Related documentation

- [docs/backend-permissions.md](../docs/backend-permissions.md)
- [docs/database-schema.md](../docs/database-schema.md)
- [docs/frontend-iteration.md](../docs/frontend-iteration.md)
