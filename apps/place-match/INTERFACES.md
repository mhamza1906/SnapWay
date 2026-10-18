# place-match: shared interfaces and file ownership

Integration update: private configuration now follows the repository's
[single-env contract](../../docs/environment-sync.md) at `local/.env`; this is
separate from the independent Python dependency/lockfile boundary below.

Self-contained app inside SnapWay. It must not change anything outside
`apps/place-match/` (no edits to the root `pyproject.toml`, `uv.lock`, other apps,
CI or `docs/` except the single feature doc written by the head agent).

Run everything from `apps/place-match/` with `uv run ...` (own `.venv`, own `uv.lock`,
Python 3.12, torch with Apple MPS). Code must pass `uv run ruff check .` and
`uv run ruff format --check .` (line length 100).

## Contracts (head-owned, do not edit without asking the head agent)

- `placematch/schemas.py`: `Manifest`/`ManifestEntry`, `LabelSet`/`QueryLabel`,
  `ThresholdSet`, `RunResult`/`QueryResult`/`Candidate`/`VerificationResult`/`Decision`,
  `EvalReport`/`MethodMetrics`.
- `placematch/backends/base.py`: `EmbeddingBackend` protocol, `RequestBudget`,
  `RequestLimitExceeded`, `EmbedStats`, `EmbeddingIndex`, `l2_normalize`.

## Ownership

| Owner | Files |
| --- | --- |
| Head | `schemas.py`, `backends/base.py`, `cli.py`, `server.py`, `ui/`, `env.py`, `README.md`, `INTERFACES.md`, `REPORT.md`, `pyproject.toml`, `uv.lock` |
| Subagent 1 (pipeline) | `backends/__init__.py`, `backends/gemini.py`, `backends/megaloc.py`, `cache.py`, `frames.py`, `quality.py`, `retrieval.py`, `verify.py`, `decide.py`, `tests/test_pipeline_*.py`, `data/cache/`, `data/models/` |
| Subagent 2 (datasets/eval) | `datasets/*`, `evaluation/*`, `tests/test_eval_*.py`, `tests/test_datasets_*.py`, `data/raw/`, `data/bench/`, `DATASETS.md` |

Only Subagent 1 may run `uv add` (tell the head agent which package and why).
Subagent 2 uses the installed packages; ad-hoc download helpers may use
`uv run --with <pkg>` but library code must not import extra packages.

## Python entry points the head agent's CLI and UI call

Subagent 1:

```python
placematch.frames.extract_video(video: Path, out_dir: Path, fps: float = 1.0,
    location_id: str | None = None) -> list[ManifestEntry]          # role="query"
placematch.frames.ingest_images(directory: Path, role: Role, *, dataset="user",
    location_map: dict[str, str] | None = None,
    timestamps: dict[str, float] | None = None) -> list[ManifestEntry]
placematch.backends.get_backend(name: str, **options) -> EmbeddingBackend  # "gemini" | "megaloc"
placematch.quality.assess(path: Path) -> FrameQuality
placematch.retrieval.run_retrieval(manifest: Manifest, manifest_path: Path,
    backend: EmbeddingBackend, *, top_k=5, reverse_k=5,
    budget: RequestBudget, out_dir: Path, dry_run=False) -> RunResult
    # dry_run: report expected uncached requests without sending any
placematch.retrieval.estimate(manifest: Manifest, manifest_path: Path,
    backend: EmbeddingBackend) -> dict  # n_images, n_cached, n_uncached, expected_requests
# ingest_images recurses; location_map/timestamps keys are POSIX paths relative to
# `directory`; image ids are f"{role}:{relative_path}" (video: f"query:{stem}@{t:.3f}").
placematch.verify.verify_pair(query: Path, reference: Path, *,
    overlay_path: Path | None = None) -> VerificationResult
placematch.verify.verify_run(run: RunResult, manifest: Manifest, manifest_path: Path, *,
    top_n=3, overlay_dir: Path | None = None) -> RunResult        # fills candidate.verification
placematch.decide.apply_decisions(run: RunResult, thresholds: ThresholdSet | None,
    *, use_verification: bool) -> RunResult                        # fills query.decision
placematch.decide.calibrate(runs: dict[str, RunResult], labels: LabelSet,
    split="validation") -> ThresholdSet
```

Subagent 2:

```python
python -m placematch.datasets.<name> ...   # reproducible download + preparation
placematch.datasets.bench.build(...)        # writes data/bench/<bench>/manifest.json + labels.json
placematch.evaluation.metrics.evaluate(run: RunResult, labels: LabelSet, split: Split,
    method: str) -> MethodMetrics
placematch.evaluation.report.write(report: EvalReport, out_dir: Path) -> None  # metrics.json, .csv, .md
python -m placematch.evaluation.run --bench data/bench/<bench> ...   # end-to-end evaluation
```

## Semantics everyone relies on

- One `RunResult` per backend. Never compare vectors across backends or settings.
- `Candidate.cosine` is raw cosine similarity, never a percentage or probability.
- Verification never reorders candidates and is stored separately from cosine.
  A failed verification is `inconclusive`, never evidence of a different place.
- `Decision.outcome` is `likely_match`, `uncertain` or `no_supported_match`.
- `timestamp_s` only when actually known (video PTS, or supplied by the dataset).
- Ground truth is never fabricated. `QueryLabel.reviewed=True` only for a human review;
  agent inspection sets `agent_inspected=True`.
- Real capture variation is tagged `real:<condition>`; synthetic edits `synthetic:<edit>`.

---

# v2 phase (Vertex AI + broader benchmark), agreed 2026-10-17

The bench-v1 baseline is frozen (`baselines/bench-v1/`); never modify those files.
`schemas.py` is now 1.1 (all additions optional): `Split` adds `development`;
`ManifestEntry.floor_id/group_id/derived_from/content_sha256`;
`QueryLabel.label_version/group_id/eval_sets/derived_from/scores`;
`LabelSet.version/boundaries/changelog`; `QueryResult.timings_s`;
`RunStats.http_attempts/usage/cost_estimate/latency_s/peak_rss_mb/hardware/cold_start`;
`MethodMetrics.counts/ci`. `EmbeddingBackend.release()` is part of the protocol.

## v2 ownership

| Owner | Files |
| --- | --- |
| Head | as before + `baseline.py`, `baselines/`, `REPORT-v2.md` |
| Subagent 1 (Vertex + operations) | as before + `backends/vertex.py`, `placematch/ops/`, `tests/test_ops_*.py`, `VERTEX.md`, `runs/ops/` |
| Subagent 2 (datasets + evaluation) | as before + `LABEL_AUDIT.md`, `data/bench/placematch-v2*/`, `data/raw/<new datasets>/` |

## v2 entry points

Subagent 1:

```python
get_backend("vertex", project=None, location=None)  # env VERTEX_PROJECT / VERTEX_LOCATION
backend.config()  # MUST include provider ("vertex-ai" | "gemini-developer-api" | "local"),
                  # endpoint host, project, location, model, dims, preprocessing
retrieval.estimate(...)  # + cost_usd, pricing_source, pricing_checked_utc
retrieval.embed_only(manifest, manifest_path, backend, *, budget, allow_partial=True)
    -> EmbedStats   # resumable batch: embeds up to the budget, keeps every vector cached
```

Subagent 2:

```python
python -m placematch.datasets.bench build --version v2      # data/bench/placematch-v2/
evaluation.metrics.evaluate(...)          # + counts, clustered CIs (by group_id)
evaluation.sensitivity / scaling / gallery  # label-boundary sensitivity, gallery-size and
                                            # distractor sweeps from saved index vectors,
                                            # HTML failure gallery / review sheet
python -m placematch.evaluation.run --bench ... --subset <ids.json> --sets ...
```

## Budgets

- Vertex AI: at most 6,000 logical embedding requests in this phase (Subagent 1 smoke and
  operational tests: at most 300) and at most USD 25 estimated. Always dry-run first.
  Never raise quotas or provision paid compute.
- Gemini Developer API: no further requests (kept only for the v1 comparison).
- Downloads: at most 12 GB new data; keep at least 12 GB disk free.

## v2 split rules

- Every bench-v1 query recording, and every agent-inspected pair, is `development` only.
- `validation`: threshold tuning. `test`: final evaluation; queries come from recordings
  (and, for the location-disjoint set, locations) never used as bench-v1 queries and never
  used for tuning. Nobody looks at model outputs on `test` before the final frozen run.
- Synthetic variants keep their source image's split and carry `derived_from`; they are in
  `eval_sets=["robustness"]` and never in the main tables.
