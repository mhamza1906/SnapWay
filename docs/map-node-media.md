# Node labels, reference photos, and R2 media

Shared feature record on `feature/node-photos-r2`. Personal history: ignored
`local/ACTIONS.md`. Builds on [map-graph-tools.md](map-graph-tools.md).

## Approved scope and design

- **Tiger Postgres** holds Node/Edge metadata, `Asset` rows, and `ReferencePhoto`
  associations.
- **Cloudflare R2** (S3-compatible) holds underlay and node photo **bytes**.
- Select a waypoint in the graph editor to edit its label and attach photos.
- Architecture: optional `storage` extra + Django `STORAGES` per
  [Indoor_Navigation_Infrastructure_Integration_EN.md](initial/Indoor_Navigation_Infrastructure_Integration_EN.md).

## Non-goals

- Cloudflare Images / Image Resizing product
- `kind=room` / Room CRUD
- Photo review workflow UI
- ChangeSet immutability
- Migrating older local-disk underlays from prior smokes
- Committing `.cursor/rules`

## Environment contract

Put values in ignored `local/.env` only (see [environment-sync.md](environment-sync.md)).
Canonical runtime vars:

| Variable | Meaning |
| --- | --- |
| `S3_ENDPOINT_URL` | e.g. `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_REGION_NAME` | `auto` |
| `S3_BUCKET_NAME` | R2 bucket |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | R2 API token |
| `S3_ADDRESSING_STYLE` | `path` |
| `S3_SIGNED_URL_TTL_SECONDS` | Signed GET TTL (default 300) |

Optional `R2_ACCOUNT_ID` / `R2_BUCKET_NAME` / `R2_*` keys fill empty `S3_*`.
Without a configured bucket, development falls back to filesystem `MEDIA_ROOT`.
Tests always use filesystem storage.

Configure the R2 bucket CORS for `http://127.0.0.1:4200` so signed image URLs
load in the Angular app.

Install: `uv sync --locked --extra ai --extra geometry --extra mcp --extra storage`
(`scripts/dev.py` includes `--extra storage`).

## REST

| Method | Path | Notes |
| --- | --- | --- |
| `PATCH` | `/api/maps/revisions/<uuid>/nodes/<uuid>/` | `{label}` |
| `GET` | `/api/maps/revisions/<uuid>/nodes/<uuid>/photos/` | Signed URLs |
| `POST` | `/api/maps/revisions/<uuid>/nodes/<uuid>/photos/` | Multipart `file` |
| `DELETE` | `/api/maps/revisions/<uuid>/photos/<uuid>/` | |
| `POST` | `/api/maps/revisions/<uuid>/underlay/` | Bytes → R2 when configured |

MCP: `graph_update_node` in addition to existing `graph_*` tools.

## Verify

```sh
uv run --locked --extra ai --extra geometry --extra mcp --extra storage pytest apps/api/tests/test_graph.py apps/api/tests/test_node_media.py apps/mcp/tests/test_transport.py
uv run --locked --extra ai --extra geometry --extra mcp --extra storage ruff check .
cd apps/web && npm test && npm run build
```

## Changed files

| Path | Role |
| --- | --- |
| [apps/api/config/storage_backends.py](../apps/api/config/storage_backends.py) | S3/R2 STORAGES resolution |
| [apps/api/maps/services/media_store.py](../apps/api/maps/services/media_store.py) | put/signed_url/delete |
| [apps/api/maps/services/underlay.py](../apps/api/maps/services/underlay.py) | Underlay via media_store |
| [apps/api/maps/services/references.py](../apps/api/maps/services/references.py) | Node photos |
| [apps/api/maps/services/graph.py](../apps/api/maps/services/graph.py) | `update_node` + signed underlay |
| [apps/api/maps/views_graph.py](../apps/api/maps/views_graph.py) | PATCH + photo routes |
| [apps/web/src/app/features/graph-editor/](../apps/web/src/app/features/graph-editor/) | Select inspector |
| [docs/map-node-media.md](map-node-media.md) | This feature record |

## Action summary

1. Branched `feature/node-photos-r2` from `feature/map-graph-tools`.
2. Wired django-storages for R2; node label PATCH; ReferencePhoto attach/list/delete.
3. Graph editor inspector for label + photos.

## Commits

- (pending until requested)
