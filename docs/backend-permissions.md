# Backend map membership and permissions

Shared feature record for application-owned map roles on `feature/backend-permissions`.
Personal history: ignored `local/ACTIONS.md`. Session login remains in
[backend-oauth.md](backend-oauth.md); this layer decides **map** authority.

## Approved scope and design

Hamza Stage 1 backend slice: enforce `maps.Membership` (`admin` | `volunteer` per
`MapTarget`) so Google identity and Django `is_staff` never imply map powers by
themselves. Architecture:
[Indoor_Navigation_Architecture_and_Dependencies_EN.md](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
(identity module). Catalogue focus: AUTH-02 / AUTH-03 foundations.

Active membership = row with `revoked_at` null. Helpers live in
`maps.services.membership`; DRF classes in `maps.permissions`. No schema change;
reuse Eric’s existing `Membership` model.

## Non-goals

- Product Membership REST CRUD (list/grant/revoke over HTTP for the UI)
- Map target / contribution CRUD APIs (next story; will consume these permissions)
- Auto-grant from Google email domain
- Guest / public navigation capabilities (AUTH-04)
- Committing `.cursor/rules` (guidance stays in `AGENTS.md` + this doc)

## How to grant the first map admin

1. Ensure a Django user exists (OAuth login or `createsuperuser`).
2. Ensure a `MapTarget` exists (Admin or future APIs).
3. As **staff**, run:

```sh
uv run --locked --extra ai --extra geometry --extra mcp python apps/api/manage.py grant_map_membership \
  --email=mapper@example.com \
  --target-id=<MapTarget UUID> \
  --role=admin \
  --granted-by-email=staff@example.com
```

Revoke with the same command and `--revoke`. Django Admin also lists `Membership`
(and Building / Floor / MapTarget for FK picking). Staff is a **bootstrap/ops**
escape hatch only; product write APIs must use Membership roles, not staff.

## Permission classes for future map APIs

```python
from maps.permissions import IsAuthenticatedMapAdmin, IsAuthenticatedMapMember


class ExampleView(APIView):
    permission_classes = [IsAuthenticatedMapAdmin]

    def get_map_target(self): ...  # return MapTarget for this request
```

Views must expose `get_map_target()` or set `map_target` before permission checks.

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /api/auth/me/` | Includes read-only `memberships: [{target_id, role}]` when authenticated |
| `GET /api/maps/targets/<uuid>/access/` | Diagnostic: caller’s role or 403 (not product UI) |

Secrets: `local/.env` only (never repo-root `.env`).

## Tests

```sh
uv run --locked --extra ai --extra geometry --extra mcp pytest apps/api/tests/test_membership.py apps/api/tests/test_auth.py
uv run --locked --extra ai --extra geometry --extra mcp ruff check . 
uv run --locked --extra ai --extra geometry --extra mcp ruff format --check .
```

## Changed files

| Path | Role |
| --- | --- |
| [apps/api/maps/services/membership.py](../apps/api/maps/services/membership.py) | Grant/revoke/query helpers |
| [apps/api/maps/permissions.py](../apps/api/maps/permissions.py) | DRF Membership permission classes |
| [apps/api/maps/views.py](../apps/api/maps/views.py) | Diagnostic access endpoint |
| [apps/api/maps/urls.py](../apps/api/maps/urls.py) | `/api/maps/` routes |
| [apps/api/maps/admin.py](../apps/api/maps/admin.py) | Admin for Membership (+ building/floor/target) |
| [apps/api/maps/management/commands/grant_map_membership.py](../apps/api/maps/management/commands/grant_map_membership.py) | Bootstrap command |
| [apps/api/accounts/views.py](../apps/api/accounts/views.py) | `me` includes memberships |
| [apps/api/accounts/serializers.py](../apps/api/accounts/serializers.py) | OpenAPI membership summary |
| [apps/api/config/urls.py](../apps/api/config/urls.py) | Mount maps URLs |
| [apps/api/tests/test_membership.py](../apps/api/tests/test_membership.py) | Permission/membership tests |
| [docs/backend-permissions.md](backend-permissions.md) | This feature record |

## Action summary

1. Branched `feature/backend-permissions` from `feature/backend-oauth`.
2. Added membership service, DRF permissions, diagnostic access route, Admin, and
   `grant_map_membership` command.
3. Extended `/api/auth/me/` with active memberships; tests cover AUTH-02/03 basics.

## Commits

- `1f79869` — Add map Membership permission layer for admin and volunteer roles.
- `224e5ca` — Record membership permissions commit SHA in feature doc.
- Merged `origin/main` at `62bb39d` (OAuth on main + CI/deployment) into this branch.
