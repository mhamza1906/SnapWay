# Frozen final configuration: placematch-v2 (2026-10-17)

`inventory.json` hashes (60 files) the validation-calibrated thresholds
(`data/calibration/placematch-v2/thresholds.json`), the v2 manifest, labels and subsets, the
four run outputs under `runs/bench-v2/`, `uv.lock` and every `placematch/*.py` file. It was
written after validation-only calibration and **before** any test metric was computed; the
test split was then evaluated once (`bash scripts/eval_v2.sh`). `data/frozen/bench-v2-final/`
keeps a copy of the thresholds and `source.tar.gz`.

Verify: `uv run python -m placematch.baseline verify baselines/bench-v2-final/inventory.json`
(source files may differ after later edits; data/results must match).

Known post-freeze change (expected `CHANGED [frozen] placematch/server.py` in the check):
after the evaluation, four lines were added to `/api/runs` in `server.py` to show each
run's provider in the UI run selector. It does not touch retrieval, verification,
decisions or evaluation; the frozen version is in `source.tar.gz`. All data, threshold and
result files still match.

After the final run an agent inspected test failures (REPORT-v2.md §7). Any future system
change therefore turns the v2 test split into development data; the next final evaluation
needs new untouched recordings or locations.
