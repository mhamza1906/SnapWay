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
and MCP will invoke those same services. Google allauth is installed but not enabled until
credentials and the real login flow are integrated and tested.

See [development instructions](../../docs/development.md).
