# Map builder: 2D and 3D views (Sam Ibrahim Level 1)

The map builder (graph editor, `/graph-editor?target=…`) shows a **2D | 3D** toggle in its heading when the
target has a prebuilt 3D photo map. Today only **Sam Ibrahim · Level 1 circulation 2**
has one. The editor identifies it by the draft's building and floor metadata,
not an environment-specific target UUID: `Sam Ibrahim` / `Sam Ibrahim Building`
and Level 1 (including `1`, `Floor 1`, or `Level 1 circulation 2`). Explicit
circulations other than 2 are excluded. Local and production imports may have
unrelated IDs; the same matching map gets the toggle and `?view=3d` in either.

- **2D** is the existing editable canvas. Nothing about it changed.
- **3D** embeds a static three.js photo map of the same floor. It is view only:
  - The map view shows the floor-plan texture, tinted corridors, extruded walls with doorway gaps, room labels, and a pin for each of the 26 photo stops.
  - Clicking a stop flies to eye height with the stop's four photos (front, right, back, left) around the camera.
  - Arrows walk the real graph edges to neighbouring stops, and a minimap shows where you are.
- `?view=3d` opens the 3D view directly. If a "Point N" waypoint is selected when you switch, the 3D map opens at that stop.
- **Selection sync.** When the 3D map opens a stop, it posts `{type: 'snapway-map3d-stop', nodeId, label}` to the editor, same origin only. The editor then selects that waypoint, by id or, failing that, by label, so the inspector shows its four photo slots.
- **Shortcuts.** The editor's keyboard shortcuts are switched off while 3D is shown, so arrows and Esc only drive the 3D map.

## Files

| File                                                                                                                            | Purpose                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/web/src/app/features/graph-editor/graph-editor.ts`](../apps/web/src/app/features/graph-editor/graph-editor.ts)           | `map3dScene` (building/floor metadata → scene URL), `viewMode`, `setView()`, `onMap3dMessage()`, shortcut guard                                                                                                 |
| [`apps/web/src/app/features/graph-editor/graph-editor.html`](../apps/web/src/app/features/graph-editor/graph-editor.html)       | 2D/3D toggle, iframe in place of the canvas                                                                                                                                                                     |
| [`apps/web/src/app/features/graph-editor/graph-editor.scss`](../apps/web/src/app/features/graph-editor/graph-editor.scss)       | Toggle and frame styles                                                                                                                                                                                         |
| [`apps/web/src/app/features/graph-editor/graph-editor.spec.ts`](../apps/web/src/app/features/graph-editor/graph-editor.spec.ts) | No toggle for other targets; switching to 3D, deep link and selection sync                                                                                                                                      |
| [`apps/web/public/map3d/sam-ibrahim-level1/`](../apps/web/public/map3d/sam-ibrahim-level1/)                                     | Static scene, about 13 MB: `3d/index.html` (viewer), `3d/level1.glb` (Floor/Corridors/Walls, 0.9 MB), `3d/stops.json`, `3d/rooms.json`, `3d/thumbs/` (512 px), `photos/` (104 photos at 900 px), `underlay.png` |

## Data and conventions

- **Source.** The scene was built outside this repo, in the Hack the Valley workspace, from a read-only export of the target's published graph: 102 nodes, 110 edges, and 26 photo stops with 104 photos checked against their SHA-256 in R2. The Blender script is `build_scene.py` and the stop builder is `build_stops.py`. The database and R2 were not written.
- **Coordinates.** One plan frame of 843 × 367, origin top-left, y down. Plan (x, y) maps to three.js (x − 421.5, h, y − 183.5).
- **Headings are estimated.** The export stores no camera heading. 13 stops use the rule "front faces the previous-numbered stop", and 13 use a visual override from landmarks (expected error about ±15–30°). The viewer says so and offers a 90° rotate with JSON export, saved in the browser only.
- **Walls are assumed.** They are extruded from the cleaned SVG outlines at a uniform 12 plan units, with gaps at the SVG doorway lines. There is no metric scale.
- **Static snapshot.** The 3D scene does not follow live edits to the draft graph; 2D stays the source of truth. Photos are resized copies (900 px) in the static bundle, not live R2 URLs.

## Dependencies and approval

- **No new npm dependency.** The static viewer loads `three@0.160.0` (pinned) from jsdelivr at runtime, like the prototype it came from. The architecture plan already lists `three` as a compatible library.
- **Approval.** The requesting member asked for this 2D/3D integration in the map builder on 2026-10-18.
- **Environment.** No environment or configuration changes.

## Checks

- **Unit tests.** `npx ng test --watch=false --include src/app/features/graph-editor/graph-editor.spec.ts` covers metadata matching across environments, other-floor/circulation exclusion, and 3D selection sync.
- **Full suite.** `npm run build` and `npm test` in `apps/web` are the full checks.

## Production identity repair (2026-10-18)

Removed the local-only target UUID allowlist. The scene now resolves from loaded
building/floor metadata before applying a `view=3d` deep link. Tests cover a
production-style target with another ID, selection sync by point label, supported
Level 1 names, and rejection of other buildings, floors and circulation areas.
No database, environment, media or dependency changes are required.

## Pipeline builder access

The `/authoring` Build a map screen also provides **2D / 3D photo map** controls
above the mapped Sam Ibrahim Level 1 plan. It embeds the same saved scene and
provides an **Open 3D map in a new tab** link. Room/door selection and 2D route
controls are hidden while viewing 3D; returning to 2D retains the source and route
state. Selecting another floor returns to 2D. Other floors and buildings do not
receive a scene toggle. No pipeline job or data mutation runs when changing views.

The scene identity helper is shared in `apps/web/src/app/core/map3d-scene.ts`.
Pipeline UI changes live in `features/authoring/authoring.ts`, `.html`, `.scss`
and `.spec.ts` under `apps/web/src/app/`.

Standalone access (no builder session required because these existing assets are
static): `/map3d/sam-ibrahim-level1/3d/index.html`, or append `#point-13`.
The snapshot remains limited to Level 1 circulation 2; it is not a live conversion
of arbitrary floors or current pipeline edits.
