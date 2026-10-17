# Manual map graph tools

Shared feature record for API-backed waypoint/edge editing on
`feature/map-graph-tools`. Personal history: ignored `local/ACTIONS.md`.

## Approved scope and design

Thin vertical slice (plan 1C + 2A + UI overhaul): shared Django graph commands,
REST, MCP wrappers, and a simplified Angular graph editor. Architecture:
[Indoor_Navigation_Architecture_and_Dependencies_EN.md](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
(geometry / MCP — navigation **graph ≠ wall geometry**). Writes require
[Membership](backend-permissions.md) (`volunteer` or `admin`) on an **unfrozen**
head `Revision`. Underlay SVG/raster is a **display** asset only.

Waypoints use `checkpoint` or `junction` with an optional label. Do **not** use
`kind=room` yet (requires `Room` FK). Draft mutations are in-place on the unfrozen
revision; full ChangeSet → new revision snapshots are a documented follow-up.

Default underlay in the UI: [`apps/web/public/demo/floor-plan.svg`](../apps/web/public/demo/floor-plan.svg).
Upload replaces it for display. When `S3_*` / R2 is configured, underlay and
node photo bytes are stored in Cloudflare R2 — see [map-node-media.md](map-node-media.md).

## Non-goals

- Auto AI graph generation / wall tracing
- `kind=room` + Room CRUD
- Immutable ChangeSet per click / full server undo
- Production MCP auth / Streamable HTTP
- Committing `.cursor/rules`

## How to run

```sh
# API (loads secrets from local/.env — see docs/environment-sync.md)
python scripts/dev.py api

# Web (proxies /api, /accounts, /media)
cd apps/web && npm start
# open http://127.0.0.1:4200/graph-editor
```

Sign in via Google (`/accounts/google/login/`) or an Admin session cookie.
`POST /api/maps/drafts/ensure/` resumes the caller's latest open draft when no
`target_id` is supplied (edits auto-save on each action — there is no separate
Save button). Pass `{force_new: true}` or use **New map** in the UI to start a
fresh target. The editor pins `?target=<uuid>` in the URL after ensure.

Optional seed:

```sh
uv run --locked --extra ai --extra geometry --extra mcp python apps/api/manage.py seed_graph_draft --email=you@example.com
```

MCP (local stdio; actor from `SNAPWAY_MCP_ACTOR_EMAIL` or first staff):

```sh
python scripts/dev.py mcp
```

Tools: `graph_list`, `graph_add_node`, `graph_remove_node`, `graph_add_edge`,
`graph_remove_edge`. Status resource sets `map_tools_enabled: true` for this
scaffold. See [apps/mcp/README.md](../apps/mcp/README.md).

## Env contract

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Tiger / Postgres (or omit for SQLite fallback) in `local/.env` |
| `SNAPWAY_MCP_ACTOR_EMAIL` | Optional MCP actor email (local only) |

Secrets: **`local/.env` only** — never repo-root `.env`. See [environment-sync.md](environment-sync.md).

## REST

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/maps/drafts/ensure/` | Optional `{target_id}` |
| `GET` | `/api/maps/revisions/<uuid>/graph/` | Nodes + edges + underlay URL |
| `POST` | `/api/maps/revisions/<uuid>/nodes/` | `{x,y,label?,kind?}` |
| `DELETE` | `/api/maps/revisions/<uuid>/nodes/<uuid>/` | Deletes incident edges |
| `POST` | `/api/maps/revisions/<uuid>/edges/` | `{from_node_id,to_node_id}` |
| `DELETE` | `/api/maps/revisions/<uuid>/edges/<uuid>/` | |
| `POST` | `/api/maps/revisions/<uuid>/underlay/` | Multipart `file` (PNG/JPEG/WebP/SVG, ≤5 MiB) |

## Underlay rules

- Stored under `MEDIA_ROOT` as `underlays/<target_id>/…`
- Creates `Asset` (`source` or `svg`) and sets `revision.source_asset`
- SVG must parse with defusedxml and must not contain script/event handlers
- Served at `/media/…` in development (`DEBUG`)

## Verify

```sh
uv run --locked --extra ai --extra geometry --extra mcp pytest apps/api/tests/test_graph.py apps/mcp/tests/test_transport.py
uv run --locked --extra ai --extra geometry --extra mcp ruff check .
uv run --locked --extra ai --extra geometry --extra mcp ruff format --check .
cd apps/web && npm test && npm run build
```

## Changed files

| Path | Role |
| --- | --- |
| [apps/api/maps/services/draft.py](../apps/api/maps/services/draft.py) | Ensure demo draft |
| [apps/api/maps/services/graph.py](../apps/api/maps/services/graph.py) | Node/edge commands |
| [apps/api/maps/services/underlay.py](../apps/api/maps/services/underlay.py) | Filesystem underlay upload |
| [apps/api/maps/views_graph.py](../apps/api/maps/views_graph.py) | REST views |
| [apps/api/maps/urls.py](../apps/api/maps/urls.py) | Graph routes |
| [apps/api/maps/management/commands/seed_graph_draft.py](../apps/api/maps/management/commands/seed_graph_draft.py) | Local seed |
| [apps/api/config/urls.py](../apps/api/config/urls.py) | MEDIA in DEBUG |
| [apps/api/tests/test_graph.py](../apps/api/tests/test_graph.py) | API/service tests |
| [apps/mcp/server.py](../apps/mcp/server.py) | graph_* tools + status flag |
| [apps/mcp/README.md](../apps/mcp/README.md) | MCP limits |
| [apps/web/src/app/features/graph-editor/](../apps/web/src/app/features/graph-editor/) | Simplified editor UI |
| [apps/web/src/app/core/graph-api.service.ts](../apps/web/src/app/core/graph-api.service.ts) | Angular API client |
| [docs/map-graph-tools.md](map-graph-tools.md) | This feature record |

## Action summary

1. Branched `feature/map-graph-tools` from `feature/backend-permissions`.
2. Implemented draft ensure + graph/underlay services, REST, MCP wrappers.
3. Replaced primary map-editing entry with API-backed `/graph-editor`.

## Commits

- `5836b4e` — Add API-backed graph editor with node photos on Cloudflare R2.
