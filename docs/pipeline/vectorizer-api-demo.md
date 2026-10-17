# Vectorizer.AI integration and prebuilt-map demo

Updated: 2026-10-17. Branch: `acceptance/map-authoring-pipeline`.
This member-approved approach replaces the [personal Figma relay proposal](figma-demo-bridge-proposal.md). No Figma plugin, crawler, subscription or real Vectorizer.AI request was created or executed.

Implementation commit: `f65ac91` (local and not pushed at this checkpoint).
Future map semantics, four-direction reference capture and visitor navigation are defined in the [complete workflow plan](navigation-ai-workflow-plan.md); this page maintains the implemented vectorization and manual-import contracts.

## Decisions and implementation boundary

| Purpose | Floor / source | Status |
|---|---|---|
| Automated vectorization | Official Vectorizer.AI HTTP API | Adapter and separate route implemented; credentials empty, live calls disabled; offline contract tests only |
| Construction-workflow demonstration | **IA floor 4, `ia-4`**, manually exported from Figma | Mock route implemented; real floor-4 assets pending, returning `503 DEMO_ASSET_PENDING` |
| Navigation demo route | IA floor 1, `ia-1`, and subsequently prepared floors | Existing floor-1 SVG imported into local SQLite; rooms, doors, routes and cross-floor connections still require completion and acceptance |

**IA floor 1 is never the mock default or a substitute for missing floor-4 assets.** The small rectangle in tests exists only in isolated test databases and is not an IA-4 deliverable.

Live-route errors never fall back to the mock. The mock makes no model, Vectorizer.AI or Figma requests and does not simulate a new conversion. Display the response's `disclosure` throughout the demonstration; its English meaning is:

> A commercial automated API service is available, but we have not paid for it; this demonstration shows the resulting experience only. The current result is a manually prebuilt Figma vector of IA floor 4, not a live API generation.

The implementation provides callable Node routes and an import utility. **It is not yet wired into the Angular build button, shared PostgreSQL/R2 or navigation publication.** Existing `/api/authoring`, map-job and teammate schema contracts remain compatible. SVG is a presentation asset, not a navigation graph; imported assets have `navigationReady: false`.

## Local configuration

Use the repository's Node 24 profile, including built-in `node:sqlite`; no npm dependency was added. Server settings belong in `apps/pipeline/.env.prod`, following the [example](../../apps/pipeline/.env.prod.example):

```dotenv
VECTORIZER_API_ID=
VECTORIZER_API_SECRET=
VECTORIZER_LIVE_ENABLED=false
```

Keep these values unchanged for this phase. HTTP Basic authentication uses an API ID and secret, not an OpenAI/Gemini key; never put them in Angular or public files. Existing pipeline startup still validates its Vertex configuration; the mock itself needs no model credentials. Before eventual commercial activation, verify account access, billing and the [recorded downstream-use terms](../audits/2026-10-17-figma-vectorization.md). No paid activation is part of this implementation.

## Manual Figma preparation and import

1. Retain the exact optimized PNG/JPEG imported into Figma. Preserve room information in separate semantic records rather than trying to recover it from a label-free image.
2. Import the image into Figma Design, run Vectorize manually and inspect the contours. Export only the floor's vector selection as SVG, excluding the underlying bitmap.
3. Compare scale, orientation, crop, doorways and stairs with the input. The operator confirms floor identity; software cannot prove the floor from an unlabeled SVG.
4. Place files in an ignored directory, such as `local/prebuilt/ia-4/optimized-floor.png` and `local/prebuilt/ia-4/floor.svg`, then run:

```powershell
cd apps/pipeline
npm run import-prebuilt -- --floor ia-4 --label "IA floor 4" --source ../../local/prebuilt/ia-4/optimized-floor.png --svg ../../local/prebuilt/ia-4/floor.svg
```

The command stores the **original SVG bytes as a BLOB, both file hashes, dimensions, import time and manual provenance** in `apps/pipeline/.local/vectorization/assets.sqlite`. This ignored local demo catalog is not the shared database and is not pushed. Identical imports are idempotent; changing an existing floor requires `--replace`. Do not run the placeholder paths before supplying real floor-4 files, or rename floor-1 assets to impersonate floor 4.

Use each navigation floor's own `--floor` identifier. Other contributors can rebuild the existing floor-1 catalog entry from committed evidence:

```powershell
npm run import-prebuilt -- --floor ia-1 --label "IA floor 1" --source ../../docs/audits/assets/2026-10-17-gpt-fullchain/optimized-floor.png --svg ../../docs/audits/assets/2026-10-17-figma-vectorization/figma-vector.svg
```

The actual imported dimensions are 1536 x 1024. SVG SHA-256 is `c7ec1165be27096017ab4f2a5b9aac9aaf5f0f1407845bd28c0aeeed0fc6f53e`, matching the [original export](../audits/assets/2026-10-17-figma-vectorization/figma-vector.svg). This establishes storage integrity, not navigation acceptance.

For eventual shared storage, place SVG bytes in private asset storage and map the relative key, hash, type, dimensions and provenance into the [existing Asset model](../../apps/api/maps/models.py). Real MapTarget associations and authorization are required; no user, Revision or successful shared-database write is fabricated here.

## HTTP contract

Run `npm run prod` from `apps/pipeline`. Direct base URL: `http://127.0.0.1:5175/api/vectorization`; Angular same-origin proxy: `/pipeline/api/vectorization`.

| Method / path | Input | Result / constraints |
|---|---|---|
| `GET /status` | None | Credential-presence booleans, live flag, fixed `mockFloorId: ia-4`, `pending-asset` / `asset-ready`, imported-floor metadata; no credentials |
| `POST /mock` | JSON `{"floorId":"ia-4"}`, optionally `sourceSha256` | Fixed floor-4 SVG; other floors: `422 MOCK_FLOOR_UNSUPPORTED`; missing asset: `503 DEMO_ASSET_PENDING`; source-hash mismatch: `409 SOURCE_MISMATCH` |
| `GET /prebuilt/:floorId` | For example, `ia-1` | Manual prebuilt asset; missing floor: `404 ASSET_NOT_FOUND`; no mock/model call |
| `POST /live` | Multipart PNG/JPEG `image` and `floorId` | Currently `503 VECTORIZER_DISABLED`; official requests require explicit enablement and credentials, without automatic fallback |

The mock requires selecting its fixed floor instead of accepting any image and claiming a conversion. Include the source hash when the source image is available. Successful live/mock responses share:

```text
floorId, svg, sha256, sourceSha256, width, height,
provider, mock, navigationReady, disclosure,
metrics: { elapsedMs, upstreamRequests, creditsCharged, usd }
```

Mock responses use `provider=prebuilt-figma`, `mock=true`, zero upstream calls and zero per-request cost. Their elapsed time measures local retrieval/pre-serialization processing, not Figma conversion. Live responses use `provider=vectorizer.ai`, measured request time and the actual credit header; absent headers are `null`, USD is not guessed, and a timeout does not prove the supplier charged nothing. SVG is returned in JSON; display it as an image rather than inserting untrusted HTML.

Local checks before the real IA-4 import (the final request should return 503):

```powershell
Invoke-RestMethod http://127.0.0.1:5175/api/vectorization/status
Invoke-RestMethod http://127.0.0.1:5175/api/vectorization/prebuilt/ia-1
Invoke-RestMethod http://127.0.0.1:5175/api/vectorization/mock -Method Post -ContentType application/json -Body '{"floorId":"ia-4"}'
```

## Implementation, verification and remaining acceptance

- [Asset validation/SQLite storage](../../apps/pipeline/server/vectorization/assets.js), [manual import command](../../apps/pipeline/server/vectorization/import-prebuilt.js), [npm entrypoint](../../apps/pipeline/package.json).
- [Official adapter](../../apps/pipeline/server/vectorization/provider.js), [routes](../../apps/pipeline/server/vectorization/routes.js), [server mount](../../apps/pipeline/server/index.js).
- [Nine offline tests](../../apps/pipeline/tests/vectorization.test.js) cover reopening SQLite, idempotency/replacement, floor isolation, pending assets, provenance/cost disclosure, hash conflicts, disabled/missing-key gates, Basic/multipart requests, upstream errors/timeouts/limits, active-SVG rejection and HTTP success. Injected fetch never contacts the supplier.
- `npm test`: 169 tests, 151 passed, 18 skipped for the existing optional Waterloo fixture, zero failures; about 4.8 seconds. No paid CI test was added.
- Actual local SQLite/HTTP smoke: floor-1 SVG returned 440,127 matching bytes; floor-4 mock returned expected 503; zero external calls. Replay/evidence remain in ignored `local/test-results/vectorizer-api-demo/smoke.mjs` and `smoke.json`, not as shared dependencies.
- Supply the actual IA-4 source and SVG, import and visually review them, then wire the mock response/disclosure into Angular. Navigation rooms, doors and cross-floor graphs require separate acceptance; interface readiness does not imply floor or route completion.

Protocol reference: [Vectorizer.AI documentation](https://vectorizer.ai/api/documentation). The adapter implements `https://api.vectorizer.ai/api/v1/vectorize`, HTTP Basic, multipart `image`, SVG output and zero-day retention, with a 120-second deadline and no automatic paid retry. Supplier end-to-end behavior has not been tested. [Node SQLite documentation](https://nodejs.org/api/sqlite.html) describes the built-in catalog interface.
