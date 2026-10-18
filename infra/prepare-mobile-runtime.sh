#!/usr/bin/env bash
# Non-root preparation and one synthetic CPU check; no service/private-env changes.
set -euo pipefail
umask 022

usage() { echo 'Usage: prepare-mobile-runtime.sh <40-hex-commit>-<run>-<attempt> [--check-only]' >&2; exit 2; }
[[ $# -ge 1 && $# -le 2 ]] || usage
release_id=$1
[[ "$release_id" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || usage
check_only=0
if [[ $# == 2 ]]; then
  [[ "$2" == --check-only ]] || usage
  check_only=1
fi
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo 'Preparation requires the existing Linux x86_64 Vultr host.' >&2; exit 1;
}
task_root=/srv/indoor-nav
commit_id=${release_id%%-*}
source_root="$task_root/incoming/$release_id/source"
runtime_root="$task_root/venvs/mobile-$commit_id"
node_version=24.15.0
node_archive="node-v$node_version-linux-x64.tar.xz"
# Official https://nodejs.org/dist/v24.15.0/SHASUMS256.txt, checked October 18, 2026.
node_sha256=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6
for name in apps/pipeline/package.json apps/pipeline/package-lock.json apps/place-match/pyproject.toml apps/place-match/uv.lock apps/place-match/placematch/backends/megaloc.py; do
  [[ -f "$source_root/$name" && ! -L "$source_root/$name" ]] || {
    echo "Missing regular committed source: $name" >&2; exit 1;
  }
done
[[ "$(readlink -f "$source_root")" == "$source_root" ]] || {
  echo 'Incoming source must not traverse symbolic links.' >&2; exit 1;
}
for executable in curl tar xz sha256sum git flock; do
  command -v "$executable" >/dev/null || { echo "Missing existing host tool: $executable" >&2; exit 1; }
done
[[ -x /usr/local/bin/uv ]] || { echo 'Existing /usr/local/bin/uv is required.' >&2; exit 1; }
[[ "$(/usr/local/bin/uv --version)" == 'uv 0.12.15'* ]] || {
  echo 'Use the reviewed uv 0.12.15 host runtime.' >&2; exit 1;
}
task_user_home=${HOME:?An existing user home is required}
# Dependency tools receive no inherited database, model-provider or deployment secrets.
run_clean() {
  env -i "HOME=$task_user_home" "PATH=$runtime_root/node/bin:/usr/local/bin:/usr/bin:/bin" \
    LANG=C.UTF-8 GIT_TERMINAL_PROMPT=0 UV_NO_PROGRESS=1 UV_HTTP_TIMEOUT=180 \
    "UV_PYTHON_INSTALL_DIR=$task_root/python" PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 NUMEXPR_NUM_THREADS=2 \
    CUDA_VISIBLE_DEVICES= "$@"
}
if (( ! check_only )); then
  [[ -w "$task_root/venvs" && -w "$task_root/python" ]] || {
    echo 'The deployment user needs its existing venv/python directory access; root is not required.' >&2; exit 1;
  }
  mkdir -p "$runtime_root"
  [[ "$(readlink -f "$runtime_root")" == "$runtime_root" ]] || {
    echo 'Runtime path must not traverse symbolic links.' >&2; exit 1;
  }
  exec 9>"$runtime_root/.prepare.lock"
  flock -n 9 || { echo 'This commit is already being prepared.' >&2; exit 1; }
  # The unchanged Linux PyPI torch lock includes CUDA wheels even on a CPU host.
  available_kib=$(df -Pk "$runtime_root" | awk 'NR == 2 { print $4 }')
  if [[ ! -f "$runtime_root/prepared.json" ]] && (( available_kib < 12 * 1024 * 1024 )); then
    echo 'At least 12 GiB free is required for the unchanged locked runtime and weights.' >&2; exit 1;
  fi
  mkdir -p "$runtime_root/downloads" "$runtime_root/pipeline" \
    "$runtime_root/placematch-data" "$runtime_root/placematch-runs"
  if [[ ! -x "$runtime_root/node/bin/node" ]]; then
    run_clean curl --fail --silent --show-error --location --proto '=https' \
      --tlsv1.2 --retry 3 --connect-timeout 20 --max-time 900 \
      "https://nodejs.org/dist/v$node_version/$node_archive" \
      --output "$runtime_root/downloads/$node_archive.part"
    printf '%s  %s\n' "$node_sha256" "$runtime_root/downloads/$node_archive.part" | sha256sum --check --status
    mv "$runtime_root/downloads/$node_archive.part" "$runtime_root/downloads/$node_archive"
    mkdir -p "$runtime_root/node"
    tar -xJf "$runtime_root/downloads/$node_archive" --strip-components=1 -C "$runtime_root/node"
  fi
  [[ "$("$runtime_root/node/bin/node" --version)" == "v$node_version" ]] || {
    echo 'Prepared Node version does not match the pinned release.' >&2; exit 1;
  }
  pipeline_hash=$(sha256sum "$source_root/apps/pipeline/package-lock.json" | cut -d' ' -f1)
  if [[ ! -f "$runtime_root/pipeline/.lock-sha256" ]] || \
     [[ "$(cat "$runtime_root/pipeline/.lock-sha256")" != "$pipeline_hash" ]] || \
     [[ ! -d "$runtime_root/pipeline/node_modules" ]]; then
    cp "$source_root/apps/pipeline/package.json" "$source_root/apps/pipeline/package-lock.json" "$runtime_root/pipeline/"
    run_clean npm ci --prefix "$runtime_root/pipeline" --omit=dev --ignore-scripts --no-audit --no-fund
    printf '%s\n' "$pipeline_hash" > "$runtime_root/pipeline/.lock-sha256"
  fi
  # Keep the existing lock and CPU-compatible model selection. Do not replace its
  # PyPI torch distribution with an unreviewed CPU wheel or mutate either lock.
  run_clean env "UV_PROJECT_ENVIRONMENT=$runtime_root/placematch" /usr/local/bin/uv sync \
    --project "$source_root/apps/place-match" --frozen --no-dev --no-editable --link-mode copy --python 3.12.14
fi
[[ -x "$runtime_root/node/bin/node" && -x "$runtime_root/placematch/bin/python" ]] || {
  echo 'Runtime is not prepared.' >&2; exit 1;
}
[[ "$("$runtime_root/node/bin/node" --version)" == "v$node_version" ]] || {
  echo 'Node version mismatch.' >&2; exit 1;
}
run_clean "$runtime_root/node/bin/node" -e \
  "require(process.argv[1] + '/pipeline/node_modules/sharp'); require(process.argv[1] + '/pipeline/node_modules/express');" "$runtime_root"
run_clean env "PYTHONPATH=$source_root/apps/place-match" \
  "$runtime_root/placematch/bin/python" - "$runtime_root" "$source_root" "$check_only" "$node_sha256" <<'PY'
import hashlib
import json
import resource
import sys
import time
from pathlib import Path

import cv2
import torch
from placematch.backends import megaloc

torch.set_num_threads(2)
runtime, source = Path(sys.argv[1]), Path(sys.argv[2])
check_only = sys.argv[3] == "1"
assert sys.version_info[:3] == (3, 12, 14), "Python runtime version mismatch"
assert megaloc.device_name() == "cpu", "This preparation is CPU-only"
megaloc.MODEL_DIR = runtime / "placematch-data/models/megaloc"
megaloc.CODE_PATH = megaloc.MODEL_DIR / f"repo-{megaloc.COMMIT}" / "megaloc_model.py"
megaloc.WEIGHTS_PATH = megaloc.MODEL_DIR / f"hf-{megaloc.HF_REVISION}" / "model.safetensors"
if not check_only:
    megaloc.download()  # Only two pinned public model/code URLs; no provider or inference call.
for path, expected in (
    (megaloc.CODE_PATH, megaloc.CODE_SHA256),
    (megaloc.WEIGHTS_PATH, megaloc.WEIGHTS_SHA256),
):
    assert path.is_file() and not path.is_symlink(), "Pinned model artifact is missing"
    assert megaloc._sha256(path) == expected, "Pinned model artifact hash mismatch"
# The pinned constructor defines its backbone locally: it does not use torch.hub
# or fetch extra weights. This synthetic tensor is never cached or saved.
load_started = time.perf_counter()
model = megaloc.load_model()
model_load_ms = round((time.perf_counter() - load_started) * 1000, 1)
forward_started = time.perf_counter()
with torch.inference_mode():
    vector = model(torch.zeros(1, 3, 322, 322))
assert tuple(vector.shape) == (1, 8448), "Unexpected MegaLoc descriptor dimensions"
assert bool(torch.isfinite(vector).all()), "MegaLoc produced non-finite descriptor values"
forward_ms = round((time.perf_counter() - forward_started) * 1000, 1)
calibration = runtime / "placematch-data/calibration/current.json"
report = {
    "prepared": True,
    "started": False,
    "commit": runtime.name.removeprefix("mobile-"),
    "node_version": "24.15.0",
    "node_archive_sha256": sys.argv[4],
    "python_version": "3.12.14",
    "torch_version": str(torch.__version__),
    "device": "cpu",
    "synthetic_forward_shape": list(vector.shape),
    "synthetic_forward_finite": True,
    "model_load_ms": model_load_ms,
    "synthetic_forward_ms": forward_ms,
    "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
    "pipeline_lock_sha256": hashlib.sha256((source / "apps/pipeline/package-lock.json").read_bytes()).hexdigest(),
    "placematch_lock_sha256": hashlib.sha256((source / "apps/place-match/uv.lock").read_bytes()).hexdigest(),
    "model_code_sha256": megaloc.CODE_SHA256,
    "weights_path": str(megaloc.WEIGHTS_PATH),
    "weights_sha256": megaloc.WEIGHTS_SHA256,
    "weights_bytes": megaloc.WEIGHTS_PATH.stat().st_size,
    "calibration_present": calibration.is_file(),
    "calibration_sha256": hashlib.sha256(calibration.read_bytes()).hexdigest() if calibration.is_file() else None,
    "index_catalog_synced": False,
    "accuracy_validated": False,
}
if not check_only:
    temporary = runtime / "prepared.json.tmp"
    temporary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    temporary.replace(runtime / "prepared.json")
print(json.dumps(report))
PY
