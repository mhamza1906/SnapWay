# Frozen baseline: bench-v1 (2026-10-17)

Frozen before the v2 phase without a Git commit. `inventory.json` lists SHA-256 hashes of
the benchmark (`data/bench/placematch-v1/`), thresholds (`data/calibration/thresholds.json`),
results and indexes (`runs/bench-v1/`), and the source at freeze time. Those paths were made
read-only; `data/frozen/bench-v1/` holds a copy of the small files plus `source.tar.gz`.

Verify: `uv run python -m placematch.baseline verify baselines/bench-v1/inventory.json`.

## Provider identity

The Google results in bench-v1 came from the **Gemini Developer API**
(`genai.Client(api_key=GEMINI_API_KEY)`, endpoint `generativelanguage.googleapis.com`),
model `gemini-embedding-2`, backend key `gemini:gemini-embedding-2:d3072:max1024:jpg90`.
They are **not** Vertex AI results and must not be relabelled as such.

## Status of bench-v1 data in later versions

Every bench-v1 query (validation and test) and every agent-inspected pair has influenced
development (thresholds, verification fixes, failure analysis). In later benchmark
versions they may only be used as development data, never in a final held-out test.

## Headline numbers (test split, 148 real queries; see `REPORT.md`)

| Method | R@1 | R@5 | FAR | Accepted precision |
| --- | --- | --- | --- | --- |
| Gemini Developer API | 0.846 | 0.865 | 0.024 | 0.922 |
| Gemini Developer API + verification | 0.846 | 0.865 | 0.000 | 1.000 |
| MegaLoc | 0.923 | 0.962 | 0.023 | 0.987 |
| MegaLoc + verification | 0.923 | 0.962 | 0.023 | 0.986 |
