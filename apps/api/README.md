# API

Django/DRF modular monolith. `config/` owns configuration, URL routing, health
checks and Celery setup; `accounts/` supplies the custom user model. Django Admin
supports internal inspection only.

`maps/` provides map/contribution snapshots, assets/references, review and
publication models. `jobs/` provides durable jobs/attempts; `navigation/` provides
later N0 session/capture/result/route persistence. See the
[database schema](../../docs/database-schema.md) for tables, PostgreSQL integrity
rules, migration instructions and service boundaries.

Map membership helpers and DRF permission classes are documented in
[backend-permissions.md](../../docs/backend-permissions.md). Broader map/contribution
product APIs remain to be implemented; REST, jobs and MCP should call the same
authorized services. Google OAuth and session identity:
[backend-oauth.md](../../docs/backend-oauth.md) (credentials in `local/.env`).

`navigation/` also exposes the photo-localization gateway under
`/api/navigation/localize/` (signed-in user, visitor `NavigationSession`, or a
DEBUG-only dev token), which forwards frames to the place-match engine:
[mobile-ios-api.md](../../docs/mobile-ios-api.md).

See [development instructions](../../docs/development.md).

Configuration: use only ignored `local/.env` and the root
[`.env.example`](../../.env.example). Follow the
[sync guide](../../docs/environment-sync.md) after pulling env changes: obtain
private values through the external channel, validate, clear stale shell
overrides and restart affected services. Never create an API-specific env file.
