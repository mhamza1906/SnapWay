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
and `is_superuser=False` via `accounts.adapters.SocialAccountAdapter`.

Local development for this feature uses **ignored SQLite** at `local/dev.sqlite3`.
Leave `DATABASE_URL` unset in `local/env/api.env` so auth work does not touch a
teammate’s PostgreSQL. Allauth migrations are additive and apply later on Postgres
when that environment is ready.

## Non-goals

- Angular Sign in with Google UI / replacing the prototype role dropdown
- Android / native Google Sign-In
- Auto-assigning `maps.Membership` or staff from email domain
- JWT or non-session API tokens
- Pointing development at shared PostgreSQL for this spike

## Environment contract

| Variable | Meaning |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud Web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud Web client secret (private) |
| `LOGIN_REDIRECT_URL` | Optional; default `/api/auth/me/` |
| `ACCOUNT_LOGOUT_REDIRECT_URL` | Optional; default `/api/auth/me/` |
| `DATABASE_URL` | Omit for SQLite; set only for explicit Postgres work |

Placeholders are in [.env.example](../.env.example). Paste real Google values only
into ignored `local/env/api.env`. Until both Google vars are set, Django boots and
session APIs work; `/accounts/google/login/` cannot complete a live consent round-trip.

### Teammate Google Cloud redirect URIs

Register exact URIs (`localhost` ≠ `127.0.0.1`):

| Purpose | Redirect URI |
| --- | --- |
| Direct Django spike | `http://127.0.0.1:8000/accounts/google/login/callback/` |
| Via Angular proxy (later) | `http://127.0.0.1:4200/accounts/google/login/callback/` |

Scopes: `openid`, `email`, `profile` only.

### Drop-in when credentials arrive

1. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `local/env/api.env`.
2. Restart `python scripts/dev.py api`.
3. Open `http://127.0.0.1:8000/accounts/google/login/`.
4. Confirm `GET /api/auth/me/` returns the Google-linked user with no map roles until granted.

## Run locally

```sh
# Ensure DATABASE_URL is unset in local/env/api.env (SQLite).
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

Tests cover anonymous/authenticated `me`, CSRF logout, mounted Google login URL,
empty-credential provider settings, and staff-stripping adapter behavior. They do
**not** call live Google.

## Changed files

| Path | Role |
| --- | --- |
| [apps/api/config/settings/base.py](../apps/api/config/settings/base.py) | allauth apps, middleware, backends, Google provider |
| [apps/api/config/settings/development.py](../apps/api/config/settings/development.py) | Blank `DATABASE_URL` → SQLite |
| [apps/api/config/urls.py](../apps/api/config/urls.py) | `/accounts/`, `/api/auth/` |
| [apps/api/accounts/adapters.py](../apps/api/accounts/adapters.py) | Safe redirects; strip staff on social signup |
| [apps/api/accounts/views.py](../apps/api/accounts/views.py) | `me` / `logout` |
| [apps/api/accounts/serializers.py](../apps/api/accounts/serializers.py) | OpenAPI identity schema |
| [apps/api/accounts/urls.py](../apps/api/accounts/urls.py) | Auth URL routes |
| [apps/api/tests/test_auth.py](../apps/api/tests/test_auth.py) | Session/auth tests |
| [.env.example](../.env.example) | `GOOGLE_OAUTH_*` placeholders; SQLite guidance |
| [docs/development.md](development.md) | OAuth enabled pointer |
| [apps/api/README.md](../apps/api/README.md) | OAuth status update |
| [docs/backend-oauth.md](backend-oauth.md) | This feature record |

## Action summary

1. Created branch `feature/backend-oauth` from `main`.
2. Enabled allauth + Google provider (settings-based `APP` only when both env vars set).
3. Mounted allauth URLs and session `me`/`logout` API.
4. Forced blank/`DATABASE_URL` handling to local SQLite; applied account/socialaccount migrations on `local/dev.sqlite3`.
5. Added tests without live Google; documented hand-off for teammate credentials.

## Commits

- `45b3089` — Enable Google OAuth via allauth with local SQLite session identity.
