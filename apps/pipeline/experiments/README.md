# Opt-in floor-plan vectorization experiment

This directory is an isolated live/replay harness for the [Gemini-only pilot](../../../docs/audits/2026-10-17-gemini-vector-pilot.md). It does not alter server routes, app provider defaults, dependencies, database/storage, authoring jobs or publication. The member explicitly deferred OpenAI image/Opus testing; this harness calls only `gemini-4-argon` through the existing Vertex adapter.

Run from the repository root with existing pipeline dependencies and `.venv` (Python `jsonschema` already installed in the tested environment):

```powershell
node --test apps/pipeline/experiments/floorplan-pilot.test.mjs
```

The six tests cover nonsquare coordinate conversion, invalid frames/geometry/references, native-schema projection, SVG marker ownership and regression replays of both real detail responses. They live outside the normal `tests/*.test.js` CI glob; they do not add live calls or new dependencies to CI.

## Offline replay of the recorded global result

Use a fresh directory; exact input encoding is retained so hashed frames match the recorded responses. `--prepare` copies that frozen input when available and optionally prepares original-photo context if the private original exists. It makes no network request.

```powershell
node apps/pipeline/experiments/floorplan-pilot.mjs --prepare --out=local/test-results/pipeline-v2-replay
Copy-Item -LiteralPath docs/audits/assets/2026-10-17-gemini-vector-pilot/trace.json -Destination local/test-results/pipeline-v2-replay/trace.json
Copy-Item -LiteralPath docs/audits/assets/2026-10-17-gemini-vector-pilot/structure.json -Destination local/test-results/pipeline-v2-replay/structure.json
node apps/pipeline/experiments/floorplan-pilot.mjs --stage=trace --out=local/test-results/pipeline-v2-replay
node apps/pipeline/experiments/floorplan-pilot.mjs --stage=structure --out=local/test-results/pipeline-v2-replay
```

This writes a draft, validation JSON, SVG, PNG and an interactive `index.html`. Serve that directory through a loopback HTTP server, rather than opening the HTML through `file:`, so its local validation JSON can load. The page supports independent marker labels, keyboard Enter/Space, show/hide, pan and zoom/reset; it is an experiment viewer, not a replacement Angular page or a navigation acceptance result.

`analyze-floorplan-pilot.mjs` additionally analyzes the two recorded detail crops when their evidence folders, `attempt-ledger.json` and global `validation.json` are present in the output directory. It reports invalid geometry instead of applying patches. The recorded summary already includes this analysis; raw responses remain private.

## Explicit live experiment

Live calls require the teammate-authorized ignored `apps/pipeline/.env.prod` with `VERTEX_API_KEY` and `VERTEX_PROJECT`. Never copy credentials into this directory, shared docs or frontend code. Access is checked before calling; health configuration alone is not an inference test.

```powershell
node apps/pipeline/experiments/floorplan-pilot.mjs --prepare --out=local/test-results/pipeline-v2-new
node apps/pipeline/experiments/floorplan-pilot.mjs --live --stage=trace --out=local/test-results/pipeline-v2-new
node apps/pipeline/experiments/floorplan-pilot.mjs --live --stage=structure --out=local/test-results/pipeline-v2-new
```

These explicit `--live` commands incur provider usage. Existing stage output prevents accidental paid reruns. The harness makes no automatic retry, caps six attempts per ledger and 16,384 output tokens per request, and explicitly constructs MEDIUM effort. A custom detail directory must pass `--ledger-dir=local/test-results/pipeline-v2-new` to share the same run cap; run paid stages sequentially because this small harness does not implement concurrent ledger locking. `--focus="..."` limits trace requests to the supplied crop. Detail images must be prepared and their parent-frame metadata recorded before requesting them.

Inspect `attempt-ledger.json`, stage prompts/schemas, raw provider responses, `trace-validation.json` and `validation.json`. A response saved successfully can still fail geometry validation. Local JSON schema is stricter than the provider projection; frame equality, object references and polygon checks run after response parsing. Overlap and opening-boundary results remain review obligations. The harness never converts opening proposals into accepted doors or route edges, never self-approves a reviewer and never publishes a map.

Price estimates use an explicitly documented conservative token basis, not a provider spending limit or confirmed invoice. The six-attempt cap is per ledger, not a Cloud account quota. This is a fixture-specific research tool, not a resumable production scheduler or general API adapter.
