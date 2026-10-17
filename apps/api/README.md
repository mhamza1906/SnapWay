# API

Django/DRF modular monolith. `config/` owns configuration, URL routing, health
checks and Celery setup; `accounts/` supplies the initial custom user model and
migration. Django Admin supports internal inspection only.

Future map/contribution, asset/reference, publication and job modules should be
introduced with their behavior, authorized domain services and migrations.
REST, jobs and MCP will invoke those same services. No product models or endpoint
contracts are frozen here. Google allauth is installed but not enabled until
credentials and the real login flow are integrated and tested.

See [development instructions](../../docs/development.md).
