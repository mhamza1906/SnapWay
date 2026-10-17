# Main workflow smoke check

**Status:** Preliminary check; awaiting requester manual validation. This is not
the revised audit structure or final gap document. Those follow the manual review.

**Date:** October 17, 2026 (America/Toronto).
**Baseline:** `main` / `origin/main` at
[`71f24ab`](https://github.com/mhamza1906/SnapWay/commit/71f24ab3ae3f909ecb8b5a0b46e78af3ad6ea1f2),
after `git switch main` and `git pull --ff-only origin main`. The prior frontend
iteration branch remains preserved separately.

## Observed implementation

The latest pull added the Google OAuth/session slice (PR #3). The earlier
relational schema and frontend prototype are also present. The checked-out main
contains backend foundations, schema and Google login wiring; it does not yet
provide an integrated authoring/publication/navigation or AI pipeline workflow.
The requester subsequently confirmed that AI authoring is on the separate
`feature/map-authoring-pipeline` branch, not merged into this main SHA. It is now
available in local `acceptance/map-authoring-pipeline`, created from `b2939be`
with main `71f24ab` merged into it in `b83e87c`. See the
[pipeline acceptance setup](map-authoring-pipeline.md#local-acceptance-setup--october-17-2026)
for the environment path and offline checks. Findings below describe the original
main baseline; they must not be read as a claim that AI implementation is absent
from all branches. Live AI acceptance is pending the requester's credentials.

| Area | What is present | Evidence |
| --- | --- | --- |
| Identity | allauth Google routes; session `me`/`logout`; social signup strips staff privileges | [auth views](../apps/api/accounts/views.py), [adapters](../apps/api/accounts/adapters.py), [feature record](backend-oauth.md) |
| Persistence | Building/floor/target, contributions/revisions/evidence/publication, jobs and navigation models/migrations | [schema record](database-schema.md), [maps](../apps/api/maps/models.py), [jobs](../apps/api/jobs/models.py), [navigation](../apps/api/navigation/models.py) |
| Product HTTP workflow | Root routes expose health, auth/allauth and admin; product services/API routes are absent | [root URLs](../apps/api/config/urls.py), [API README](../apps/api/README.md) |
| Frontend | Interactive prototype; business commands persist through the local repository | [prototype repository](../apps/web/src/app/core/prototype.repository.ts), [walkthrough](frontend-prototype.md) |
| AI/MCP | Provider/geometry package boundaries; MCP status resource only | [vision](../packages/vision/README.md), [geometry](../packages/geometry/README.md), [MCP server](../apps/mcp/server.py) |

## Checks completed

| Check | Outcome and limit |
| --- | --- |
| Django system check (`config.settings.test`) | Passed; no issues |
| Migration drift (`makemigrations --check --dry-run`, test settings) | No model changes detected; this does not apply migrations to the development DB |
| Ruff lint / format | Passed; 71 Python files already formatted |
| Backend + MCP pytest, local isolated SQLite | 28 passed, 16 PostgreSQL-only tests skipped; 11.47s |
| Angular tests | 57 passed across 10 files; 3.66s suite duration |
| Latest main CI | [Run 39010924167](https://github.com/mhamza1906/SnapWay/actions/runs/39010924167) passed backend on Windows/Ubuntu and PostgreSQL; web job skipped by change filtering |
| CI isolated PostgreSQL | Migrations applied successfully; 44 tests passed in 6.99s, including PostgreSQL-specific cases |
| Isolated health/session requests | Liveness, readiness and anonymous `/api/auth/me/` returned 200; authenticated session identity works |
| CSRF negative check | Authenticated logout without CSRF returned 403 and preserved the session; the shared auth test also verifies successful logout with a token |
| OAuth local start with dummy credentials | GET confirmation returned 200; CSRF-protected POST returned a Google redirect containing state and PKCE; callback was `http://127.0.0.1:8000/accounts/google/login/callback/` |
| Current development DB, read-only | SQLite connection/SELECT worked; 29 managed model tables missing and 22 migrations pending; no DB writes performed |
| Celery / MCP inventory | No custom Celery tasks registered; MCP reports `stage=scaffold`, `map_tools_enabled=false` |

The OAuth probe did not follow the external redirect, contact Google, create a
real provider account or prove callback/token exchange. Runtime inspection loaded
only `local/env/api.env` through development settings, emitted presence booleans
rather than credential values, and made the database connection read-only. No
shared Tiger DB was selected by this machine's current development configuration.
The CI database is isolated and is not evidence of the shared Tiger instance's
current deployment state.

## Findings for manual confirmation

These are preliminary observations, separated by their practical cause; they are
not a final severity ranking or architecture recommendation.

| ID | Observation | Effect / next manual check |
| --- | --- | --- |
| W01 — local setup | Development resolves to the older local SQLite, not PostgreSQL. All 24 domain tables plus 5 allauth tables are absent; 22 migrations are pending. | Local DB-backed auth/product checks cannot be accepted yet. Confirm the intended development database in `api.env`; have the DB owner confirm migration status before applying anything to a shared instance. |
| W02 — health scope | The current local `/api/health/ready/` still returns 200/`ready` in W01. It checks SQL and `accounts.User`, not allauth/domain schema, queues or AI. | A green health response must not be treated as full workflow readiness. This is the existing limited health contract; record whether a broader readiness gate is needed during the later audit. |
| W03 — incomplete product workflow | No target/contribution/review/publication/navigation HTTP routes or authorized service implementations are wired on this main. Example probes `/api/maps/`, `/api/targets/`, `/api/contributions/`, `/api/jobs/`, `/api/navigation/` returned 404. These examples are not agreed endpoint contracts. | A real create → edit → submit → review → publish → navigate API journey cannot run. Verify the relevant merged work/branch with the backend member before attempting frontend integration. |
| W04 — AI work not present here | Vision and geometry remain placeholders; Celery has no application tasks; MCP has no map mutation tools. | The editor's AI/scene-analysis responses are still frontend simulations. Confirm the expected AI PR/commit and its trigger/worker/provider path. No paid provider call was attempted. |
| W05 — frontend integration | The business workflow still calls `PrototypeRepository`/Local Storage. Its HTTP status client calls liveness only; demo roles are independent of backend sessions/memberships. | Successful prototype save/publication does not prove persistence or authorization in PostgreSQL. Observe browser network traffic during manual testing and distinguish the two acceptance results. |
| W06 — Google setup / missing-config handling | This machine has neither Google OAuth client setting populated. With a fully migrated isolated DB and no credentials, GET `/accounts/google/login/` returned 500 (`DoesNotExist`). Dummy credentials demonstrated the local confirmation/redirect path only. | Live OAuth is unverified. Configure the actual client/callback before live testing; confirm whether the missing-config 500 should become a controlled unavailable state. |
| W07 — requested email flow absent | `SOCIALACCOUNT_ONLY=True`, `ACCOUNT_EMAIL_VERIFICATION='none'`; `/accounts/signup/` is 404. Development email delivery is console-only. | Email/password registration plus verification is outside the merged Google-only slice and is not available for the user's requested flow. Confirm its implementation ownership and acceptance scope later. |

## Requester manual validation sheet

Fill the Result/Evidence columns after checking. Use **Pass**, **Fail**,
**Blocked** or **Not implemented**; do not equate CI success with live integration.
Keep credentials and personal account data out of this shared record.

| Manual step | Expected evidence | Result / evidence |
| --- | --- | --- |
| Confirm this main SHA and the separate AI branch | Matching commit/PR and the relevant implementation files | Main `71f24ab`; AI `b2939be`; combined local acceptance merge `b83e87c`; live AI validation pending |
| Confirm intended DB and deployment/migration state | Backend/DB owner confirmation; the selected development engine and pending migration count | Pending — W01 |
| Start API and check health + anonymous identity | Health JSON and `/api/auth/me/` returning `{authenticated:false}`; account for W02 | Pending |
| Complete real Google login | Correct Console callback, consent, successful callback/session and authenticated `me`; no staff privileges from signup | Blocked locally — W01/W06 |
| Logout, then repeat identity request | A valid CSRF-protected POST followed by anonymous `me` | Pending |
| Try ordinary email registration/verification | Register, verify, login and recovery through actual backend/mail delivery | Not implemented in this slice — W07 |
| Run prototype edit → save → submit → publish → visitor | UI works; explicitly record that this is Local Storage behavior | Pending — W05 |
| Repeat that journey through real APIs | Network requests, server authorization, stored revisions and published snapshot | Not implemented on this main — W03 |
| Execute a real AI authoring/localization job | Trigger endpoint, job state, worker execution, provider result, provenance and explicit apply/review | Not implemented on this main — W04 |

Start commands, after the intended DB/configuration is confirmed:

```sh
python scripts/dev.py api
# separate terminal
python scripts/dev.py web
```

Use `http://127.0.0.1:8000/api/auth/me/` and
`http://127.0.0.1:8000/accounts/google/login/` for direct backend checks. The Google
GET displays a confirmation page; the form POST starts the redirect. Via Angular,
`/api/**` and `/accounts/**` are proxied by [proxy.conf.json](../apps/web/proxy.conf.json);
the chosen callback origin/port must match Google Console exactly.

## Deliberately deferred

- No application code, API contract, dependency or database schema fixes in this pass.
- No migration against local/shared development data, no live provider calls and
  no real Google consent/token exchange.
- No new production/visitor bundle build or native device acceptance in this quick pass.
- No revised audit structure or final gap/prioritization document until the requester
  supplies manual validation results. Reconcile observed results against the initial
  stakeholder/acceptance documents in that subsequent stage.

Private probe implementation and detailed execution history remain under ignored
`local/workflow-check/` and `local/ACTIONS.md`. The source links above plus baseline
SHA identify the actual code checked; this report changes documentation only.
