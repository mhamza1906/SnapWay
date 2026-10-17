# Native deployment boundary

The selected deployment remains Vultr Ubuntu + Caddy + Gunicorn + Celery +
private Redis + private MCP, with Tiger Data as the production PostgreSQL service.
Docker is excluded. No cloud account, DNS, server, production database or
deployment has been created by repository initialization.

The [deployment guide](../docs/deployment.md) records the SnapWay target, one-time
server setup, protected configuration, gated Actions deployment, versioned
releases, health checks and rollback. Keep writable assets and credentials outside
immutable releases. Deployment stays disabled until server setup is complete and
the production Actions variable is enabled; no live release has been verified.
