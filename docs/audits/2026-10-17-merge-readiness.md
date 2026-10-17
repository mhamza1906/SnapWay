# Acceptance branch merge-readiness repairs

Date: October 17, 2026. Branch: `acceptance/map-authoring-pipeline`.

## Integration and resolved failures

Merged remote main `7af9eae` into this branch in `04e632e`. Resolved README and
environment-template conflicts by preserving both the authoring pipeline and the
iOS/place-match integration. The previous [gap audit](2026-10-17-main-sync-gaps.md)
remains the dated original evidence; this report updates its build/CI findings,
not its unresolved product acceptance results.

- **Classifier:** the earlier seven two-result/three-result failures were fixed
  in the configuration increment. Current tests exercise backend/web/pipeline
  outputs and trigger both backend and pipeline checks for the root template.
- **Python quality:** formatted the image-metering and SQLite-staging tools,
  removed an unused import and split long SQL/string literals. Staging replay
  against isolated copies produces identical table rows and summary to the old
  implementation; the original test database was not modified.
- **Frozen audit source:** the archived Figma `analyze.py` remains byte-identical
  to its original hash. Only that exact frozen file is excluded from executable
  Ruff discovery; [its maintained replacement](../../scripts/analyze_floorplan_vectors.py)
  is fully linted and reproduces every archived metric within float tolerance
  `1e-12`. A new [CI integrity check](../../scripts/check_audit_evidence.py) validates
  all ten archived artifacts. This is an explicit evidence boundary, not a blanket
  experiment or documentation-code exclusion.
- **Frontend formatting:** 80 existing files failed the newly integrated format
  gate. Applied the same checked Prettier configuration; no intentional UI,
  animation or business behavior changes. Both Angular production builds and the
  complete frontend test suite pass afterward.
- **Shared env integration:** the new engine still used its own `.env`. Updated
  [engine loading](../../apps/place-match/placematch/env.py),
  [token command](../../apps/place-match/placematch/cli.py),
  [mobile settings](../../apps/place-match/placematch/mobile_api.py) and
  [migration](../../scripts/env_contract.py) to use the shared file and canonical
  engine token. Load only consumed keys; retain the legacy process-token alias.
  New [root contract tests](../../apps/api/tests/test_place_match_env.py) run
  without model downloads or extra root runtime dependencies.
- **Windows telemetry:** optional Unix `resource` import, actual Windows working
  set measurement and an unavailable-value fallback replace import-time failure;
  missing `os.getloadavg` is handled. The implementation follows Microsoft's
  [GetProcessMemoryInfo](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo)
  and [PROCESS_MEMORY_COUNTERS](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters)
  contracts. Linux/macOS resource accounting remains unchanged.
- **Malformed-photo handling:** [verification](../../apps/place-match/placematch/verify.py)
  decodes input before loading model weights, and cache cleanup does not import
  Torch merely to handle an invalid input. A corrupt JPEG now reports the input
  error rather than a missing model dependency. Valid-image inference is unchanged.
- **Bootstrap document inventory:** upstream `186448e` renamed the detailed plan
  without updating the migration inventory, and `19e10d1` updated two baseline
  documents for the approved demo TLS exception. Retained the original manifest
  and all current source bytes; a separate [provenance overlay](../initial-approved-updates.json)
  records those exact upstream paths/hashes/commits. The
  [checker](../../scripts/check_docs.py) now handles the recorded transitions and
  still rejects unrecorded edits, missing files or invalid provenance. The local
  14-document check passes, with [integrity tests](../../apps/api/tests/test_document_inventory.py).

## Local validation

| Check | Result |
|---|---|
| Root Ruff lint / format | Passed across maintained Python code |
| Django system check / migration drift | Passed; no migration generated |
| API/MCP/infrastructure tests | 103 passed, 16 PostgreSQL-only skips |
| Node pipeline | 152 passed, 18 optional Waterloo-fixture skips |
| Angular format / unit tests | Passed; 12 files / 63 tests |
| Angular web / visitor production builds | Both passed |
| Capacitor Android sync | Passed; no APK/device acceptance claimed |
| Standalone place-match offline tests | 89 passed, 15 skips for missing local datasets, ffmpeg/ffprobe and real weights |
| Audit integrity / deterministic replays | Ten original assets unchanged; metrics and SQLite row/summary equivalence passed |
| Private env | Schema `2026-10-17.3`, 56 keys, checked without exposing or rotating values |

The standalone engine smoke run uses temporary `uv --with fastapi --with
torch==2.9.1` dependencies and disables the unrelated root pytest-django plugin;
the project's separate lockfile is unchanged. No model weights were downloaded and no real provider calls were made. This is offline functional coverage, not a
clean full engine installation or real inference benchmark.

Windows initially held the frontend's esbuild executable open. Stopped only the
matching workspace dev process and reran `npm ci`; installation and the subsequent
checks passed. This local file-lock failure is distinct from source/build defects.

## Remote checks and release boundary

Linux/Windows backend, isolated PostgreSQL, frontend and Node PR checks still need
the new pushed head. Local SQLite skips do not prove PostgreSQL constraints. A
draft PR is used to obtain that evidence without merging or deploying main; its
final check status is recorded after the run completes.

The [environment handoff](../environment-sync.md#merge-readiness-configuration-update)
requires members/server owner to apply schema `2026-10-17.3` and reviewed controller
updates. The Node/worker deployment plan remains unimplemented, IA-4's actual mock
fixture remains pending, and prior IA-1 AI quality failures are not repaired by
passing CI. No shared database mutation, real model call, production server
configuration, deployment or merge into main is part of this repair.
