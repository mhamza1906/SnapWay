# place-match

Match frames from a recorded video (or an existing frame sequence) to reference
photographs of the same physical place, and find the best video frames for each
reference photo.

Self-contained app: its own `pyproject.toml`, `uv.lock` and `.venv`. Its Python dependencies remain independent of the SnapWay root environment;
private configuration follows the shared local/.env contract. Contracts and file ownership
are in [INTERFACES.md](INTERFACES.md); datasets in [DATASETS.md](DATASETS.md); label/split
audit in [LABEL_AUDIT.md](LABEL_AUDIT.md); Vertex AI setup in [VERTEX.md](VERTEX.md).
Measured results: [REPORT-v2.md](REPORT-v2.md) (current, Vertex AI vs MegaLoc on
placematch-v2) and [REPORT.md](REPORT.md) (frozen bench-v1, Gemini Developer API).

## How it works

1. **Ingest.** Reference photos come from a folder (first-level subfolders become
   location ids, or pass `--locations path,location_id` CSV). Queries come from a
   video (frames extracted at `--fps`, default 1, with real presentation timestamps
   and rotation applied) or a frame folder (identifiers kept; timestamps only if a
   `--timestamps` CSV is supplied).
2. **Embed.** Each image is embedded separately with identical settings by one
   backend: **MegaLoc** (`megaloc`, local, the default), Google `gemini-embedding-2` on
   Vertex AI (`vertex`, opt-in), or the legacy Gemini Developer API (`gemini`, kept only
   for bench-v1). Vectors
   are L2-normalised and cached by image content + model + preprocessing. Each
   backend has its own cache and index; vectors from different backends are never
   compared.
3. **Retrieve.** Cosine ranking gives the top 5 references per frame and the best
   frames per reference (reverse lookup). Blurry or badly exposed frames are flagged.
4. **Verify (optional).** SuperPoint + LightGlue correspondences on the strongest
   candidates, robust fundamental-matrix estimation (MAGSAC), reporting
   correspondences, inliers, inlier ratio and spatial coverage, with an overlay image.
   Geometry is reported next to cosine, never merged into it; a failed verification
   is *inconclusive*, not proof of a different place.
5. **Decide.** `likely_match`, `uncertain` or `no_supported_match` per frame using
   thresholds calibrated on a validation split. Cosine is a raw similarity, never
   shown as a percentage or confidence.

## Setup

Requirements: macOS or Linux, Python 3.12, [uv](https://docs.astral.sh/uv/), ffmpeg
(with ffprobe) on `PATH`. Tested on an Apple M3 with 16 GB RAM (MegaLoc and
LightGlue run on Apple MPS; CPU works but is slower; CUDA should work but was not
tested). About 1 GB for model weights plus the dataset subsets in DATASETS.md.

```sh
cd apps/place-match
uv sync                       # exact versions pinned in uv.lock
# Initialize/migrate repository local/.env from the root using scripts/env_contract.py.
# Obtain private values through the external team channel; do not create an app .env.
uv run pytest -q              # offline tests
```

Pinned components: see `uv.lock` (torch, opencv-python, google-genai, …) plus
LightGlue at commit `eb42fee2d71449efb0aa5c10549752b5d75384d8`. Model versions are
recorded in each run's `backend_config` and in REPORT.md.

## Command line

Defaults: `--backend megaloc` and **no geometric verification** (MegaLoc had the best
recall on placematch-v2 and embeds a frame in ~0.3 s locally; verification adds ~1.2 s per
frame). Opt in with `--verify`, or `--backend vertex` (needs Application Default
Credentials and `VERTEX_PROJECT`/`VERTEX_LOCATION`, see VERTEX.md; measured precision
is only acceptable *with* `--verify`). `gemini` is the legacy Developer API.
`uv run placematch embed --manifest M --backend vertex --limit 1000` embeds in resumable,
request-limited batches (re-run to continue); `--dry-run` prints requests and estimated cost.
`uv run placematch activate-thresholds data/calibration/placematch-v2/thresholds.json`
sets the default thresholds (already done).

```sh
# estimate API requests first (sends nothing)
uv run placematch ingest --references refs/ --video walk.mov --fps 1 --out runs/walk
uv run placematch estimate --manifest runs/walk/manifest.json --backend gemini

# run with a request limit, verification and calibrated thresholds
uv run placematch run --manifest runs/walk/manifest.json --backend gemini \
  --limit 200 --verify --thresholds data/calibration/thresholds.json

# or everything in one go, for both backends
uv run placematch match --references refs/ --queries frames/ --out runs/demo \
  --backend gemini --backend megaloc --verify
```

Outputs per backend in `<out>/<backend>/`: `results.json` (full `RunResult`),
`results.csv` (one row per frame × candidate), `reverse.csv` (best frames per
reference), `overlays/` (correspondence images) and `index/` (vectors).

## Benchmark: prepare, run, calibrate, evaluate

```sh
uv run python -m placematch.datasets.sevenscenes download         # ~6 GB streamed, subset kept
uv run python -m placematch.datasets.cloc metadata
uv run python -m placematch.datasets.cloc select
uv run python -m placematch.datasets.cloc images
uv run python -m placematch.datasets.bench build                  # data/bench/placematch-v1
B=data/bench/placematch-v1
uv run placematch run --manifest $B/manifest.json --backend gemini --limit 600 --verify --out runs/bench-v1/gemini
uv run placematch run --manifest $B/manifest.json --backend megaloc --verify --out runs/bench-v1/megaloc
uv run placematch calibrate --bench $B --runs runs/bench-v1/gemini/results.json runs/bench-v1/megaloc/results.json
uv run placematch evaluate --bench $B --thresholds data/calibration/thresholds.json --out runs/bench-v1/eval \
  --runs gemini=runs/bench-v1/gemini/results.json gemini+verify=runs/bench-v1/gemini/results.json \
         megaloc=runs/bench-v1/megaloc/results.json megaloc+verify=runs/bench-v1/megaloc/results.json
```

`calibrate` reads validation labels only; `evaluate` reports test and validation
separately (only test numbers are unbiased). Results: [REPORT.md](REPORT.md).

placematch-v2 (current): dataset preparation commands are in DATASETS.md; the runs,
calibration and freeze are described in REPORT-v2.md §1, and the final evaluation is
`bash scripts/eval_v2.sh` (0 API requests once cached).

## Troubleshooting

- `ModuleNotFoundError: No module named 'placematch'` from `uv run placematch`: macOS
  (e.g. Desktop/iCloud sync) set the *hidden* flag on `.venv/.../*.pth`, and Python ≥ 3.12.2
  skips hidden `.pth` files. Fix with
  `chflags nohidden .venv/lib/python3.12/site-packages/*.pth`, or run
  `uv run python -m placematch.cli ...` from this folder, which does not depend on it.
- Vertex AI warns "end user credentials … without a quota project": requests still work;
  to silence it, set a quota project for ADC (see [VERTEX.md](VERTEX.md)).

## Local interface

```sh
uv run placematch serve        # http://127.0.0.1:8777/ (loopback only)
```

Choose a reference folder and a video or frame folder, pick backends, press
**Prepare and estimate** to see the expected uncached API requests, set a limit
and run. Results show timestamps, quality flags, the decision, top-5 candidates
with cosine and verification statistics, a side-by-side view with the
correspondence overlay, reverse lookup, and JSON/CSV downloads. Past runs under
`runs/` (including benchmark runs) can be opened from the run selector.

## Mobile API (iOS app)

A separate token-protected API for the SnapWay iOS app (never tunnel `serve`, port 8777):

```sh
uv run placematch build-references --references DIR --name SET            # MegaLoc index
uv run placematch build-references --references DIR --name SET --backend vertex --dry-run
uv run placematch mobile-token --create   # canonical token in repository local/.env; not printed
MOBILE_REFERENCE_SET=SET uv run placematch serve-mobile                     # 127.0.0.1:8790
```

`GET /v1/health`, `POST /v1/match` (JPEG ≤ 3 MB, `meta` JSON; `backend=auto|megaloc|vertex`,
`verify`, `second_opinion`), `GET /v1/references/{set}/thumb/{id}`,
`GET /v1/references/{set}/megaloc-index`. MegaLoc decides first; Vertex AI is a fallback or a
verified second opinion only. Rules, auth and setup: [`docs/mobile-ios.md`](../../docs/mobile-ios.md).

