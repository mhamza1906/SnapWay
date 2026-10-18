# Visual place matching (video frames ↔ reference photos)

**Product use:** MegaLoc in this app is the **canonical visitor photograph matcher** —
[localization-megaloc.md](localization-megaloc.md),
[localization-visitor-match.md](localization-visitor-match.md)
(`RevisionArtifact` indexes + `/v1/match-global`).

**Scope.** Also an experimental, self-contained bench/UI in [`apps/place-match/`](../apps/place-match/)
for video↔reference evaluation. Own `pyproject.toml` / `uv.lock` / `.venv`. Originally
`feature/mobile-ios`, now on main. Clients reach the engine via `serve-mobile` (8790) or
SnapWay `/api/navigation/localize/` — [mobile-ios.md](mobile-ios.md),
[place-match-production.md](place-match-production.md).

**How to run.** See [`apps/place-match/README.md`](../apps/place-match/README.md):
`uv sync`, then `uv run placematch match|run|calibrate|evaluate|serve` from
`apps/place-match/`. Local UI at http://127.0.0.1:8777/ (loopback only).

**Defaults.** MegaLoc (local) without geometric verification; Vertex AI and
verification are opt-in (see REPORT-v2.md for the measurements behind this).

**Env contract.** Vertex AI (opt-in Google provider): Application Default Credentials plus
`VERTEX_PROJECT` / `VERTEX_LOCATION` in the ignored `local/.env` (guide:
[`VERTEX.md`](../apps/place-match/VERTEX.md)). Legacy Gemini Developer API: `GEMINI_API_KEY`
in the same ignored file (bench-v1 only). Nothing secret is committed. MegaLoc and SuperPoint/LightGlue run locally
(weights downloaded into the ignored `apps/place-match/data/models/`).

**Design.** MegaLoc (default) and Google `gemini-embedding-2` image embeddings on
Vertex AI (opt-in) in separate caches and indexes; cosine top-5 plus reverse lookup;
optional SuperPoint + LightGlue verification (MAGSAC fundamental matrix) reported
separately from cosine; decisions `likely_match` / `uncertain` / `no_supported_match`
from thresholds calibrated on a validation split. Contracts:
[`INTERFACES.md`](../apps/place-match/INTERFACES.md).

**Results.** bench-v1 (frozen, 7-Scenes + CLoc): test R@1 Gemini Developer API 0.846,
MegaLoc 0.923 ([`REPORT.md`](../apps/place-match/REPORT.md)). placematch-v2 (7-Scenes,
12-Scenes, CLoc, Map-free; 1,622 recording-disjoint test queries, frozen thresholds): R@1
MegaLoc 0.975 vs Vertex AI 0.887; FAR MegaLoc 0.019, Vertex 0.073 (0.015 with verification)
([`REPORT-v2.md`](../apps/place-match/REPORT-v2.md),
[`LABEL_AUDIT.md`](../apps/place-match/LABEL_AUDIT.md)).

**Changed files.** Only new files: `apps/place-match/**` and this document.

**Actions.**
- 2026-10-17 (Arjun, with agents): built pipeline, datasets/evaluation, CLI, local UI;
  measured benchmark and demo.
- 2026-10-17 (Arjun, with agents): froze bench-v1 (`baselines/`); added Vertex AI backend
  (ADC, `us`), operational tests, placematch-v2 benchmark and label audit; final paired
  evaluation with frozen thresholds; Map-free licence accepted by Arjun in chat.
  Commits: none yet.
