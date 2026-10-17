# API

Django/DRF modular monolith. `config/` owns configuration, URL routing, health
checks and Celery setup; `accounts/` supplies the custom user model. Django Admin
supports internal inspection only.

`maps/` provides map/contribution snapshots, assets/references, review and
publication models. `jobs/` provides durable jobs/attempts; `navigation/` provides
later N0 session/capture/result/route persistence. See the
[database schema](../../docs/database-schema.md) for tables, PostgreSQL integrity
rules, migration instructions and service boundaries.

Authorized domain services and product APIs remain to be implemented. REST, jobs
and MCP will invoke those same services. Google OAuth (django-allauth) and session
identity endpoints are documented in
[backend-oauth.md](../../docs/backend-oauth.md); paste Web client credentials into
`local/env/api.env` when available.

See [development instructions](../../docs/development.md).
