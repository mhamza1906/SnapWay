# Frontend prototype

Interactive prototype on `feature/frontend-prototype`. This is the one shared feature
record for the frontend prototype; personal execution history is in ignored
`local/ACTIONS.md`. The [remote branch](https://github.com/mhamza1906/SnapWay/tree/feature/frontend-prototype)
is available for team testing; the [complete change set](https://github.com/mhamza1906/SnapWay/compare/main...feature/frontend-prototype)
links every implementation and documentation change against the baseline.

## Approved scope and design

The requester authorized a complete interactive frontend prototype with Local
Storage-backed services, simulated AI/device/navigation responses, staged Figma
synchronization and commits. The backend and its eventual API contracts remain
owned by their existing workstreams. The [architecture baseline](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
still governs feature boundaries and the separate visitor build.

Three journeys drive the implementation: mapping targets and contributions;
manual/AI-assisted map editing and reference collection; review/publication and
visitor wayfinding. Views use a quiet cartographic workspace: warm paper canvas,
white tools, charcoal text, orange actions and blue route overlays. Typography is
a compact sans-serif scale, with map objects and routes providing the distinctive
visual focus. Desktop editing uses a persistent navigation rail and inspector;
visitor guidance uses a responsive map and bottom instruction panel.

```text
Contributor: Overview → Targets → Target detail → Draft editor → Review
                                      ↓              ↓            ↓
                                  Publications   References    Publish
Visitor:     Building/floor → Destination → Capture → Route → Arrival
Operations:  Activity · Demo role · Settings · Data export/reset
```

Prototype models in [prototype.models.ts](../apps/web/src/app/core/prototype.models.ts)
are internal view models, not a backend schema proposal. No additional runtime
dependency was added. The detailed walkthrough and integration boundaries follow.

## Run and reset

```sh
cd apps/web
npm ci
npm start
```

Open `http://127.0.0.1:4200/overview`. Only the frontend is needed. Use `/welcome`
to choose a demo experience. The top-bar role selector switches between admin
and volunteer behavior; this is **not authentication**. The seeded contributor
is Erfang Yuan. All locations, plans and observations are fictional.

Use **Settings → Reset demo** for a repeatable starting point. Export a backup
first if changes matter. The same browser origin shares data between tabs;
`localhost`, `127.0.0.1`, different ports, other browsers and Android have separate
stores. To share a test scenario, export JSON and import it on the other device.
This is not multi-user collaboration or a server database.

Visitor-only build:

```sh
npm run build:visitor
npx cap sync android
```

The visitor entry has its own router shell and excludes contributor/editor pages.
Capacitor synchronization is separate from installing/running on Android. Serve
`dist/snapway-visitor/browser` with SPA fallback for a browser preview. No native
permissions or providers are invoked by this demo.

## Page and implementation map

| Route | Working behavior | Source |
| --- | --- | --- |
| `/welcome` | Demo role and visitor entry | [welcome](../apps/web/src/app/features/welcome/welcome.ts) |
| `/overview` | Live metrics, recent places, owned editable drafts and activity | [overview](../apps/web/src/app/features/overview/) |
| `/targets` | Search, status filters, grid/list, validated admin creation | [targets](../apps/web/src/app/features/targets/targets.ts) |
| `/targets/:id` | Latest/history maps, contribution creation, archive/reopen | [target detail](../apps/web/src/app/features/targets/target-detail.ts) |
| `/contributions` | Own contributions by state, feedback and stale-base warning | [contributions](../apps/web/src/app/features/contributions/contributions.ts) |
| `/editor/:id` | Source comparison, SVG editing, AI proposals, references, undo/redo, save and submit | [editor](../apps/web/src/app/features/editor/) |
| `/review` | Admin queue, search and target filter, stale/archived readiness badges | [review queue](../apps/web/src/app/features/review/review.ts) |
| `/review/:id` | Current/starting comparison, object diff, evidence, decisions and reconciliation | [review detail](../apps/web/src/app/features/review/review-detail.ts) |
| `/navigate?target=innovation` | Published floors, search, positioning simulation, route and guidance | [navigation](../apps/web/src/app/features/navigation/) |
| `/activity` | Latest 20 local events, target/text filters | [activity](../apps/web/src/app/features/activity/activity.ts) |
| `/settings` | Role, storage health, export/import and confirmed reset | [settings](../apps/web/src/app/features/settings/) |
| `/help` | Linked contributor, reviewer and visitor walkthroughs | [help](../apps/web/src/app/features/help/help.ts) |
| `/connection-check` | Original optional backend health diagnostic | [workspace](../apps/web/src/app/features/workspace/) |
| Unknown route/ID | Recovery links and useful empty state | [not found](../apps/web/src/app/features/not-found/not-found.ts) |

Shared presentation: [app shell/router](../apps/web/src/app/),
[SVG map renderer](../apps/web/src/app/shared/map-canvas.ts),
[icons](../apps/web/src/app/shared/icon.ts), [notifications](../apps/web/src/app/core/ui.service.ts),
and [global styles](../apps/web/src/styles.scss). The sidebar collapses on small
screens; editor panels reflow; motion respects `prefers-reduced-motion`. Inter is
bundled with its [SIL OFL license and pinned source](../apps/web/public/fonts/),
so the UI does not depend on a font CDN.

## Repeatable acceptance walkthrough

### 1. Contribute and publish

1. Reset the demo. Open **Innovation Centre → Start contribution**, or continue
   seeded `innovation-draft` from Overview.
2. Select **Studio 101** on the map/list. Change its name and **Apply properties**.
   Try Undo/Redo. A matching room-linked waypoint label follows a room rename;
   custom waypoint labels are preserved.
3. Choose **Add text** or **Add marker**, then click the map. Select it again and
   edit text/coordinates in Properties. Add a waypoint, choose **Connect waypoints**
   and click two circles. Duplicate edges are rejected; accessibility and closures
   are editable.
4. **Save draft** and reload. Draft changes persist while the publication remains
   unchanged. Leaving with unsaved map edits asks before discarding them.
5. **Submit for review**, enter a summary and confirm. The draft locks and review
   opens. Switch to Admin view if needed.
6. Compare latest/starting versions, changes and evidence. **Request changes** or
   **Reject** requires feedback; **Publish revision** requires a second confirmation.
7. Open the target: the new publication is current and previous snapshots are
   selectable under Published revisions. Open visitor preview to use the new map.

Corrections to a published map begin as a new contribution. Administrators use
request-changes for someone else's submitted draft; this prototype does not
impersonate its author or edit frozen publications in place.

### 2. Upload, simulate AI and collect references

1. Open **Science Commons**, which has no publication, and start a draft.
2. Choose **Use sample plan**, or **Download sample PNG** then upload it. The
   synthetic [floor plan SVG](../apps/web/public/demo/floor-plan.svg) is rendered
   to PNG in the browser for testing. Source/reference uploads accept decodable
   PNG, JPEG or WebP up to 1 MiB; raw uploaded SVG/HTML is rejected.
3. In Assistant, use `Standardize source` then **Apply proposal**. The simulated
   result reuses source pixels with a comparison treatment; it performs no image
   correction. Switch Original/Standardized/Editable map; test opacity, overlay
   and rotation.
4. Use `Create vector map` and apply. An empty map receives a deterministic
   three-room example with graph; existing geometry is retained. This does not
   trace arbitrary uploaded images.
5. Select a room and use `Rename selected room to Seminar 201`, or use
   `Add label Reception` / `Add waypoint`. Unknown/ambiguous requests return
   clarification. Test **Simulate failure**, Retry and Cancel. Run a request,
   make a manual change, then try applying its late result: it must be rejected.
6. Open **Reference photos**. Upload/use the sample; associate a waypoint and
   direction. **Analyze** supplies a simulated description. Correct it, mark
   reviewed and add it to the draft, then save.
7. Submit and inspect source/standardized/reference images in review. Every
   reference must be reviewed before publication. Disconnected room waypoints
   and missing room associations block publication.

Rotation/opacity are view controls, not calibrated map transforms. Maps use plan
coordinates `0..1000 × 0..640`; plan-up is not geographic north. Rooms are rectangles;
this prototype does not model wall topology, doors, 3D geometry, multi-floor routes
or authoritative accessibility measurements.

### 3. Visitor navigation

1. Open `/navigate`, choose building/floor and search **Robotics Lab**. Only
   publications are offered, including an archived target's last map. Select a
   destination from search or directly on the map.
2. Select **Main entrance** manually, or open camera simulation. Test permission
   states and Accepted/Ambiguous/Rejected/Error outcomes. Ambiguity requires an
   explicit candidate choice; the application does not invent a successful fix.
3. Review the route, confirm heading and begin. Advance with **Simulate next step**;
   check turns, current position and arrival. Toggle Map/Guided. Arrows are
   schematic, not world-anchored AR.
4. Select **Workshop 106** and enable step-free routing to exercise an unavailable
   route. To publish a blocked-edge restriction, add an alternate connection first
   and block a redundant edge: every room must remain connected for publication.
5. Test Offline and Background/Resume. Capture jobs cancel and stale observations
   are discarded. Manual navigation on the loaded snapshot remains available;
   this does not supply an offline app/service worker.
6. Leave navigation open in one tab and publish in another. A refresh notice
   appears; the running session keeps its prior snapshot until explicit refresh.

Routes use Dijkstra on an undirected graph, weighted by Euclidean plan distance.
Blocked edges and step-free restrictions are honored. Distances are uncalibrated,
so the UI does not claim metres, ETAs or physical accuracy. Visitor photo previews
accept up to 4 MiB and are neither persisted nor transmitted.

### 4. Conflicts and recovery

- Reset the demo first, exporting any work to keep. Publish seeded
  `innovation-review`, then open `innovation-draft`, now stale.
  Save it and follow **Compare revisions**. Reconcile objects manually, acknowledge
  that the complete draft replaces the latest document, then update its base.
  Submitted stale work first needs Request changes. No automatic merge occurs.
- Open a draft in two tabs. Save in one; the other retained draft cannot overwrite
  that version. Reload saved data or export the map and reconcile manually.
- Archive a target during an edit/AI job. Writes and publication are blocked;
  existing evidence and published navigation remain readable. Admin can reopen it.
- Import malformed JSON, unsupported schema, broken references, unsafe image
  sources or inconsistent history. Prior valid state remains intact. Reset/import
  require confirmation. Storage-quota errors are visible; failed writes never
  become successful in-memory saves.
- Switch to Volunteer: administration/publication are unavailable. These are
  frontend behavior guards; a real server must enforce all authorization.

## Data boundaries and retention

[PrototypeRepository](../apps/web/src/app/core/prototype.repository.ts) is the
single local command/read boundary. Signals expose targets, contributions,
profile and activity. Commands implement create/archive, start/save/submit,
review/rebase, import/export and reset. [Models](../apps/web/src/app/core/prototype.models.ts)
are internal view models, not a backend contract proposal.

Local Storage key: `snapway.prototype.v1`, schema 1. Writes validate the whole
state, persist it, then publish an immutable signal snapshot. Objects/publications
are deep-frozen; editor and visitor views copy snapshots. Expected draft versions
and publication bases detect stale work. Valid `storage` events refresh repository
state without overwriting unsaved editor data. Malformed external updates show an
error and preserve valid state.

[Validation](../apps/web/src/app/core/prototype.validation.ts) checks sizes, enums,
stable IDs, room/node/edge/reference links, image sources and publication readiness.
Only relative demo/assets paths and raster data URLs are stored as images. No
generated script, SVG markup or provider key is stored.

Retention: latest **20 activities** and **20 publications per target**. Old snapshots
can age out. Seeds start at Innovation v3 and Library v1 without invented earlier
history. Exports/imports contain retained history and images. Import limit:
**8,000,000 UTF-8 bytes**; browser quota may be lower and is handled separately.
Keep images small and export/reset during long sessions. Undo/redo is bounded,
session-local edit history, not a persistent revision journal.

## Replace placeholders when contracts arrive

| Boundary | Current implementation | Integration work |
| --- | --- | --- |
| Reads and commands | [PrototypeRepository](../apps/web/src/app/core/prototype.repository.ts) | Add agreed HttpClient DTO adapters and async loading/errors; map server authorization, pagination, expected-version/ETag conflicts and publication transactions. Do not send internal models as a guessed API schema. |
| AI authoring | `runAssistant` / `propose` in [editor](../apps/web/src/app/features/editor/editor.ts) | Extract an authoring-job service for agreed standardize/trace/edit endpoints or MCP; retain evidence, cancellation, job identity, validation, preview and application. |
| Scene analysis | `analyzeReference` in editor | Replace deterministic suggestions with provider response plus provenance/confidence; retain human review. |
| Device/localization | [DevicePreview](../apps/web/src/app/core/device-preview.ts), [CapturePanel](../apps/web/src/app/features/navigation/capture-panel.ts) | Wire Capacitor camera/orientation/lifecycle/location after permission/error contracts are agreed; retain context invalidation. Map accepted/ambiguous/rejected/error API responses. |
| Routing/rendering | [navigation-engine](../apps/web/src/app/core/navigation-engine.ts), [NavigationMap](../apps/web/src/app/features/navigation/navigation-map.ts), [MapCanvas](../apps/web/src/app/shared/map-canvas.ts) | Add directed edges, units, doors, floor transitions and calibrated pose/AR as agreed; preserve pinned publications. |
| Identity | Demo profile/role | Replace with real session/OAuth and server authorization. Role switch is a test control. |
| Files | Data URLs and JSON export | Add agreed uploads/storage URLs and lifecycle; retain evidence/revision associations and error feedback. |

No package manifest, backend, migration, MCP server, geometry package or API-contract
file is changed. The original HTTP health diagnostic remains available. Angular,
RxJS, Reactive Forms, Capacitor and TypeScript retain the approved versions.

## Verification and synchronization record

Shared behavior tests live beside protected features/services. They cover data
integrity, publication permissions/conflicts, editor undo/save, AI cancellation,
routes, pinned navigation, review confirmations and target UI workflows. Browser
evidence and ad-hoc capture helpers stay under ignored `local/`.

```sh
cd apps/web
npm run format:check
npm test
npm run build
npm run build:visitor
npx cap sync android
```

Run `python scripts/check_docs.py` at root to verify preserved initial docs.
CI retains changed-component filtering and concurrency cancellation. Dependency
installation/build time differs from the small behavioral test runtime; putting
essential regressions in ignored local files would hide them from teammates/CI.

[Prototype Figma file](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa): editable
screen layers and shared components/tokens synchronize at explicit milestones.
Capture scripts only enter ignored build copies. Screens are review snapshots;
the local app is the executable prototype. Figma edits do not automatically write
Angular files. Supply a frame link and requested change for the next round trip.

Capture IDs, screenshots and readbacks are private in `local/figma-prototype/`;
execution history stays in `local/ACTIONS.md`. The [setup record](frontend-workflow.md)
retains the earlier connection test. Final validation totals, frame links and
checkpoint hashes are recorded below as each milestone completes.

### Implementation checkpoint

- Initial scope and Figma smoke-test record: commit `d0711db`.
- Interactive application and first Figma sync: commit `984b00d`.
- Final navigation/upload regressions and validation: commit `80f985d`.
- First screen sync: [Overview, frame 8:2](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=8-2).
  Readback: 100 editable text nodes, 84 vectors, 248 frames and 3 shared-component
  instances, with zero missing fonts or UI raster images. Screenshot inspected.
- Format check passed; 51 tests across 8 files passed in 2.70 seconds of runner
  time. Production build passed with no bundle warnings. Original 14 documents
  still match their migration inventory. Additional final validation follows.

### Final code validation

- **57 tests / 10 files passed**, runner time 3.23 seconds. Added regressions cover
  canonical room-name search, capture fragments in full-screen routes and actual
  `File`/`FileReader` upload behavior (jsdom image decoding is simulated).
- Formatting passed. Production build: 326.36 kB initial JS/CSS, estimated 92.20 kB
  transfer; no budget warnings. Visitor build: 230.40 kB initial, 78.68 kB lazy
  navigation. These numbers exclude the separately served 352,240-byte font asset.
- `cap sync android` passed. Native Gradle build, emulator and real-device hardware
  tests were not run. Camera/location/AR/provider behavior remains simulated.
- Browser acceptance covered persisted room edits, submission, publication of v4,
  visitor readback, reference/AI proposal controls, manual route/arrival, camera
  recovery and mobile navigation/editor layouts. No horizontal overflow was found
  at the tested 390 px mobile width.
- Automated browser file attachment was blocked by the Chrome extension's disabled
  **Allow access to file URLs** permission. File validation, data-URL persistence,
  decode failure and stale-upload recovery passed component tests; this is not a
  claim of a completed browser file-upload test. The ordinary input and synthetic
  sample workflows remain available for manual testing.
- The backend, dependency manifests/locks and preserved initial documentation are
  unchanged. CI configuration remains as initialized; these are local validation
  results, not a claim that a new remote CI run passed.

### Final Figma synchronization

The 15 review frames below cover the main journeys and selected interaction states.
Text, vectors and layout layers are editable. Shared foundations use the app's
Inter typography and CSS color tokens. Desktop navigation and the 390 px mobile
view include an active route; the AI frame shows the explicit Apply/Discard gate.
Screenshots were inspected, including correction of mobile map scaling after
import. Figma snapshots do not execute the Local Storage workflows; use the local
app for behavior testing.

| View or state | Editable Figma frame |
| --- | --- |
| Workspace overview | [8:2](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=8-2) |
| Mapping targets | [21:828](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-828) |
| Target detail | [21:1232](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-1232) |
| Map editor | [21:1794](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-1794) |
| Contributions | [21:2713](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-2713) |
| Review queue | [21:2938](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-2938) |
| Review comparison | [21:3248](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-3248) |
| Activity | [21:4060](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-4060) |
| Settings | [21:4359](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-4359) |
| Getting started | [21:4697](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=21-4697) |
| Welcome | [27:3154](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=27-3154) |
| Desktop visitor with active route | [27:3451](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=27-3451) |
| Scene reference and simulated analysis | [27:3915](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=27-3915) |
| AI proposal awaiting application | [33:2406](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=33-2406) |
| Mobile visitor with active route | [33:3324](https://www.figma.com/design/2VCOOU7UZ9yYISGD30qoGa?node-id=33-3324) |

For the next iteration, provide the affected route/frame and desired behavior.
Update source and relevant regression checks, synchronize the changed Figma
frames, then record the commit and a concise feature note here; retain detailed
execution history in each contributor's `local/ACTIONS.md`.
