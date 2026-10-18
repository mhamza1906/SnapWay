# Sam Ibrahim Level 1 — offline MegaLoc video test

The 104 uploaded Level 1 photos now have local MegaLoc descriptors, and
`IMG_1275.MOV` has been evaluated at two frames per second. The resulting video
and offline gallery show approximate reference-point candidates, including
uncertainty. **This experiment does not establish reliable exact-point tracking
and does not enable a production or phone localizer.** No application data,
uploads, UI, routing, pipeline settings, dependencies or credentials were changed.

Canonical architecture: [MegaLoc localization](localization-megaloc.md).
Personal history: ignored `local/ACTIONS.md`.

## Local deliverables

All generated media, reference copies and descriptors remain outside Git:

- `../Hack_The_valley/MegaLoc-Video-Test/index.html`: offline gallery.
- `../Hack_The_valley/MegaLoc-Video-Test/tracking.mp4`: 3:02.9 diagnostic video,
  upright source camera, original floor plan, raw and temporal candidates,
  matched reference images, numeric cosine/margin and uncertainty labels.
- `../Hack_The_valley/MegaLoc-Video-Test/docs/REPORT.md`: detailed local findings.
- `embeddings/reference-vectors.npy`: 104 × 8448 float32, row order in
  `reference-rows.json`; four separate directions per point.
- `embeddings/points/point-XX.npz`: one package per active point, containing
  four vectors, directions, reference IDs, node/target ID and plan coordinates.
- `embeddings/query-vectors.npy`: 366 × 8448 float32, row order in
  `frames.json.frames`; source presentation timestamps and frame hashes included.
- `reference-index/`: existing `vectors.npy`, `index.txt`, `meta.json` and
  `locations.json` format, available for later catalog packaging. It has not been
  uploaded or activated in the app.
- `frame-predictions.csv`, `tracking.json`, `track-segments.json`, and
  `validation/`: raw results, independent reference audit, visual comparisons
  collected before model results, and ten geometric overlap checks.

Paths below the third item are relative to the run directory. The read-only
reference export is `../Hack_The_valley/output/megaloc-reference-export/`.
No video frames were inserted into its reference gallery.

## Findings and limits

| Check | Observed result |
| --- | --- |
| Reference coverage | 26 Level 1 points × front/right/back/left = 104 photos; no other floor has eligible reference photos |
| Descriptor integrity | All 470 reference/query vectors finite and unit-normalized; distinct content; no exact query/reference byte overlap |
| Independent strong visual landmark candidates | Raw and temporal candidates agree at 54s → 25, 78s → 27, 126s → 19, 156s → 15 |
| Geometric scene overlap | 5/10 selected pairs pass unchanged existing verification thresholds, including 54/78/156s; 126s is inconclusive |
| User route hint | Point 1 → near 10/22, used only for evaluation; first 0–3.5s predicts 19, last five seconds predict 11/12 |
| Direction holdout stress test | Remove all images with the query direction: exact-point R@1 8/104, R@3 18/104; weak cross-view generalization |
| Temporal outcome labels | 174 pass transferred retrieval thresholds, 110 uncertain, 82 unsupported; these are **not** correct-frame counts |
| Local M3 inference | Cold load 8.65s; reference batches 30.40s; query batches 100.30s; twelve warm single-frame samples median 317.9ms / p95 452.0ms |

CPU follow-ups on the same 16 GiB M3 host: a small matched eight-frame test gave
275ms median at eight CPU threads versus 277–295ms on MPS, effectively tied at
this sample size. All eight point winners agreed; this measures consistency,
not ground-truth accuracy. No runtime defaults were changed.

A separate **fresh CPU-only, eight-thread, FP32, batch-one** memory run completed
96 video frames, eight full-resolution reference JPEGs and four warmups. Whole
process resident RAM during sampled inference was 1.08–1.21 GB (median 1.18 GB);
idle with model/index loaded was 1.28 GB. Startup reached 2.019 GB peak RSS and
**2.126 GB OS peak memory footprint**, independently captured with
`/usr/bin/time -l`. The model parameters account for 0.915 GB and all 104 cached
reference vectors for 3.51 MB. GB here is decimal. A starting budget of roughly
3 GB per serial worker leaves headroom; an actual 8 GB device, other OS/CPU and
concurrent workers have not been validated. Reproduction scripts, phases and OS
output are retained under the local run's `validation/cpu-ram-benchmark/`; the
earlier comparison is under `validation/cpu-gpu-benchmark/`.

Independent landmark comparisons are agent-inspected candidates, not surveyed
ground truth. Startup Point 19 also has verified geometric overlap with the
glass vestibule; the conflict with the user's Point 1 start remains unresolved
and was not hidden by relabeling or endpoint constraints. The blurred endpoint
shares views among nearby lobby stops. No overall exact-point accuracy can be
calculated from these observations.

All photos retain collector-proposed labels. Directions are collection-relative;
absolute headings, capture timestamps and a verified metres-per-plan-unit scale
are absent. The floor plan positions are photo stops, not recovered camera poses.
The current video contains no independently identified floor transition.

## Method

Reused the existing pinned [MegaLoc](https://github.com/gmberton/MegaLoc)
implementation, [checkpoint](https://huggingface.co/gberton/MegaLoc) and local
MPS runtime, following the [paper](https://arxiv.org/abs/2502.17237). Code revision
`5fe0dd697c4a70ba3e23607f6716ab3c606b16db`, checkpoint revision
`a0f34722c4297ff787e022433799250180860af7`, SHA-256
`d4f9f2bcb60018f91eb6a8e061ed054fd55654e10c2569cf13841ea986ffb4f8`.
RGB/upright → ImageNet normalization → antialiased 322 × 322 → 8448-dimensional
L2 vector. Separate directional descriptors are compared by cosine, taking the
maximum per distinct graph point. A margin compares different points.

The fixed existing benchmark thresholds (accept 0.330906689, reject 0.289042462,
margin 0.01) were transferred without tuning on the video. They are not
site-calibrated probabilities. Image-quality flags and temporal disagreement
make candidates uncertain; smoothing never upgrades an unsupported retrieval.
Offline Viterbi uses the exported open-edge graph and future frames, preserving
disconnected components. Display trails follow graph supports and break across
uncertainty. No metre-based speed or continuous trajectory is inferred.

The source is 182.883 seconds, 5,484 coded frames. Only 366 upright samples at
approximately 0.5-second intervals were embedded; analysis uses actual source
presentation timestamps. The 10-fps diagnostic render holds each sample result
until the next analysis time and preserves source audio. Single-frame timings
include decode, preprocessing and GPU completion, but exclude phone networking,
multiuser load and continuous capture. This is not an end-to-end live benchmark.

Ten optional SuperPoint/LightGlue checks used existing cached weights, original
images and unchanged thresholds: ≥40 inliers, ratio ≥0.30, coverage ≥0.12 in both
images. They measure scene overlap, not exact mapped camera position. No paid
inference, model downloads or external API calls were needed.

## Reproduce

From the repository root, use the existing place-match Python environment; this
checkout reused the sibling `../SnapWay/apps/place-match/.venv/bin/python` and
its `data/models/megaloc` cache. No environment file or dependency changes are
required for local MegaLoc. With shell variables pointing to the interpreter,
export manifest, source movie, model cache and output directory:

```sh
PYTHONPATH=apps/place-match "$PM_PYTHON" -m placematch.ops.point_video_embeddings \
  --references "$PM_REFERENCES" --video "$PM_VIDEO" --output "$PM_RUN" \
  --model-cache "$PM_MODEL_CACHE" --fps 2 --batch-size 4
PYTHONPATH=apps/place-match "$PM_PYTHON" -m placematch.ops.point_video_tracking \
  --run "$PM_RUN" \
  --anchors "$PM_RUN/validation/model-blind-visual-audit/visual-anchor-candidates.json"
PYTHONPATH=apps/place-match "$PM_PYTHON" -m placematch.ops.point_video_render \
  --run "$PM_RUN" --video "$PM_VIDEO" --output "$PM_RUN/tracking.mp4" --render-fps 10
PYTHONPATH=apps/place-match "$PM_PYTHON" -m placematch.ops.point_video_gallery --run "$PM_RUN"
```

The embed step verifies source/reference/frame hashes on resume; cached vectors
remain tied to exact content and model preprocessing. Independent one-off
auditing scripts are retained with the local `validation/` artifacts.

## Implementation and validation

- [Embedding/export CLI](../apps/place-match/placematch/ops/point_video_embeddings.py)
- [Point retrieval and offline tracking](../apps/place-match/placematch/ops/point_video_tracking.py)
- [Diagnostic video renderer](../apps/place-match/placematch/ops/point_video_render.py)
- [Offline gallery](../apps/place-match/placematch/ops/point_video_gallery.py)
- [Independent helper tests](../apps/place-match/tests/test_point_video_tracking.py)
- [Artifact integrity and packaging tests](../apps/place-match/tests/test_point_video_artifacts.py)

Focused tracking/artifact integrity, frame extraction and retrieval tests passed
(51 tests); Ruff, artifact hashes/decoding and video output were checked.
Implementation: [e69bbf7](https://github.com/mhamza1906/SnapWay/commit/e69bbf7)
on `feature/map-authoring-pipeline`. Generated photos, model weights, videos and
private runtime artifacts are excluded from Git.
