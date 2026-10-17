#!/usr/bin/env bash
# Final placematch-v2 evaluation with the frozen configuration
# (baselines/bench-v2-final/inventory.json). Run from apps/place-match:
#   bash scripts/eval_v2.sh
# Sends no API requests: every vector is cached and verification already ran.
set -euo pipefail
PM=(uv run python -m placematch.cli)
B=data/bench/placematch-v2
R=runs/bench-v2
T=data/calibration/placematch-v2/thresholds.json
E=$R/eval-final

uv run python -m placematch.baseline verify baselines/bench-v2-final/inventory.json

methods() {  # $1 = run dir prefix
  echo "vertex=$R/$1vertex/results.json" "vertex+verify=$R/$1vertex/results.json" \
       "megaloc=$R/$1megaloc/results.json" "megaloc+verify=$R/$1megaloc/results.json"
}

# Paired comparison on identical inputs: recording-disjoint (main) and location-disjoint.
"${PM[@]}" evaluate --bench $B --thresholds $T --splits test validation \
  --subset $B/paired_subset.json --sets main location_disjoint --out $E/main \
  --runs $(methods "")

# Controlled synthetic robustness study (separate from real conditions).
"${PM[@]}" evaluate --bench $B --thresholds $T --splits test validation \
  --subset $B/robustness_vertex_subset.json --sets robustness --out $E/robustness \
  --runs $(methods "robustness-")

# Label-boundary sensitivity (every variant reported).
uv run python -m placematch.evaluation.sensitivity --bench $B --thresholds $T \
  --splits test validation --out $E/sensitivity --runs $(methods "")

# Gallery-size and distractor sweeps on a fixed test query set (index vectors, no re-embedding).
for b in vertex megaloc; do
  uv run python -m placematch.evaluation.scaling --bench $B --run-dir $R/$b --split test \
    --subset $B/paired_subset.json --thresholds $T --out $E/scaling-$b
done

# Visual failure gallery and fixed human review sheet.
for b in vertex megaloc; do
  uv run python -m placematch.evaluation.gallery --bench $B --run "$b+verify=$R/$b/results.json" \
    --thresholds $T --split test --out $E/gallery-$b
done
