# SnapWay frontend

Angular 21.2 workspace with a contributor web entry and separate visitor entry.
Start with the [root setup instructions](../../README.md) and
[development guide](../../docs/development.md). Run bootstrap from the root before
the npm commands below.

Backend configuration follows the [single-env sync guide](../../docs/environment-sync.md).
Do not copy server/provider secrets from `local/.env` into Angular or Capacitor
build configuration; the browser uses backend APIs and receives no private env.

Google service setup and exact Console callbacks are maintained in the
[frontend iteration guide](../../docs/frontend-iteration.md). The isolated Maps
probe reads only its restricted browser key and map ID from `local/.env`; it never
exports the whole file. Start it from the root with
`python scripts/google_maps_smoke.py`, then open `http://127.0.0.1:4201/`.
Google OAuth uses the existing Django session flow, not a client-side secret.

The web application starts at `/sign-in`. Start Django with `python scripts/dev.py api`
from the repository root, then run the frontend command below. `/sign-in` offers
Developer and Public User cards that start Google login. The verified callback goes
directly to My maps (through the compatible `/overview` redirect) or `/public`
(authenticated visitor journey). `/welcome` remains an authenticated account page
for switching and logout. See [authentication modes](../../docs/authentication-modes.md)
for the API and administrator provisioning. Signed-in Public Users hitting `/map`
or `/navigate` continue at `/public`; Developers use `/explore` and can preview the
visitor UI at `/app-preview`. Anonymous `/map` discovery remains. Discovery reads
publications and real Building coordinates from Django, not local prototype targets.
See the iteration guide for acceptance results and native/production setup still
requiring validation. No Maps/OAuth dependency or secret is bundled into Angular.

## Development server

To start a local development server, run:

```bash
npm start
```

Open `http://127.0.0.1:4200/`. The API must run separately on port 8000;
`proxy.conf.json` forwards `/api/`, `/admin/` and future `/accounts/` routes.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
npx ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
npx ng generate --help
```

## Building

To build the project run:

```bash
npm run build
npm run build:visitor
```

Outputs: `dist/snapway/browser` for the web workspace and
`dist/snapway-visitor/browser` for the visitor. The visitor entry excludes the
workspace routes. The web workspace now uses Django snapshots, review/publication,
AI-floor import and exports; see [Developer workspace](../../docs/developer-workspace.md)
for routes, database migration and acceptance details. The native visitor work is separate.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
npm test
npm run format:check
```

## Android synchronization

For the generated native wrapper, run:

```bash
npm run android:sync
npx cap open android
```

Capacitor bundles the visitor assets. Android Studio, a compatible JDK/SDK and
a physical phone are still needed for build/device acceptance. No APK or
native camera acceptance is claimed. Trivial upstream sample tests were removed;
meaningful native tests accompany device features when implemented.

## iOS synchronization

On macOS with Xcode 26+:

```bash
npm run ios:sync
npx cap open ios
```

The iOS app ships the same visitor build as Android, with the phone layout from
`src/styles.visitor.scss`. Signing and physical-device acceptance are not
claimed; see [iOS visitor app](../../docs/mobile-ios.md).

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
