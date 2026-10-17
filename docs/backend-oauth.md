# Backend Google OAuth

Shared feature record for Google developer login via django-allauth and Django
sessions. Personal execution history is in ignored `local/ACTIONS.md`. Work lives
on branch `feature/backend-oauth`.

## Approved scope and design

Backend-only slice: wire already-locked `django-allauth[socialaccount]` for Google
OAuth, mount `/accounts/`, and expose session identity under `/api/auth/`. No new
Python dependency. Architecture baseline:
[Indoor_Navigation_Architecture_and_Dependencies_EN.md](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
(identity module) and
[Indoor_Navigation_Infrastructure_Integration_EN.md](initial/Indoor_Navigation_Infrastructure_Integration_EN.md)
§5.3 checklist.

Google establishes identity. The database decides map membership and roles
(`maps.Membership`). A Google account, email domain, or client-supplied role never
grants administrator powers. New social users are created with `is_staff=False`
and `is_superuser=False` via `accounts.adapters.SocialAccountAdapter`. Map role
enforcement is documented in [backend-permissions.md](backend-permissions.md).

### Database (Tiger Data PostgreSQL)

Development prefers the shared **Tiger Data** PostgreSQL URL from ignored
`local/.env` (`DATABASE_URL`). That file is the **only** private env
source for this project — do not use a repo-root `.env`.
`config.settings.development` loads `local/.env` exclusively.

Allauth `account` / `socialaccount` migrations have been applied on the Tiger
service (in addition to the earlier local SQLite spike). SQLite at
`local/dev.sqlite3` remains only when `DATABASE_URL` is unset.

## Non-goals

- Angular Sign in with Google UI / replacing the prototype role dropdown
- Android / native Google Sign-In
- Auto-assigning `maps.Membership` or staff from email domain
- JWT or non-session API tokens

## Environment contract

| Variable | Meaning |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud Web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud Web client secret (private) |
| `LOGIN_REDIRECT_URL` | Optional; default `/api/auth/me/` |
| `ACCOUNT_LOGOUT_REDIRECT_URL` | Optional; default `/api/auth/me/` |
| `DATABASE_URL` | Tiger / Postgres URL (`sslmode=require` for cloud) in `local/.env` |

Never commit real secrets. Put all private values in `local/.env`.
Placeholders are in [.env.example](../.env.example). Until both Google vars are
set, Django boots and session APIs work; `/accounts/google/login/` cannot
complete live consent.

### Teammate Google Cloud redirect URIs

Register exact URIs (`localhost` ≠ `127.0.0.1`):

| Purpose | Redirect URI |
| --- | --- |
| Direct Django spike | `http://127.0.0.1:8000/accounts/google/login/callback/` |
| Via Angular proxy (later) | `http://127.0.0.1:4200/accounts/google/login/callback/` |

Scopes: `openid`, `email`, `profile` only.

### Drop-in when Google credentials arrive

1. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `local/.env`.
2. Restart `python scripts/dev.py api`.
3. Open `http://127.0.0.1:8000/accounts/google/login/`.
4. Confirm `GET /api/auth/me/` returns the Google-linked user with no map roles until granted.

### Tiger CLI / MCP (local tooling)

Windows install (PowerShell): `irm https://cli.tigerdata.com/install.ps1 | iex`

Then: `tiger auth login`, `tiger db save-password <service-id>`, `tiger mcp install cursor`.
Restart Cursor after MCP install. This does **not** change application runtime; the
app uses `DATABASE_URL` in `local/.env`. `save-password` only works if the
Tiger Cloud project you logged into owns that service (teammate-owned DBs may fail
here without blocking SnapWay).

## Run locally

```sh
# Requires DATABASE_URL in ignored local/.env (Tiger Postgres).
python scripts/dev.py api
```

| Endpoint | Behavior |
| --- | --- |
| `GET /accounts/google/login/` | Start Google OAuth (needs credentials) |
| `GET /accounts/google/login/callback/` | Google redirect target |
| `GET /api/auth/me/` | `{authenticated: false}` or user fields |
| `POST /api/auth/logout/` | End session (CSRF / `X-XSRF-TOKEN`) |

Angular already proxies `/accounts/**` and `/api/**` to `127.0.0.1:8000`
([proxy.conf.json](../apps/web/proxy.conf.json)).

## Tests

```sh
uv run --locked --extra ai --extra geometry --extra mcp pytest apps/api/tests/test_auth.py
```

Tests use in-memory SQLite (`config.settings.test`) and do **not** call live Google
or mutate Tiger Data.

## Changed files

| Path | Role |
| --- | --- |
| [apps/api/config/settings/base.py](../apps/api/config/settings/base.py) | allauth apps, middleware, backends, Google provider |
| [apps/api/config/settings/development.py](../apps/api/config/settings/development.py) | Load `local/.env` only; Postgres preferred |
| [apps/api/config/urls.py](../apps/api/config/urls.py) | `/accounts/`, `/api/auth/` |
| [apps/api/accounts/adapters.py](../apps/api/accounts/adapters.py) | Safe redirects; strip staff on social signup |
| [apps/api/accounts/views.py](../apps/api/accounts/views.py) | `me` / `logout` |
| [apps/api/accounts/serializers.py](../apps/api/accounts/serializers.py) | OpenAPI identity schema |
| [apps/api/accounts/urls.py](../apps/api/accounts/urls.py) | Auth URL routes |
| [apps/api/tests/test_auth.py](../apps/api/tests/test_auth.py) | Session/auth tests |
| [.env.example](../.env.example) | `GOOGLE_OAUTH_*` placeholders |
| [docs/development.md](development.md) | OAuth + DB pointer |
| [apps/api/README.md](../apps/api/README.md) | OAuth status update |
| [.cursor/rules/api-env-only.mdc](../.cursor/rules/api-env-only.mdc) | Agents: use `api.env` only |
| [.cursor/rules/feature-docs.mdc](../.cursor/rules/feature-docs.mdc) | Agents: refresh feature md after each change |
| [docs/backend-oauth.md](backend-oauth.md) | This feature record |

## Action summary

1. Created branch `feature/backend-oauth` from `main`.
2. Enabled allauth + Google provider (settings-based `APP` only when both env vars set).
3. Mounted allauth URLs and session `me`/`logout` API; tests without live Google.
4. After Tiger DB came online: applied account/socialaccount migrations on Tiger
   Postgres; moved all secrets into `local/.env` only (no root `.env`);
   Tiger CLI/MCP installed locally (optional; not required to run the app).
5. Applied `ruff format` to `development.py` and `test_auth.py` so CI
   `ruff format --check` passes (this repo uses Ruff, not Black).

## Commits

- `45b3089` — Enable Google OAuth via allauth with local SQLite session identity.
- `b64aa70` / `8da383f` — feature-record commit links.
- `6874fcf` / `1e7f090` — api.env-only + feature-doc SHA.
- `7686d5f` — Apply ruff format so CI format check passes.
