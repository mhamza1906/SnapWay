# Google sign-in and session experience modes

Updated October 17, 2026. Active branch: `feature/frontend-iteration`.
This implements the contributor-approved authentication change on top of the
[architecture baseline](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md).
The requesting contributor confirmed production Google configuration was repaired;
public configuration now independently reports both Google login and Maps enabled.

## User flow and presentation

The public map remains the application's default view. Its sign-in link opens
`/sign-in`, a full-screen entry with a SnapWay header and a responsive small title.
Two large stacked cards fill the remaining viewport: pale red **Developer** above
pale green **Public User**. They slide in together from opposite sides over
**2.4 seconds**, three times the initial entrance duration. The first SVG places
waypoint nodes before drawing edges. The second is an original animated SVG camera
scene with perspective architecture, glass shading, a naturally proportioned person,
scanning and a matched entrance. It is decorative and requests no camera permission.
Both animations respect reduced-motion preferences. Small screens retain the same
order; short viewports may scroll so content remains accessible.

Clicking either card submits a same-origin, CSRF-protected native form directly
into the existing Google OAuth / PKCE flow. The selected mode is stored in the
server-side OAuth state, never trusted from the callback URL or local storage.
Only a successful provider authentication applies that mode to the new session.
The verified selection survives allauth replacing an existing signed-in session.
Browser back/forward cache restoration re-enables the cards for another attempt.

The callback stays `/accounts/google/login/callback/`; no Google Console change
is needed. `/auth/complete` verifies the new session and opens `/welcome`. The
former login page retains its existing two-column visual layout as an authenticated
welcome/account page. Continue enters `/overview` for Developer or `/map` for
Public User. Switching there uses the same account and needs no second Google
login. Workspace and signed-in map entry points also expose the experience switch.
Signing out returns to `/sign-in`; anonymous access to `/welcome` is guarded.

## Mode is not administrator authority

| Session | Visible experience | Server authority |
| --- | --- | --- |
| Anonymous | Public discovery and sign-in cards | Existing public APIs only |
| Public User | Welcome, public map and navigation preview | No draft, graph, underlay, photo or target-access API access, even for an account with admin membership |
| Developer | Existing workspace and graph editing | Existing target-specific membership checks still apply; creating a draft grants only volunteer membership |
| Developer with manually provisioned privileges | Existing administrator-capable entry points | Database staff flags and/or active target admin memberships; never card selection |

Modes are session-scoped, shared by tabs using that browser session. Changing mode
does not create another account, duplicate maps, change memberships, or write staff
flags. Legacy sessions without a selected mode default to Public User. Protected
Angular routes refresh server identity before entering. Review routes additionally
require the server-derived administrator capability. The existing workspace layout
is retained: separate Admin/Developer workspace designs are deferred as requested,
and there is no selectable Admin sign-in mode or workspace role dropdown.

New Google accounts are explicitly non-staff and non-superuser. Draft creation no
longer makes its creator a map admin, including the existing staff bootstrap path.
Admin membership grants now require an already database-provisioned staff/superuser
operator; ordinary map admins can still manage volunteer membership. There is no
HTTP administrator registration or promotion endpoint. Controlled server-side
database operations, including the existing `grant_map_membership` management
command executed by an operator, are the provisioning channel.

Existing accounts/memberships are preserved. Older demo versions automatically
created admin membership for draft owners; those existing rows have no reliable
provenance flag. Operators must review such memberships before treating the shared
database as a fresh installation with only manually provisioned admins. This
change does not silently revoke existing privileges or infer an administrator
from an email domain. No schema migration is required.

## HTTP contract and boundaries

| Endpoint | Contract |
| --- | --- |
| `POST /api/auth/google/start/` | Form fields `mode=developer` or `mode=public` plus CSRF token; invalid mode returns 400, missing CSRF returns 403, GET returns 405. Uses the existing Google provider, forces `next=/auth/complete`, retains callback and PKCE. |
| `POST /api/auth/mode/` | Authenticated, CSRF-protected JSON `{"mode":"developer"}` or `{"mode":"public"}`; unknown fields and Admin selection return 400. Returns current session identity. |
| `GET /api/auth/me/` | Existing identity fields plus `mode`, `available_modes`, `can_admin` for signed-in callers. Anonymous response remains `{"authenticated":false}`. Public mode returns empty memberships, false effective staff flags and false admin capability; underlying database flags remain unchanged. |
| Existing developer map endpoints | Require Developer session mode before target membership checks. Public metadata and localization retain their existing public/capability/session policies. |

All mode/session responses are uncached. Existing graph payloads are unchanged.
Admin capability is a UI summary; it never replaces per-target backend checks.
The old direct allauth login endpoint remains available for diagnostics and safely
defaults to Public User if no selection was supplied.

This iteration covers the Angular web application and Django session API. The
existing native visitor bundle remains a public discovery/navigation build; native
Google OAuth browser/deep-link handoff is not introduced here. The separate Node
authoring worker's private deployment boundary is unchanged. Older workspace
sample data and its internal demo-role fixtures remain local prototype behavior,
not authorization evidence; a complete workspace data/UI redesign is deferred.

## Configuration and verification

No dependency, env key, env schema version or Google scope changed. Continue using
the [single-env contract](environment-sync.md): local `local/.env`, production
`/etc/indoor-nav/api.env`, and root `.env.example`. No private value needs sharing
for this feature. Deploy the web and Django updates together; legacy browser
sessions may need to select a mode after deployment.

Acceptance: 74 frontend tests across 16 files; 134 backend/MCP/deployment tests
passed with 16 PostgreSQL-only checks skipped in the local SQLite profile. The
eight new mode tests also passed after fixing the existing-session OAuth edge case.
Tests cover anonymous/CSRF rejection, invalid Admin/extra-field requests, same-account
switching, public-mode private-map read/write denial, preserved database privileges,
non-admin draft creation, PKCE state binding, fixed landing and existing-session
replacement. Frontend checks cover both cards, native form fields, route guards,
mode switching and back/forward restoration. Production Web and Visitor builds,
Android asset sync, format/lint and environment-contract checks passed.

Live localhost browser acceptance completed both Google card flows to the retained
welcome page, Developer-to-Public-to-Developer switching, public-session graph-editor
route rejection, Developer entry into the existing overview, logout back to the
new entry, and anonymous rejection from `/welcome`. The final desktop
layout was measured at a 1707 × 876 viewport: both cards are 374 px high, entrance
durations are 2.4 seconds, and there is no horizontal or vertical page overflow.
Responsive CSS is implemented; a physical mobile-device OAuth/camera test is not
part of this acceptance. Screenshots remain under ignored
`local/test-results/experience-auth/`; execution history is `local/ACTIONS.md`.

## Implementation references

- Backend: [mode permission](../apps/api/accounts/modes.py),
  [session/start/switch views](../apps/api/accounts/views.py),
  [serializers](../apps/api/accounts/serializers.py), [URLs](../apps/api/accounts/urls.py),
  [allauth adapters](../apps/api/accounts/adapters.py).
- Authority: [map permissions](../apps/api/maps/permissions.py),
  [draft endpoint](../apps/api/maps/views_graph.py), [draft creation](../apps/api/maps/services/draft.py),
  [membership grants](../apps/api/maps/services/membership.py),
  [operator command](../apps/api/maps/management/commands/grant_map_membership.py).
- Frontend: [entry component](../apps/web/src/app/features/sign-in/sign-in.ts),
  [card template](../apps/web/src/app/features/sign-in/sign-in.html),
  [layout](../apps/web/src/app/features/sign-in/sign-in.scss),
  [motion](../apps/web/src/app/features/sign-in/sign-in-motion.scss),
  [camera SVG](../apps/web/public/assets/navigation-camera.svg),
  [session service/guards](../apps/web/src/app/core/auth.service.ts),
  [routes](../apps/web/src/app/app.routes.ts),
  [welcome](../apps/web/src/app/features/welcome/welcome.ts),
  [callback](../apps/web/src/app/features/welcome/auth-complete.ts).
- Integration: [shell](../apps/web/src/app/app.ts), [shell template](../apps/web/src/app/app.html),
  [map account navigation](../apps/web/src/app/features/map/map.html),
  [icons](../apps/web/src/app/shared/icon.ts),
  [provider-error recovery](../apps/api/accounts/templates/socialaccount/authentication_error.html),
  [cancellation recovery](../apps/api/accounts/templates/socialaccount/login_cancelled.html).
- Regression coverage: [mode tests](../apps/api/tests/test_experience_modes.py),
  [entry tests](../apps/web/src/app/features/sign-in/sign-in.spec.ts),
  [session tests](../apps/web/src/app/core/auth.service.spec.ts),
  [shell tests](../apps/web/src/app/app.spec.ts), [map tests](../apps/web/src/app/features/map/map.spec.ts).
  Existing backend graph, media and membership fixtures now select Developer mode
  explicitly; provider recovery assertions point to `/sign-in`.
- Setup references: [web README](../apps/web/README.md),
  [backend OAuth record](backend-oauth.md), [frontend integration record](frontend-iteration.md).

Adapter contracts were checked against the installed pinned package and official
[account adapter](https://docs.allauth.org/en/latest/account/adapter.html) and
[social adapter](https://docs.allauth.org/en/latest/socialaccount/adapter.html) documentation.
