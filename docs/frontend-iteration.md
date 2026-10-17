# Frontend iteration

Branch: `feature/frontend-iteration`, based on main `04910d6`. The requester
authorized a complete presentation redesign while preserving existing API and
data contracts; Figma is for subsequent detail refinement. The
[architecture baseline](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
and [prototype behavior guide](frontend-prototype.md) remain applicable.
Personal execution history is maintained in ignored `local/ACTIONS.md`.

## Current checkpoint: provider configuration before app integration

- The requested authentication flow is Google sign-in, plus email/password with
  email verification. `django-allauth[socialaccount]` is already declared in
  [pyproject.toml](../pyproject.toml); use the existing Django identity boundary
  rather than adding a hosted auth provider at this checkpoint. Auth provider
  activation, SMTP, account linking and sessions await backend integration.
- Google Maps is intended to become the initial application view, with browser
  location permission, published-building markers and an outdoor-to-indoor handoff.
  The existing [Building model](../apps/api/maps/models.py) already has paired
  latitude/longitude fields. Exact transport endpoints/payloads remain backend work.
- This checkpoint adds configuration templates and a standalone Maps probe only.
  It does **not** change application routes/UI, activate authentication, alter
  dependencies/backend/schema or claim that Google credentials have been tested.
  Angular does not automatically read these `.env` files. Configuration loading,
  map-first application UI and auth pages are the next integration stage after
  the user completes the Console setup and the provider probe passes.

## 1. Create the dedicated Google project

Use a dedicated project for SnapWay. Reusing the previous Map Tiles project was
only a quick-test option; a separate project keeps this team's APIs, credentials,
permissions and usage management independent of the older application.

1. Open [New Project](https://console.cloud.google.com/projectcreate), or open
   [Google Cloud Console](https://console.cloud.google.com/), click the top project
   selector and **New project**. The **IAM & Admin → Manage resources → Create
   project** route is another entry point.
2. Enter **Project name: SnapWay Development**. Use the generated globally unique
   **Project ID**, or edit it before creation. For a personal account choose **No
   organization** if offered; for a team-owned Workspace choose its actual
   organization/folder. Click **Create**, then select the new project at the top.
3. Record its **Project ID**, not just its display name. Open
   [Billing](https://console.cloud.google.com/billing), with the SnapWay project
   selected. If it has no billing account, click **Link a billing account**, choose
   an existing valid account and **Set account**. If only account management is
   shown, open **My projects**, find SnapWay, then **Actions → Change billing →
   choose account → Set account**. Reusing a billing account does not reuse the
   older project's APIs or credentials.
4. Confirm the project selector says **SnapWay Development** before each following
   operation. Google Developer Console and Google Cloud Console use the same
   project ecosystem; a separate developer account is not required.

## 2. Enable only the immediate Maps service

1. Go to **APIs & Services → Library**.
2. Search **Maps JavaScript API**, open the result and click **Enable**.
3. Existing **Map Tiles API** is a different service. Keep its configuration and
   keys intact for any earlier project that still uses them.
4. The browser's `navigator.geolocation` provides location. This test does not
   require Google Geolocation API, Geocoding API, Places API, Routes API or the
   Android Maps SDK. Later in-app outdoor routing/place lookup may need additional
   services, but they are not prerequisites for this test.

## 3. Create a separate browser key

1. Open **APIs & Services → Credentials → Create credentials → API key**.
2. Name it `snapway-web-dev`. Edit the new key immediately.
3. Set **Application restrictions → Websites** and add:

   ```text
   http://localhost:4200/*
   http://127.0.0.1:4200/*
   http://localhost:4201/*
   http://127.0.0.1:4201/*
   ```

   Port 4200 is the Angular app; 4201 is the isolated connection test. These are
   development restrictions; later add the exact HTTPS deployment origin to a
   separate production key. Do not authorize every website.
4. Set **API restrictions → Restrict key → Maps JavaScript API**, then **Save**.
   Give restriction changes time to propagate before retrying a rejected load.
5. Put the key in `local/env/web.env` as described below. Do not paste it into a
   source file or this guide. A browser Maps key is visible in browser requests;
   website/API restrictions are the protection, not treating it as a server secret.

### Sharing with team members

Running the frontend does not require a Console account or an IAM grant. The key
owner can open **APIs & Services → Credentials**, find `snapway-web-dev`, click
**Show key** (or open it and use its copy control), and share the restricted
browser key through the team's password manager/private credential channel.
Each developer puts it in their own ignored `local/env/web.env`. The allowed
localhost origins apply on each member's machine; do not add teammate email
addresses or private LAN IPs to the website-referrer list.

For members who need Console access, open
[IAM](https://console.cloud.google.com/iam-admin/iam), verify the project, click
**Grant access**, enter the member's Google account under **New principals**, then
use **Select a role** and **Save**:

| Task | Role |
| --- | --- |
| View/copy API keys | API Keys Viewer (`roles/serviceusage.apiKeysViewer`) |
| Create/change/delete keys and their restrictions | API Keys Admin (`roles/serviceusage.apiKeysAdmin`) |
| Configure Google OAuth clients/branding | OAuth Config Editor (`roles/oauthconfig.editor`) |

Grant only the roles needed for that member's work. API Keys Viewer can read key
strings, not only metadata, across its granted project scope. Sharing an OAuth
Client ID is different from sharing its Client secret: the secret is reserved for
backend maintainers and their private configuration. Do not distribute OAuth
secrets through frontend files, commits or PR descriptions. OAuth **Test users**
and IAM project members are separate lists with different purposes.

## 4. Choose the Map ID and fill local configuration

For the first probe keep `GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID`, which supports Advanced
Markers for testing. For a project-owned ID, open **Google Maps Platform → Map
management → Create map ID**, choose **JavaScript** and a supported vector/raster
map type, then copy its ID into the same setting. A **Map ID** and an **API key**
are different values.

The shared templates are [.env.web.example](../.env.web.example) and
[.env.google-auth.example](../.env.google-auth.example). Private local copies are
created under ignored `local/env/` without overwriting existing files:

```dotenv
# local/env/web.env
PUBLIC_APP_ORIGIN=http://localhost:4200
GOOGLE_CLOUD_PROJECT_ID=your-existing-project-id
PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY=your-new-browser-key
GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID
PUBLIC_GOOGLE_OAUTH_CLIENT_ID=
```

Keep OAuth values blank until that client is created. The OAuth client secret
belongs only in `local/env/google-auth.env`, never in `web.env` or Angular:

```dotenv
# local/env/google-auth.env; reserved, not activated
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_SCOPES=openid,email,profile
GOOGLE_OAUTH_CALLBACK_URL=
```

These reserved backend values will be wired to the backend's agreed configuration
loader during its integration task; creating this file does not enable allauth.

## 5. Run the isolated Maps test

From the repository root:

```sh
python scripts/google_maps_smoke.py --check
python scripts/google_maps_smoke.py
```

The first command reports only whether a key is configured; it does not validate
the credential with Google or print its value. The second serves
`http://localhost:4201/`. Keep this terminal running while testing.

1. Open that URL, then click **Load Google Map**. Google requests start at this
   point. Inspect real map tiles, pan/zoom and click the test-coordinate marker.
2. Click **Use my location**, then respond to the browser's permission dialog.
   The view should center on the reported location and show its accuracy. Desktop
   location may be network-derived; it is not necessarily a GPS fix.
3. Denied/unavailable/timed-out location must leave manual map use available.
   Browser geolocation needs a secure context; localhost is suitable for local
   development, and deployed use requires HTTPS. A Cookie cannot grant location
   permission. This probe does not persist the location or send it to our backend;
   Google receives map requests when the map is loaded or re-centered.
4. Missing/rejected-key/network states show a status message; Google-specific
   diagnostic codes appear in the browser console. Typical causes include a
   disabled Maps JavaScript API, inactive billing or a referrer not matching the
   exact origin/port. Check those settings rather than removing all restrictions.

The probe consists of [google_maps_smoke.py](../scripts/google_maps_smoke.py) and
[google_maps_smoke.html](../scripts/google_maps_smoke.html). It exposes only the
allowlisted browser key and Map ID, does not serve `.env` files, and does not read
the backend/OAuth secret file. Its marker is an explicitly labeled test coordinate;
the fictional prototype buildings have not been assigned invented real addresses.

## 6. Prepare the Google OAuth client without activating login

1. In the same Cloud project open **Google Auth Platform**. If prompted, **Get
   started**, then set the app name (`SnapWay`), support email and contact email.
2. Under **Audience**, use **External** unless every intended account belongs to
   the project's eligible Workspace organization. Keep a development app in
   **Testing** and add the team's test accounts if the Console provides that field.
3. Under **Data Access**, request only identity scopes: `openid`, `email`,
   `profile`. Login does not require Gmail, Drive, Maps or offline-access scopes.
4. Under **Clients → Create client**, choose **Web application**, named
   `snapway-web-dev`. Set **Authorized JavaScript origins** to `http://localhost`
   and `http://localhost:4200`. These are origins, with no path or trailing slash.
5. Leave **Authorized redirect URIs** unconfigured until the backend member
   confirms the exact callback origin, port and mounted path. The baseline allauth
   path is `/accounts/google/login/callback/`; the frontend login page is not that
   backend callback. Do not invent a working callback on port 4200. This does not
   prevent preparing the client; it deliberately does not yet enable its login flow.
6. Copy the Client ID to the reserved frontend/backend fields. Copy the Client
   secret only to `local/env/google-auth.env`, immediately when it is created:
   Google only displays/downloads the full secret at creation. Do not add secrets
   or Google tokens to Local Storage. No service-account key or OAuth consent
   publishing is needed for the isolated Maps test or auth UI work.

Frontend auth work will cover login, registration, verify-email/resend states,
forgot/reset password, Google pending/error states and return navigation. Until
the backend is ready, these must remain explicit previews: no real authentication
claim, password persistence or fabricated email delivery. Backend integration must
also settle email normalization/uniqueness, verification enforcement, account
linking, session/CSRF behavior and a mail delivery provider; the current abstract
user model is not evidence those policies are complete.

## Subsequent Maps integration

- Make the default app entry a live Google map, keeping navigation usable when
  location permission is denied. Request browser permission through a clear action;
  an already-granted permission can support a later automatic location refresh.
- Plot only current/effective published floor maps, grouped under a building's
  real coordinates. The presence of a building on Google Maps does not associate it
  with our target ID. The backend must supply that linkage/coordinates; an optional
  Places lookup can help establish it later. Indoor `x/y` are not latitude/longitude.
- Offer outdoor directions to a verified building/entrance location, then let the
  visitor explicitly enter the indoor workflow. Opening a Google Maps directions
  URL requires no Maps API key; rendering computed routes within our app is a
  separate Routes integration. Do not silently treat arrival outdoors as an indoor
  localization result, and do not fabricate a geographic entrance from floor-plan
  pixels.

## Billing preference and project-end behavior

The requester prefers **Maps pay-as-you-go**, with no optional monthly Maps
subscription. A Paid Cloud Billing account is not itself a Maps subscription.
Keep the project on usage pricing; do not enroll in Maps Starter/Essentials/Pro
subscription plans as part of the integration.

Some Postpay payment methods require an activation prepayment. This is separate
from Maps pricing and from the time-limited Cloud Free Trial. Maps has recurring
monthly free usage allowances per SKU; exceeding one can create automatic charges.
Consult the live official pricing table rather than treating the activation
payment as a monthly fee or as a hard spending cap.

With Maps usage pricing, no new billable map requests means no new map usage
charges. The end of development does not automatically stop requests from a
public deployment, older builds or background work. Existing costs can settle
after usage stops; unrelated persistent Cloud resources can also accrue costs.
No automatic project-end shutdown is configured at this checkpoint.

Integration should avoid repeated unnecessary map initialization or polling,
restrict browser keys by website and API, and use sensible request quotas plus
budget notifications. Alerts-only budgets do not enforce a hard spending cap.
If a fixed project-end cutoff is required, agree an end date and an explicit
provider-side shutdown automation; a frontend date check alone is not a guarantee
that the key can no longer be used. This note makes no Cloud account changes.

Official billing references checked October 17, 2026:
[Postpay activation prepayments](https://docs.cloud.google.com/billing/docs/how-to/payment-methods),
[Cloud Free Trial](https://docs.cloud.google.com/free/docs/free-cloud-features),
[Maps pay-as-you-go](https://developers.google.com/maps/billing-and-pricing/pay-as-you-go),
[optional Maps subscriptions](https://developers.google.com/maps/billing-and-pricing/subscriptions),
[current SKU prices](https://developers.google.com/maps/billing-and-pricing/pricing),
[payment timing](https://docs.cloud.google.com/billing/docs/how-to/billing-cycle),
[Maps cost controls](https://developers.google.com/maps/billing-and-pricing/manage-costs).

## Verification at this checkpoint

Provider credentials have not been supplied, so authenticated map loading and
device-location acceptance remain pending. This is setup/probe preparation, not
the application integration milestone. Existing backend/API/schema, Angular routes
and dependency manifests are unchanged. Detailed probe checks are recorded in the
contributor's `local/ACTIONS.md`.

Completed local checks: Ruff lint/format passed for the Python probe, HTML was
formatted, the test server responded HTTP 200, and browser verification confirmed
the missing-key message with location actions disabled. Both private env files
are ignored by Git. These checks do not establish Google API connectivity.

Official references checked on October 17, 2026:
[Maps setup](https://developers.google.com/maps/documentation/javascript/get-api-key),
[key restrictions](https://developers.google.com/maps/api-security-best-practices),
[Advanced Markers / Map ID](https://developers.google.com/maps/documentation/javascript/advanced-markers/start),
[browser location](https://developers.google.com/maps/documentation/javascript/geolocation),
[Google identity setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid),
[allauth Google provider](https://docs.allauth.org/en/latest/socialaccount/providers/google.html),
[Maps directions URLs](https://developers.google.com/maps/documentation/urls/guide),
[project access](https://cloud.google.com/iam/docs/granting-changing-revoking-access),
[API key roles](https://docs.cloud.google.com/iam/docs/roles-permissions/apikeys),
[OAuth client configuration and secret visibility](https://support.google.com/cloud/answer/15549257?hl=en).
