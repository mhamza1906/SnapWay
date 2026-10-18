# Map editor (My maps → Edit)

Updated October 18, 2026. Active branch: `feature/frontend-iteration`.
Personal history: ignored `local/ACTIONS.md`.

## Scope

API-backed floor editing for developers: icon toolbar, graph canvas gestures,
four-direction reference photos, and a deferred **Build with AI** side panel
(shell only). My maps cards open `/graph-editor?target=<uuid>`. Architecture:
[Indoor_Navigation_Architecture_and_Dependencies_EN.md](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md).
Graph tools baseline: [map-graph-tools.md](map-graph-tools.md). Media:
[map-node-media.md](map-node-media.md).

## Map setup (`/authoring`)

Full-bleed workspace panel (same outer padding as comparison review; no narrow
max-width shell). No AI pipeline chrome on this page:

- Search an existing workspace building, or create a new one
- Optional latitude / longitude
- Upload floor plan (PNG / JPEG / WebP) → **GPT Image 2.5** → `/map-optimize`
  review ([map-image-optimize.md](map-image-optimize.md))
- Or open the manual graph editor without Image 2.5

Page title lives in the app header; the page keeps only the short supporting
sentence. Existing buildings load from `GET /api/maps/workspace/`. Create uses
`POST /api/maps/workspace/`.

## Layout and tools

- Top row of square icon tools with hover tips (select/drag/box-select, add,
  connect, cut, pan, upload underlay, undo/redo, select-all, delete, labels,
  fit/zoom, Build with AI, submit/publish).
- Left workspace sidebar toggles with the sandwich (menu) control in the app
  chrome (`WorkspaceLayout`).
- Build with AI opens a right panel with a close control. When sidebar width +
  AI width ≥ 45% of the viewport, opening AI collapses the sidebar; the user may
  reopen it manually.
- AI agent/tool calls are **not** connected; the panel queues local preview
  messages only.

## Gestures

Select tool supports click, Shift-additive selection, marquee box select, and
group drag with boundary clamping. Space or Hand pans; wheel zooms. Arrow keys
nudge the selection. Shortcut keys: V / N / C / X / H.

Undo/redo (Ctrl/Cmd Z, Ctrl/Cmd Shift Z) records the last gesture (move, add,
connect, cut, property/weight edits, delete) and replays the inverse command.
Local graph state updates immediately; the inverse still syncs through Django.

## Latency and keep-alive

Warm `list_graph` on Tiger is ~200ms; the writable lock is ~400ms. Graph SVG
math is cheap — perceived CRUD delay was waiting on that RTT before painting.

Mitigations now in place:

1. **Optimistic edits** — add / connect / cut / move / property changes update
   the local signals first; server `PATCH`es run on a serial queue so
   `lock_version` stays ordered. Canvas tools stay usable while `syncing`.
2. **Client node ids** — `create_nodes` sends a UUID so undo/delete works before
   the response returns.
3. **Editor keep-alive** — `EditorRouteReuseStrategy` detaches `/graph-editor`
   instead of destroying it when leaving My maps / setup. Returning to the same
   `?target=` reattaches the live component (underlay + canvas stay warm). One
   target is cached at a time. Detached instances ignore keyboard shortcuts.

Nested `add_edge`/`remove_*` helpers still do not take a second lock inside
`edit_graph`. The underlay URL stays stable across ordinary applies so the
~440KB SVG is not reloaded per edit. Cold first list after idle can still be >1s.

## Four-direction photos

Inspector slots: Front / Right / Back / Left (plan-up, clockwise). Uploads go to
Django `ReferencePhoto` with `capture_context.direction` and
`heading_degrees` 0/90/180/270. Embedding remains `not_connected`. Slot replace
deletes the prior directed photo row; Asset bytes stay append-only.

## IA Level 1 draft (source-of-truth candidate)

Manual graph on target `a86cda61-7b52-43dc-85e1-54a412aba7ef`
(title: *IA Building — IA - Level 1 (manual review)*), revision
`28b57628-ae05-428a-b6e3-e5fcdde7af4f`, underlay SVG 1536×1024.

Inventory:
[assets/2026-10-17-map-editor/ia-level1-graph-inventory.json](assets/2026-10-17-map-editor/ia-level1-graph-inventory.json).

| Metric | Value |
| --- | --- |
| Waypoints | 46 |
| Directed edges | 92 |
| Isolated nodes | 0 |
| Labels marked `(verify)` | 15 (human secondary correction) |
| Four-direction smoke | Passed on *North hall centre* (DB + list API) |

Open in the running app (reuse existing `4200` / `8000` processes):

`http://127.0.0.1:4200/graph-editor?target=a86cda61-7b52-43dc-85e1-54a412aba7ef`

After human correction, this draft is intended as the Level 1 source of truth for
AI authoring accuracy tests. Do not invent missing rooms (e.g. Muffler/Hive) on
this floor without underlay evidence.

## Non-goals

- Live AI agent / tool execution
- Embedding / place-match indexing of photos
- Replacing reviewed publication workflow
- Auto-tracing walls from SVG paths
- Offline-first / service-worker graph cache

## Changed files

| Path | Role |
| --- | --- |
| [apps/web/.../authoring/](../apps/web/src/app/features/authoring/) | Compact map setup UI |
| [apps/web/.../graph-editor/](../apps/web/src/app/features/graph-editor/) | Toolbar, inspector, AI shell, optimistic gestures |
| [apps/web/.../editor-route-reuse.ts](../apps/web/src/app/core/editor-route-reuse.ts) | Hide/reattach graph editor |
| [apps/web/src/app/app.config.ts](../apps/web/src/app/app.config.ts) | Registers keep-alive strategy |
| [apps/api/maps/services/editor.py](../apps/api/maps/services/editor.py) | Atomic editor gestures |
| [apps/api/maps/services/references.py](../apps/api/maps/services/references.py) | Directed photo upload |
| [docs/assets/2026-10-17-map-editor/](assets/2026-10-17-map-editor/) | Inventory / QA assets |

## Action summary

1. Rebuilt `/authoring` to search/create building + lat/lng + upload only.
2. Optimistic local graph updates with serialized server sync.
3. Route reuse keep-alive for `/graph-editor` hot return to the same target.
4. Frontend suite: 86 passed.
