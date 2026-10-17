# SnapWay frontend

Angular 21.2 workspace with a contributor web entry and separate visitor entry.
Start with the [root setup instructions](../../README.md) and
[development guide](../../docs/development.md). Run bootstrap from the root before
the npm commands below.

Backend configuration follows the [single-env sync guide](../../docs/environment-sync.md).
Do not copy server/provider secrets from `local/.env` into Angular or Capacitor
build configuration; the browser uses backend APIs and receives no private env.

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
workspace route. Both are scaffolds; map editing and navigation follow later.

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

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
