# Native deployment boundary

The selected deployment remains Vultr Ubuntu + Caddy + Gunicorn + Celery +
private Redis + private MCP, with Tiger Data as the production PostgreSQL service.
Docker is excluded. No cloud account, DNS, server, production database or
deployment has been created by repository initialization.

Add reviewed Caddy/systemd/release/restore configuration when the actual domain,
runtime paths, service users and account profiles are known. Keep writable
assets and credentials outside immutable releases. The current GitHub workflow
checks builds and tests; it has no deployment credentials or promotion step.
