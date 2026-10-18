# Google sign-in and session experience modes

Updated October 18, 2026. Active on `feature/frontend-iteration` /
`feature/merged-integration`.
This implements the contributor-approved authentication change on top of the
[architecture baseline](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md).
The requesting contributor confirmed production Google configuration was repaired;
public configuration now independently reports both Google login and Maps enabled.

## User flow and presentation

The web application's `/` opens `/sign-in`, a full-screen entry with a SnapWay
header and a responsive small title.
Two large stacked cards fill the remaining viewport: pale red **Developer** above
pale green **Public User**. They slide in together from opposite sides over
**2.4 seconds**, three times the initial entrance duration. The first SVG places
waypoint nodes before drawing edges. The second is an original animated SVG camera
scene with perspective architecture, glass shading, a naturally proportioned person,
scanning and a matched entrance. It is decorative and requests no camera permission.
Both animations respect reduced-motion preferences. Small screens retain the same
order; short viewports may scroll so content remains accessible.

The refined header uses an original vector wordmark inspired by the supplied logo:
rounded navy lettering, a blue road-shaped w, a six-blade aperture inside the first
a, and an upward arrow on y. Its 247-pixel width makes those details legible.
After a one-second bounce, only y begins changing into the travelling arrow;
the remaining letters open sequentially from right to left (a, w, p, a, n, s).
Native SVG morphs start only after Angular binds their frames, preventing a premature
arrow flash. Main letter, thread and arrow strokes remain eight CSS pixels without
scale compression. Interior aperture and lane markings use finer decorative strokes.
The moving brand fully leaves by 6.2 seconds and does not restore itself.
The y stem and its initial arrow share the same blue from the outset. Other
letters switch to that exact blue as their morph starts; the travelling thread
stays fully opaque during unfolding. One composited parent fades the whole mark
and thread together, preventing darker overlap seams and late joint remnants.
Decorative aperture, lane markings and initial arrow cap hide when their glyph
starts opening. Camera status badges use bounded text lengths, centered baselines,
and centered icon/text groups so all labels remain inside their backgrounds.

The subtitle stays on one line on the same horizontal axis as the arrow on desktop
and narrow layouts; its font size adapts instead of moving to a second header row.
On narrow screens its reveal starts later to avoid the remaining letters.
Reduced motion shows a static brand and subtitle without the bounce, flight or morph.
Larger italic card headings accompany an illustrative architectural floor plan with
room labels, door swings, furniture and stairs; waypoint nodes precede connections
through door openings. This artwork is decorative, not an accepted IA floor map.
Narrow cards stack text above artwork to prevent overlap.

Clicking either card submits a same-origin, CSRF-protected native form directly
into the existing Google OAuth / PKCE flow. The selected mode is stored in the
server-side OAuth state, never trusted from the callback URL or local storage.
Only a successful provider authentication applies that mode to the new session.
The verified selection survives allauth replacing an existing signed-in session.
Browser back/forward cache restoration re-enables the cards for another attempt.

The callback stays `/accounts/google/login/callback/`; no Google Console change
is needed. `/auth/complete` verifies the server session and directly replaces the
callback history entry with `/overview` for Developer or `/public` for Public User.
There is no intermediate welcome/Continue step. Query parameters cannot override
the destination. The existing workspace layout and features are retained; its
profile and header display **Developer**, including for manually privileged accounts.
The sidebar can scroll on short viewports so its existing logout control stays
reachable; no workspace layout redesign is included.

`/public` is the authenticated Public User journey: the destination-first visitor
UI ([VisitorJourney](../apps/web/src/app/features/visitor/visitor.ts)) with building/room
search, outdoor walking map, indoor camera localize, account switch to Developer,
and logout. A Public User opening `/map` or `/navigate` is redirected here.
Developers preview the same journey at `/app-preview` (with a back-to-workspace
link) without leaving Developer mode. Anonymous `/map` discovery remains available.
Anonymous protected URLs lead to `/sign-in`. The separate native visitor entry
retains its existing map/navigation routes.

The retained `/welcome` two-column account page is still available from existing
account links; Continue and successful mode switches go directly to the selected
experience. Workspace-to-Public and Public-to-Developer switches use the
existing server mode endpoint without another Google login. Failed switches stay
on the current page with an error. Signing out returns to `/sign-in`.

Integration: `/public` keeps `publicGuard` and `AuthService.landingPath`;
`publicDiscoveryGuard` sends signed-in Public Users from `/map` to `/public`.
No callback, API, schema, environment or Google Console change is required for
this route swap. Guidance frame adapters and guest navigation sessions remain
follow-ups in [mobile-visitor-ui.md](mobile-visitor-ui.md).

## Mode is not administrator authority

| Session | Visible experience | Server authority |
| --- | --- | --- |
| Anonymous | Web sign-in cards; existing native visitor map | Existing public APIs only |
| Public User | Authenticated `/public` visitor journey and retained account page | No draft, graph, underlay, photo or target-access API access, even for an account with admin membership |
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

Current routing acceptance: 79 frontend tests across 17 files passed. Backend
behavior is unchanged in this update; the preceding authentication implementation
passed 134 backend/MCP/deployment tests with 16 PostgreSQL-only checks skipped in
the local SQLite profile. The
eight new mode tests also passed after fixing the existing-session OAuth edge case.
Tests cover anonymous/CSRF rejection, invalid Admin/extra-field requests, same-account
switching, public-mode private-map read/write denial, preserved database privileges,
non-admin draft creation, PKCE state binding, fixed landing and existing-session
replacement. Frontend checks cover both cards, native form fields, route guards,
mode switching and back/forward restoration. Production Web and Visitor builds,
Android asset sync, format/lint and environment-contract checks passed.

Live localhost browser acceptance completed both Google card flows directly to
their selected experience, Developer-to-Public-to-Developer switching, logout back
to sign-in, and anonymous `/public` rejection. Public sessions opening `/map` or
`/navigate` now reach the visitor journey at `/public` (replacing the earlier
placeholder). Developer profile and header both show only Developer; the sidebar
logout works with short viewports.
The earlier card-layout desktop
layout was measured at a 1707 × 876 viewport: both cards are 374 px high, entrance
durations are 2.4 seconds, and there is no horizontal or vertical page overflow.
Responsive CSS is implemented; a physical mobile-device OAuth/camera test is not
part of this acceptance. Screenshots remain under ignored
`local/test-results/experience-auth/`; execution history is `local/ACTIONS.md`.
The presentation refinement also passed 320px and 390px iframe viewport reviews,
desktop inspection of the y-first morph and complete exit, and a computed-style
check showing eight-pixel strokes for all main glyphs and the travelling thread.
Web and Visitor production builds pass without style-budget warnings.

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
  [header motion and responsive title](../apps/web/src/app/features/sign-in/sign-in-header.scss),
  [illustrative floor-plan SVG](../apps/web/public/assets/developer-floor-plan.svg),
  [camera SVG](../apps/web/public/assets/navigation-camera.svg),
  [session service/guards](../apps/web/src/app/core/auth.service.ts),
  [routes](../apps/web/src/app/app.routes.ts),
  [welcome](../apps/web/src/app/features/welcome/welcome.ts),
  [Public User visitor journey](../apps/web/src/app/features/visitor/visitor.ts),
  [callback](../apps/web/src/app/features/welcome/auth-complete.ts).
- Integration: [shell](../apps/web/src/app/app.ts), [shell template](../apps/web/src/app/app.html),
  [sidebar scroll styles](../apps/web/src/app/app.scss),
  [map account navigation](../apps/web/src/app/features/map/map.html),
  [icons](../apps/web/src/app/shared/icon.ts),
  [provider-error recovery](../apps/api/accounts/templates/socialaccount/authentication_error.html),
  [cancellation recovery](../apps/api/accounts/templates/socialaccount/login_cancelled.html).
- Regression coverage: [mode tests](../apps/api/tests/test_experience_modes.py),
  [entry tests](../apps/web/src/app/features/sign-in/sign-in.spec.ts),
  [direct callback landing tests](../apps/web/src/app/features/welcome/auth-complete.spec.ts),
  [session tests](../apps/web/src/app/core/auth.service.spec.ts),
  [shell tests](../apps/web/src/app/app.spec.ts), [map tests](../apps/web/src/app/features/map/map.spec.ts),
  [visitor journey tests](../apps/web/src/app/features/visitor/visitor.spec.ts).
  Existing backend graph, media and membership fixtures now select Developer mode
  explicitly; provider recovery assertions point to `/sign-in`.
- Setup references: [web README](../apps/web/README.md),
  [backend OAuth record](backend-oauth.md), [frontend integration record](frontend-iteration.md),
  [mobile visitor UI](mobile-visitor-ui.md).

Adapter contracts were checked against the installed pinned package and official
[account adapter](https://docs.allauth.org/en/latest/account/adapter.html) and
[social adapter](https://docs.allauth.org/en/latest/socialaccount/adapter.html) documentation.
