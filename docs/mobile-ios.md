# iOS visitor app (Capacitor)

Shared feature record for running the visitor navigation app on iPhone. Work lives
on branch `feature/mobile-ios`, cut from `main` at `71f24ab`. Personal execution
history is in ignored `local/ACTIONS.md`.

## Approved scope

The [architecture plan](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
lists native iOS as outside the present scope. Arjun requested this branch on
2026-10-17 as an exploratory iOS target; team agreement is still needed before it
is merged into `main`.

- Same Angular visitor entry (`src/main.visitor.ts`) and UI that Android ships; no
  separate mobile app, framework or data format.
- One new dependency: `@capacitor/ios` **8.4.3**, pinned to match
  `@capacitor/core`, `@capacitor/android` and `@capacitor/cli`. `npm audit
  --omit=dev` reports 0 vulnerabilities.
- Bundle identifier `org.snapway.app`, the same as Android.
- Phone layout changes apply only to the `visitor` build configuration, so the
  contributor workspace build is unchanged.

## Non-goals

- Real camera, GPS or recognition (the visitor preview still simulates hardware)
- Code signing, TestFlight or App Store distribution
- CI for iOS (macOS runners); CI still runs `npx cap sync android` only
- Map pan/zoom inside the shared `map-canvas` component

## How to run

From `apps/web` with Node 24.15+ and npm 11:

```sh
npm ci
npm run ios:sync      # build:visitor + cap sync ios
npx cap open ios      # opens ios/App/App.xcodeproj
```

In Xcode, choose an iPhone simulator and press Run. For a physical iPhone, select
the **App** target → Signing & Capabilities → your Team, choose the device and
press Run, then trust the developer certificate on the phone under Settings →
General → VPN & Device Management. Requires Xcode 26+ (tested with Xcode 27.1,
iOS 26.5 simulators). The project uses Swift Package Manager, not CocoaPods.

## Phone layout (visitor build)

`angular.json` → `visitor` now uses `src/index.visitor.html` (emitted as
`index.html`) and adds `src/styles.visitor.scss`. Below 760 px the visitor shell:

- covers the full screen (`viewport-fit=cover`) and pads for the notch, Dynamic
  Island and home indicator, with a solid strip behind the status bar
- uses a compact header and a two-column building/floor bar
- renders the floor plan at a minimum of 600 px wide in a horizontally scrolling
  frame, so room labels stay legible (the shared canvas has no zoom)
- sets inputs to 16 px (otherwise iOS zooms the page on focus) and buttons and rows
  to ≥ 44 px touch targets
- opens photo localization as a bottom sheet

Rules are scoped under `#visitor` (the visitor `<body>`) so they outrank Angular's
emulated component selectors. Android uses the same visitor build and gets the
same layout on its next `npm run android:sync`.

## iOS project

`apps/web/ios/` is the generated Capacitor 8.4.3 project. Additions:

- `Info.plist`: `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription`,
  required because the capture panel's file input offers the camera and library.
- `capacitor.config.ts`: `ios.backgroundColor` = `--canvas` to avoid a white flash.

The visitor app makes no network requests (prototype data is in Local Storage), so
no App Transport Security exception is added.

## Relation to `feature/map-authoring-pipeline`

That branch adds the Node pipeline (`apps/pipeline/`), the contributor
`/authoring` screen and a `/pipeline/**` dev proxy. None of it is in the visitor
entry, so it doesn't affect this iOS build. When published maps are served to
visitors, the pipeline's `shared/building/navigation-bundle.js` is a candidate
payload for the visitor app; that integration is separate work.

## Verification

- `npm test`: 57/57 pass. `npm run format:check`: clean. `npm run build` (web) and
  `npm run build:visitor`: succeed with no budget warnings.
- Browser at 390×844: destination, start, heading confirmation, guidance and the
  photo-localization sheet work; computed sizes confirm 16 px inputs and 44 px
  buttons.
- iOS Simulator (iPhone 17e and iPhone SE 3rd gen, iOS 26.5): app launches with
  safe areas respected; search with the on-screen keyboard filters without page
  zoom; native select picker; route planned (Main entrance → Workshop 106).
- Not verified: physical iPhone, signing, Android device build after the layout
  change. While the keyboard is open, iOS can shift the fixed status-bar strip.

## Changed files

- [apps/web/package.json](../apps/web/package.json), [package-lock.json](../apps/web/package-lock.json): `@capacitor/ios` 8.4.3, `ios:sync` script
- [apps/web/angular.json](../apps/web/angular.json): visitor `index` and `styles`
- [apps/web/capacitor.config.ts](../apps/web/capacitor.config.ts): iOS background colour
- [apps/web/src/index.visitor.html](../apps/web/src/index.visitor.html), [apps/web/src/styles.visitor.scss](../apps/web/src/styles.visitor.scss): phone shell
- [apps/web/ios/](../apps/web/ios/): generated Xcode project and `Info.plist` permission text
- [README.md](../README.md), [apps/web/README.md](../apps/web/README.md), [docs/development.md](development.md): iOS commands

## Commits

- Pending: recorded after the first commit on `feature/mobile-ios`.
