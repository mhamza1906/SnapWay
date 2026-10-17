# Native deployment boundary

Follow the [shared environment contract](../docs/environment-sync.md): the root
[`.env.example`](../.env.example) is the only active template; production retains
one protected `/etc/indoor-nav/api.env`. New activation code validates that file
against the release contract before changing services. Install the reviewed
controller/validator together and reconcile the server file first; this branch
has not installed or deployed those changes.

The selected deployment remains Vultr Ubuntu + Caddy + Gunicorn + Celery +
private Redis + private MCP, with Tiger Data as the production PostgreSQL service.
Docker is excluded. No cloud account, DNS, server, production database or
deployment has been created by repository initialization.

The [deployment guide](../docs/deployment.md) records the SnapWay target, one-time
server setup, protected configuration, gated Actions deployment, versioned
releases, health checks and rollback. Keep writable assets and credentials outside
immutable releases. Deployment stays disabled until server setup is complete and
the production Actions variable is enabled; no live release has been verified.
