# Measured results (2026-10-17)

All numbers below were measured on this machine (Apple M3, 16 GB, macOS) with the
code in this folder. Nothing is estimated or copied from papers. Full tables:
`runs/bench-v1/eval/report.md` (+ `metrics.json`, `metrics.csv`).

## Setup

- Benchmark `placematch-v1` (details in [DATASETS.md](DATASETS.md)): 251 references from
  six places (7-Scenes chess, fire, heads, stairs; CLoc NEB1, NEB2 floors) and 274 real
  queries from *different recordings* (validation 126, test 148), plus 45 synthetic edits
  (test only, reported separately). 70 real queries come from places with no reference at
  all (7-Scenes office, CLoc SFB building); a few more CLoc queries have no co-visible
  reference.
- Correct match = co-visibility from poses + depth (7-Scenes) or the SfM point cloud
  (CLoc), not "same room" and not camera distance. Ambiguous references count as neither
  right nor wrong.
- Backends: `gemini-embedding-2` (3072-d, max side 1024, JPEG q90, one image per request)
  and MegaLoc (commit `5fe0dd6`, weights `gberton/MegaLoc@a0f3472`, 322×322, 8448-d).
  Verification: SuperPoint (2048 kp) + LightGlue (`cvg/LightGlue@eb42fee`), fundamental
  matrix with MAGSAC; `verified` needs ≥ 40 inliers, ratio ≥ 0.3, coverage ≥ 0.12.
- Thresholds were fitted on the **validation** split only (maximise correct accepts with
  precision ≥ 0.9 and false acceptance ≤ 0.05) and frozen before reading test numbers:
  Gemini accept cosine ≥ 0.839, reject < 0.813; MegaLoc accept ≥ 0.358 and margin ≥ 0.02,
  reject < 0.264 (`data/calibration/thresholds.json`). Cosine values of the two models are
  on different scales and are never compared with each other.

## Test split (148 real queries: 104 with a valid reference, 44 without)

| Method | R@1 | R@5 | False acceptance | Accepted precision | Accepted recall |
| --- | --- | --- | --- | --- | --- |
| Gemini | 0.846 | 0.865 | 0.024 (1/42) | 0.922 | 0.798 |
| Gemini + verification | 0.846 | 0.865 | 0.000 | 1.000 | 0.721 |
| MegaLoc | **0.923** | **0.962** | 0.023 (1/44) | 0.987 | 0.721 |
| MegaLoc + verification | 0.923 | 0.962 | 0.023 (1/44) | 0.986 | 0.692 |

Verification never reorders candidates, so recall@k is unchanged; it only changes which
matches are accepted.

| Test split | 7-Scenes R@1 (100 q) | CLoc R@1 (48 q) | CLoc R@5 |
| --- | --- | --- | --- |
| Gemini | 0.988 | 0.375 | 0.458 |
| MegaLoc | 1.000 | 0.667 | 0.833 |

**Effect of verification on decisions (test):** Gemini — 7 wrong accepts removed, 8
correct accepts downgraded to *uncertain*, 0 rescued. MegaLoc — 0 wrong removed, 3
correct downgraded. (Validation: Gemini 2 wrong removed / 16 correct downgraded; MegaLoc
1 / 6.) Verification mostly trades recall for precision; it is most useful for Gemini
on CLoc, where Gemini's accepted precision rises from 0.455 to 1.000.

**Synthetic edits (45 test, not a substitute for real data):** darkening and cropping
did not change R@1 (1.000 for both backends). Synthetic motion blur caused Gemini to
accept an office frame as *heads* (FAR 0.333 on the 3 blurred no-reference queries);
verification removed it.

## Demo: recorded sequence as a video

`data/demo/chess_then_stairs.mp4`: 200 frames of 7-Scenes chess test seq-03 followed by
60 frames of stairs seq-01 (a place with **no** reference photos), encoded at 6 fps =
the real rate of the kept frames (every 5th of 30 Hz), 43.3 s. References: 80 photos from
the *training* recordings of chess, fire, heads, office. Extracted at 1 fps → 44 frames
with timestamps 0–43 s.

| Backend | Chess frames (34) | Stairs frames (10, no reference) | Wrong place accepted |
| --- | --- | --- | --- |
| Gemini | 31 likely, 3 no supported match | 10 no supported match | 0 |
| MegaLoc | 25 likely, 8 uncertain, 1 no supported match | 10 no supported match | 0 |

All 34 chess frames had a chess reference at rank 1 with both backends.

## Cost and time

| Item | Measured |
| --- | --- |
| Gemini, benchmark (570 images) | 510 requests + 60 cache hits, 184.8 s embedding (4 workers ≈ 0.36 s/image) |
| Gemini, re-run of benchmark / demo | 0 requests (570 / 124 cache hits), < 1 s |
| Gemini requests in total during development | 26 (smoke tests) + 118 (demo) + 510 (benchmark) = 654 |
| MegaLoc, cold (124 demo images, incl. model load, shared GPU) | 62 s |
| MegaLoc, cached | 0.3–0.6 s |
| Verification, top 3 per query | 0.85–2.3 s per pair (timing varied with other jobs on the machine; 957 pairs ≈ 12 min) |

## Where it succeeds

- Distinguishing different rooms of 7-Scenes from different recordings: R@1 ≈ 0.99–1.0 for
  both backends; held-out rooms and the stairs segment are mostly rejected.
- Requests are predictable and bounded: `estimate` before sending, `--limit` refuses
  before sending, cache makes re-runs free.
- Geometric verification removes Gemini's wrong accepts on CLoc.

## Where it fails (inspected cases)

- **CLoc (long-term, different camera, corridors):** Gemini R@1 0.375 vs MegaLoc 0.667.
  Every wrong Gemini accept on CLoc pointed to a reference in the same building (one NEB2
  query went to NEB1), i.e. repetitive corridors/lobbies rather than unrelated places.
- **Look-alike rooms:** 7-Scenes *office* (no references) vs *heads* (a desk in an office)
  is the source of every 7-Scenes false accept. One MegaLoc case passed verification with
  41 inliers, mostly on a blurry partition (inspected by the agent, not a person); the
  fixed `min_inliers=40` is too permissive for that. The data cannot prove these are
  different physical spaces (DATASETS.md).
- **Verification rejects correct matches** when overlap is small or seen from far away
  (3–16 correct accepts downgraded per split). These are reported as *inconclusive*, never
  as evidence of a different place.
- CLoc labels come from sparse SfM points, so blank walls cannot occlude; agent inspection
  changed 7 of 21 automatic labels. Treat CLoc numbers as noisier than 7-Scenes.

## Not tested / limitations

- No phone video was available: video ingestion was tested on real 7-Scenes recordings
  re-encoded as a video and on synthetic ffmpeg videos with rotation metadata.
- No real day/night or lighting-change data in the benchmark (no lighting tag is assigned).
- Niantic Map-free (needs a person to accept the licence) and InLoc (host returned 403)
  were not used. 7-Scenes is non-commercial (Microsoft Research licence); CLoc is
  CC BY-NC 4.0.
- Real 429/5xx retry behaviour is covered only by mocked tests; no rate-limit errors
  occurred.
- Verification thresholds are fixed defaults, not calibrated; the benchmark is small (148
  test queries), so differences of one or two queries move rates by ~1–2 points.
- CUDA and HEIC input were not tested.
