# IA Building multifloor (Levels 1–3)

Manual / seeded indoor graphs for the IA Building with stair and lift
correspondence across floors for cross-floor routing.

## Scope

- Level 1 remains the human-authored draft (graph editor).
- Levels 2 and 3 are seeded from ignored `local/test-source` vector SVGs
  (`IA-floor-2-vectorized.svg`, `IA-floor-3-vectorized.svg`), referenced against
  `IA-*-floor-original.jpg`.
- `FloorConnector` rows bind matching stair/lift shafts on floors 1–3.
- Floor 4 is out of scope for this pass.

## How to run

Reuse existing API/web processes on `8000` / `4200`. Schema DDL uses
`DATABASE_MIGRATOR` (runtime `DATABASE_URL` cannot `CREATE TABLE`):

```bash
# one-shot migrator wrapper (or temporarily point DATABASE_URL at DATABASE_MIGRATOR)
uv run python apps/api/manage.py migrate maps 0007_floor_connector

uv run python apps/api/manage.py seed_ia_multifloor --email yuanerfang0@gmail.com
# rebuild underlays/graphs: add --force
```

Open editors:

| Floor | URL |
| --- | --- |
| 1 | `http://127.0.0.1:4200/graph-editor?target=a86cda61-7b52-43dc-85e1-54a412aba7ef` |
| 2 | `http://127.0.0.1:4200/graph-editor?target=55614282-3f94-40fe-b6c0-1845bc1d5cbb` |
| 3 | `http://127.0.0.1:4200/graph-editor?target=a6ac25b3-80b2-453d-aaec-74a2ec15dde1` |

Connectors API (Developer mode):

`GET /api/maps/workspace/buildings/14b949ec-227e-4b30-8d59-960705b7cc11/connectors/`

## Seeded inventory (DEV DB)

| Floor | Target | Nodes | Directed edges | Frame |
| --- | --- | --- | --- | --- |
| 1 | `a86cda61-…` | 48 | 96 | 1536×1024 |
| 2 | `55614282-…` | 27 | 74 | 1536×1024 |
| 3 | `a6ac25b3-…` | 22 | 60 | 1578×657 |

Seven connectors (`stair-a`…`stair-d`, `stair-j`, `lift-south`, `lift-north`),
each with endpoints on floors **1, 2, and 3**. Shared `stable_id`s identify the
same shaft across revisions.

Evidence:

- [ia-multifloor-connectors.json](assets/2026-10-18-ia-multifloor/ia-multifloor-connectors.json)
- [ia-level2-graph-inventory.json](assets/2026-10-18-ia-multifloor/ia-level2-graph-inventory.json)
- [ia-level3-graph-inventory.json](assets/2026-10-18-ia-multifloor/ia-level3-graph-inventory.json)

## Model

`maps.FloorConnector` (migration `0007_floor_connector`): per-building `code`,
`kind` (`stairs`|`lift`), and JSON `endpoints` listing
`{floor_code, target_id, node_id, node_stable_id, label}`. Edges stay
per-revision; routing joins floors through these rows.

## Non-goals

- Automatic wall tracing from SVG paths
- Publishing Levels 2–3 (remain drafts until human review)
- Floor 4 seed
- Full visitor multi-floor route UI (API + DB ready; client join next)

## Changed files

| Path | Role |
| --- | --- |
| [apps/api/maps/models.py](../apps/api/maps/models.py) | `FloorConnector` |
| [apps/api/maps/migrations/0007_floor_connector.py](../apps/api/maps/migrations/0007_floor_connector.py) | Schema |
| [apps/api/maps/management/commands/seed_ia_multifloor.py](../apps/api/maps/management/commands/seed_ia_multifloor.py) | Seed L2/L3 + wire connectors |
| [apps/api/maps/services/workspace.py](../apps/api/maps/services/workspace.py) | `building_connectors` |
| [apps/api/maps/views_workspace.py](../apps/api/maps/views_workspace.py) | Connectors GET |
| [apps/api/maps/urls.py](../apps/api/maps/urls.py) | Route |
| [apps/api/tests/test_floor_connectors.py](../apps/api/tests/test_floor_connectors.py) | API smoke |
| [docs/assets/2026-10-18-ia-multifloor/](assets/2026-10-18-ia-multifloor/) | Inventories |

## Action summary

1. Added `FloorConnector` and applied `0007` via migrator credentials.
2. Seeded IA Levels 2–3 underlays + corridor/POI graphs on building `14b949ec-…`.
3. Aligned Level 1 vertical `stable_id`s; created missing Stair B / North lift.
4. Wrote seven 1–2–3 connectors; exposed `GET …/buildings/<id>/connectors/`.
