# Visitor text route guidance

**Branch:** `feature/visitor-text-route-guidance`  
**Status:** Backend implemented (frontend teammates wire UI).  
**Decisions:** **1B** (Dijkstra + template directions + optional Gemini rewrite) · **2A** (destination on `NavigationSession` before first photo).

Personal history: ignored `local/ACTIONS.md`.  
Related: [localization-visitor-match.md](localization-visitor-match.md), [mobile-visitor-ui.md](mobile-visitor-ui.md).

## Goal

After the visitor chooses a destination and the **first** photo `likely_match` yields a start node, the API builds a shortest path (Dijkstra on open-edge costs) and returns steps + readable instructions. Gemini may rewrite template prose when enabled; it never invents topology.

## ID contract (critical)

| Surface | ID meaning |
| --- | --- |
| `GET /api/maps/public/buildings/` `destinations[].id` | Node **`stable_id`** |
| MegaLoc / localize `node_id` / `location_id` | Node **primary key** |
| `NavigationSession.destination` / `RoutePlan` FKs | Node **primary key** |
| Session create body | `destination_stable_id` (+ `publication_id`) → resolved to PK |
| Localize / route JSON | Both `*_node_id` (PK) and `*_stable_id` where a node is exposed |

Passing a Node PK as `destination_stable_id` returns `unknown_destination` (covered by tests).

## API

### `POST /api/navigation/sessions/`

Anonymous (throttled `navigation_session`). Body:

```json
{ "publication_id": "<uuid>", "destination_stable_id": "<uuid>" }
```

**201:** `session_id`, `secret` (once), `destination_node_id`, `destination_stable_id`, `expires_at`, …

### `POST /api/navigation/localize/`

Unchanged multipart. With `Authorization: Navigation <secret>` and a session destination, first `likely_match` attaches `route` (RoutePlan). Later calls reuse the same plan for the session `context_version`.

Also returns `node_stable_id`, `destination_node_id`, `destination_stable_id` when applicable.

### `GET /api/navigation/sessions/current/route/`

Requires Navigation secret; returns active `route` or null.

## Implementation map

| Piece | Path |
| --- | --- |
| `RoutePlan` model | [`navigation/models.py`](../apps/api/navigation/models.py) |
| Session create | [`navigation/services/session.py`](../apps/api/navigation/services/session.py) |
| Dijkstra | [`navigation/services/routing.py`](../apps/api/navigation/services/routing.py) |
| Templates | [`navigation/services/directions.py`](../apps/api/navigation/services/directions.py) |
| Gemini rewrite | [`navigation/services/gemini_rewrite.py`](../apps/api/navigation/services/gemini_rewrite.py) |
| Persist + localize hook | [`navigation/services/route_plan.py`](../apps/api/navigation/services/route_plan.py), [`views.py`](../apps/api/navigation/views.py) |
| Tests | [`test_routing.py`](../apps/api/tests/test_routing.py), [`test_navigation_session.py`](../apps/api/tests/test_navigation_session.py) |

Frames are **not** stored. Capture-backed `Route` / `LocalizationResult` remain for future retention approval.

## Env

Contract **2026-10-18.1** adds:

| Key | Default | Meaning |
| --- | --- | --- |
| `NAVIGATION_SESSION_RATE` | `30/min` | Throttle for session create |
| `ROUTE_GEMINI_REWRITE` | `false` | Enable Vertex prose rewrite |

Rewrite uses existing **`VERTEX_API_KEY` / `VERTEX_PROJECT` / `VERTEX_LOCATION` / `VERTEX_MODEL`** (team default `gemini-4-argon`), same transport as map authoring — **not** `GEMINI_API_KEY`. Set `ROUTE_GEMINI_REWRITE=true` to enable; on failure localize still returns template instructions.
## Frontend handoff

1. After room select: `POST /api/navigation/sessions/` with `publication_id` + `destination_stable_id` from public buildings.  
2. Store `secret`; send `Authorization: Navigation <secret>` on localize.  
3. On first `likely_match`, read `route.steps` / `route.instructions_text`.  
4. Do not send destination on the localize body.  
5. Treat UI destination `id` as **stable_id** only.

## How to verify

```sh
uv run pytest apps/api/tests/test_routing.py apps/api/tests/test_navigation_session.py -q
```
