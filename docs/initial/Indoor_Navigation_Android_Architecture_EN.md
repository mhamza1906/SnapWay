# Indoor Navigation — Android Architecture

**Status:** Proposed, 2026-10-16; documentation only.  
**Owners:** `{{ANDROID_OWNER}}`, `{{FRONTEND_OWNER}}`, `{{PLATFORM_OWNER}}`, `{{QA_LEAD}}`.  
This is the canonical Android design, supplementing the [system architecture](Indoor_Navigation_Architecture_and_Dependencies_EN.md) and [test catalogue](Indoor_Navigation_Test_Catalog_EN.md). API fields remain unfrozen.

## 1. Application boundary

Package the Angular **visitor entry build** with Capacitor 8; administrator/volunteer features stay on the web. Bundle assets in the APK and call Django over HTTPS. Provider secrets and database access stay server-side.

```text
apps/web/                 Shared Angular workspace and Capacitor configuration
apps/web/android/         Generated Android project, Gradle wrapper and native bridge code
local/android/            Personal probes, logs, APK copies and device notes; gitignored
```

Track the native project/wrapper, excluding outputs/secrets. Keep screens in Angular; use Kotlin/Java only for missing capabilities. [Android runtime](https://capacitorjs.com/docs/android), [custom native code](https://capacitorjs.com/docs/android/custom-code).

## 2. Componentized MVC

| Layer | Responsibility |
|---|---|
| Model | Typed publications, routes, observations and journey state; cache/API repositories |
| View | Small map, capture, destination, guidance and recovery components/templates/styles |
| Controller | Facades coordinate permissions, capture, jobs and transitions; views never call plugins directly |
| Platform adapters | Replaceable device/storage/link adapters; browser and Android share contracts |
| Native bridge | Narrow methods/events, capability checks, timestamps and cleanup |

Angular components bind views to controller facades; Django retains backend MVC, authorization and publication authority.

## 3. Capture and plugin selection

| Capability | Candidate and status | Boundary |
|---|---|---|
| Embedded rear-camera preview and manual photograph | **Community:** `@capacitor-community/camera-preview` 8.x | Live-preview candidate; verify on device |
| System camera / gallery picker | **Official:** `@capacitor/camera` | Fallback/picker; not embedded continuous preview |
| Lifecycle, restored result, back/deep link | **Official:** `@capacitor/app` | Application adapter; release listeners |
| Files and small settings | **Official:** Filesystem / Preferences when needed | Owned cached assets/non-secret settings; not secure credential storage |
| Outdoor location and connectivity hints | **Official:** Geolocation / Network | Hints only; no indoor-position/API-reachability guarantee |
| Motion | **Official:** `@capacitor/motion`, optional | Uses Web APIs; not a guarantee of calibrated compass heading |
| Pressure, native fusion or advanced frame analysis | **Custom:** Kotlin/Java plugin only after a capability experiment | Absent hardware cannot block core |

Pin preview v8 and test rotation/screen sharing. Only one adapter owns the camera. [Maintainer documentation](https://github.com/capacitor-community/camera-preview).

Camera 8.1 changes capture/picker methods. Adapt to the pinned API; upload full image URI content, not the native thumbnail. Validate rotation/labels and restored Activity results. [Camera documentation](https://capacitorjs.com/docs/apis/camera).

**N0:** user-triggered capture → upload → accepted/uncertain result → static guidance. Gallery images are labelled historical/imported evidence; they cannot prove the user's current position. **Optional sampling:** foreground only, explicit start/stop, bounded cadence, at most one capture/inference pipeline active, and dropped/replaced pending frames instead of an unbounded queue. If a custom CameraX analyzer becomes necessary, select a backpressure strategy and close image buffers. [CameraX image analysis](https://developer.android.com/media/camera/camerax/analyze).

## 4. Lifecycle and state integrity

Own a state machine: idle → capturing → submitting → waiting → accepted/uncertain/error, with paused/cancelled transitions. Retain the publication revision, destination, capture identity/order, request deadline, and last confirmed location/time as contextual state, without fixing transport field names.

- Exit/background/lock: stop preview, sampling and sensor listeners; invalidate pending UI updates. Backend work may still finish after cancellation.
- Resume: recheck permissions, recover a valid job or recapture. Reject old capture/destination/revision results; movement can invalidate even the newest capture.
- Process restoration: recover minimal journey metadata and reconcile `appRestoredResult` once. Expired image URIs require recapture.
- Offline: show cached owned guidance and last-confirmed age. Browsing never advances position; server recognition requires connectivity.

Lifecycle callbacks support recovery; they do not guarantee background execution. [App lifecycle](https://capacitorjs.com/docs/apis/app).

## 5. Permissions, origins and identity

Request permissions per feature: preview requires camera access; system picker differs. No broad media access, automatic gallery saving or microphone. GPS denial permits manual building selection.

Bundle trusted assets; use HTTPS and exact allowed origins. Disable production live-reload/cleartext exceptions. Configure Django CORS for the actual Capacitor origin, never wildcard credentials. Use CSP and external-link handling to keep untrusted pages outside the privileged WebView. Native HTTP still requires authorization. [Capacitor configuration](https://capacitorjs.com/docs/config), [security guidance](https://capacitorjs.com/docs/guides/security).

Use isolated, rate-limited guest sessions. Developer OAuth stays on the web initially. Native login later needs system-browser/deep-link validation and secure token storage, without embedded Google login or client secrets.

## 6. Outdoor maps and optional sensors

Launch a Maps URL to the reviewed entrance, with browser fallback; this needs no Maps API key. Embedded maps/routing are separate integrations. GPS proximity or return from Maps does not prove entry/floor. [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started).

Calibrate optional sensors against map orientation; measure drift, magnetic interference and pressure hints. Node recognition supplies neither heading nor pose. Motion uses Web APIs, without guaranteed absolute heading or barometer support. [Motion](https://capacitorjs.com/docs/apis/motion).

## 7. Development and APK delivery — no Docker

Use compatible Node/Angular/Capacitor, Android Studio, SDK/JDK and generated Gradle wrapper. [Capacitor 8 migration](https://capacitorjs.com/docs/updating/8-0).

The future pipeline is: locked install → Angular checks and visitor production build → `cap sync android` → Gradle build/checks → signed APK → verify/install on the actual phone → archive artifact identity and results. Sync copies built assets and updates native dependencies; a web build alone does not update the APK. [Development workflow](https://capacitorjs.com/docs/basics/workflow).

Rebuild APKs for bundled visitor/shared code, native/plugins, lockfiles, build/public configuration or Android asset changes. Compatible backend-only deployments and publications need no rebuild. Dependency-aware CI runs host toolchains directly; Docker is excluded.

Keep a stable application ID/signing identity and increasing version code. Store signing secrets in protected CI storage. Record APK checksum, commit/profile and backend compatibility; test installed-app updates. Store distribution/AAB is a separate later decision. [Android signing](https://developer.android.com/studio/publish/app-signing).

## 8. Acceptance and remaining decisions

G1 proves real-device capture, preview, HTTPS API access and permission recovery. G3 covers APP-01–05/07 and JOB-01/02/05, including twenty captures, process restoration, stale responses and background/resume. G5 uses the signed APK and actual screen-sharing setup. Browser fallback has its own APP-06 evidence and does not count as APK acceptance. Optional sensors/sampling/3D/outdoor features require applicable EXT-03–07 checks.

Decisions pending: phone/plugin, image/retention policy, guest transport, signing custody. Personal tests/logs/env/skills go in gitignored `local/`; shared tests stay tracked. No installation, app creation or pipeline execution occurred.
