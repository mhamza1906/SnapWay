# placematch-v2: measured results (2026-10-17)

Everything here was measured on this machine with the code in this folder; nothing is
estimated from papers. bench-v1 and its report ([REPORT.md](REPORT.md)) are frozen and
unchanged (`baselines/bench-v1/`). Full tables: `runs/bench-v2/eval-final/` (reproduce with
`bash scripts/eval_v2.sh`, 0 API requests).

## 1. What was compared, and how the test was protected

- **Benchmark** `placematch-v2` ([DATASETS.md](DATASETS.md), [LABEL_AUDIT.md](LABEL_AUDIT.md)):
  2,689 real queries (development 274 = all bench-v1 queries; validation 793; test 1,622),
  1,319 references, 4 dataset families (7-Scenes, 12-Scenes, CLoc, Niantic Map-free train
  scenes), 182 locations, 219 query recordings. 765 queries have no valid reference (668 at
  places absent from the gallery, 97 at known places with no co-visible reference).
  Correct match = co-visibility from depth/poses (7/12-Scenes), SfM points (CLoc) or the
  dataset's own overlap scores (Map-free); never "same room/building".
- **Splits**: by recording. Validation and test share no recording; no test recording was
  a bench-v1 query. 1,449 of the 1,622 test queries are **location-disjoint** (their
  locations have no validation queries). Synthetic edits keep their source's split and are
  reported separately.
- **Methods, identical inputs** (2,415 validation + test queries, all 1,319 references):
  Vertex AI `gemini-embedding-2` (`us`, 3072-d, max side 1024, JPEG q90), MegaLoc
  (`5fe0dd6`, 322×322), and each with SuperPoint + LightGlue verification of the top-1
  candidate (MAGSAC fundamental matrix; fixed thresholds ≥ 40 inliers, ratio ≥ 0.3,
  coverage ≥ 0.12, not tuned).
- **Protocol**: thresholds fitted on validation only (max correct accepts s.t. precision ≥
  0.9, FAR ≤ 0.05): Vertex accept cosine ≥ 0.828 / reject < 0.822; MegaLoc accept ≥ 0.331
  with margin ≥ 0.01 / reject < 0.289. Thresholds, labels, code and run outputs were then
  hash-frozen (`baselines/bench-v2-final/inventory.json`, 60 files) **before** any test
  metric was computed, and the test was evaluated once.
- **Intervals**: 95 % percentile bootstrap clustered by recording (107 recording clusters
  for recall, ~50 for FAR, 30 for absent-location FAR). Thousands of frames are not
  treated as independent trials.

## 2. Main result: test split, 1,622 real queries (1,141 with a valid reference, 481 without)

| Method | R@1 | R@5 | FAR (unknown) | Accepted precision | Coverage |
| --- | --- | --- | --- | --- | --- |
| Vertex AI | 0.887 [0.793, 0.951] | 0.940 [0.874, 0.985] | 0.073 [0.034, 0.129] | 0.913 [0.858, 0.957] | 0.657 |
| Vertex AI + verification | 0.887 [0.793, 0.951] | 0.940 [0.874, 0.985] | 0.015 [0.000, 0.046] | 0.985 [0.966, 0.996] | 0.535 |
| MegaLoc | **0.975** [0.961, 0.987] | **0.994** [0.988, 0.999] | 0.019 [0.000, 0.057] | 0.979 [0.960, 0.993] | 0.582 |
| MegaLoc + verification | 0.975 [0.961, 0.987] | 0.994 [0.988, 0.999] | 0.017 [0.000, 0.055] | 0.981 [0.961, 0.995] | 0.560 |

Decision counts (test). "Ambiguous" = accepted a reference in the label's uncertain band;
it is never counted as correct or as a correct rejection. No query was excluded.

| Method | Correct accepts | Wrong accepts (valid query) | False accepts (no reference) | Ambiguous accepts | Rejected valid | Uncertain | Correct rejections | Strict precision | Strict FAR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Vertex AI | 899 | 52 | 34 | 80 | 109 | 24 | 424 | 0.844 | 0.102 |
| Vertex AI + verify | 830 | 6 | 7 | 24 | 109 | 222 | 424 | 0.957 | 0.021 |
| MegaLoc | 897 | 10 | 9 | 28 | 129 | 80 | 469 | 0.950 | 0.025 |
| MegaLoc + verify | 869 | 9 | 8 | 22 | 129 | 116 | 469 | 0.957 | 0.023 |

**Verification effect (test).** Vertex: removes 73 wrong accepts, downgrades 69 correct
accepts to *uncertain*, rescues none. MegaLoc: removes 2 wrong accepts, downgrades 28
correct ones. Verification never changes recall@k (it does not reorder).

**Location-disjoint test (1,449 queries)**: Vertex R@1 0.880, FAR 0.068 (+verify 0.016);
MegaLoc R@1 0.972, FAR 0.021 (+verify 0.018); same picture as the full test.

**Validation → test shift.** Vertex FAR rose from 0.014 (validation) to 0.073 (test);
MegaLoc stayed at 0.019. Main cause: CLoc (different camera, long-term, repetitive
corridors) has no validation data (its query sessions were bench-v1), and Vertex's
FAR on CLoc test is 0.316. CLoc test is a single recording, so its own interval is
unreliable.

## 3. By dataset and condition (test, R@1 / FAR where defined)

| Group (n) | Vertex | Vertex + verify | MegaLoc | MegaLoc + verify |
| --- | --- | --- | --- | --- |
| 12-Scenes (636) | 0.946 / 0.013 | 0.946 / 0.000 | 0.990 / 0.000 | 0.990 / 0.000 |
| 7-Scenes (213) | 0.954 / 0.125 | 0.954 / 0.000 | 1.000 / 0.000 | 1.000 / 0.000 |
| CLoc (120) | 0.400 / 0.316 | 0.400 / 0.000 | 0.950 / 0.000 | 0.950 / 0.000 |
| Map-free, mostly outdoor (653) | 0.917 / 0.120 | 0.917 / 0.041 | 0.960 / 0.053 | 0.960 / 0.047 |
| Viewpoint change (159) | 0.629 | 0.629 | 0.868 | 0.868 |
| Partial view / occlusion (175) | 0.566 | 0.566 | 0.886 | 0.886 |
| Distance change (472) | 0.773 | 0.773 | 0.953 | 0.953 |
| Exposure change (166) | 0.699 | 0.699 | 0.952 | 0.952 |
| Low light (11) | 0.667 | 0.667 | 0.833 | 0.833 |
| Motion blur (22) | 0.938 / 0.250 | 0.938 / 0.000 | 1.000 / 0.000 | 1.000 / 0.000 |
| Same-site distractors (463) | 0.946 / 0.045 | 0.946 / 0.000 | 0.990 / 0.000 | 0.990 / 0.000 |
| Repetitive structure (20) | 1.000 | 1.000 | 1.000 | 1.000 |
| Absent location (418, FAR) | 0.032 | 0.000 | 0.000 | 0.000 |
| Absent view, known place (63, FAR) | 0.368 | 0.117 | 0.150 | 0.133 |
| No condition tag (250) | 0.996 | 0.996 | 0.992 | 0.992 |

Low-light, motion-blur and repetitive-structure groups are small; treat them as
anecdotal. Conditions are derived from poses and image statistics (DATASETS.md).

## 4. Robustness study (synthetic, separate; 42 real sources, 234 edits)

Test sources (24 queries, 20 with a reference): MegaLoc R@1 1.00 on the sources and
0.90–1.00 on every edit (bright, dark, crop, Gaussian blur, JPEG q15, rotate 90°). Vertex
R@1 is 0.70 on the *unedited* sources and 0.60–0.80 on the edits (lowest: blur 0.60,
JPEG q15 0.65). With verification no edited query was falsely accepted by either backend.
Sample sizes are small; this supplements, and does not replace, the real conditions above.

## 5. Gallery size, distractors and label boundaries

- Growing the gallery from 905 to 1,319 references (414 distractors; 40 from the same
  site, 374 from the same dataset family) changed R@1 by ≤ 0.003 for both backends; the
  cosine-only acceptance of no-reference queries rose from 0.060 to 0.073 for Vertex and
  stayed at 0.019 for MegaLoc. The sweep is limited by the small number of same-site
  distractors available.
- Label-boundary sensitivity (`eval-final/sensitivity/`), 14 variants (depth positive
  0.20/0.40, ambiguous floor 0.05/0.20, no ambiguous band, ambiguous-as-positive, four CLoc
  rules, Map-free positive 0.10/0.30, 12-Scenes cross-room negative), all reported. Test R@1
  ranges: MegaLoc 0.932–0.977, Vertex 0.844–0.900, so MegaLoc is ahead under every variant.
  FAR ranges: Vertex alone 0.059–0.091; Vertex + verify 0.013–0.021; MegaLoc 0.018–0.025;
  MegaLoc + verify 0.016–0.023.

## 6. Runtime, memory, API usage and cost

Hardware: Apple M3, 16 GB, macOS; MPS for MegaLoc and SuperPoint, CPU for LightGlue.
The machine was heavily loaded throughout (load average ~190–270 from other processes:
file sync, downloads); all timings are pessimistic.

| Item | Measured |
| --- | --- |
| Vertex embedding, 3,704 images in 4 resumable batches of ≤ 1,000 | 813 s ≈ 4.6 images/s (4 workers); 0 retries, 0 failures |
| Vertex per request, warm / cold first request | 0.86 s median / 2.86 s (+5.6 s credential load) |
| MegaLoc embedding, 3,483 uncached images | 1,220 s ≈ 2.9 images/s; warm 0.32 s/image; cold model load 8.2 s |
| Verification (top-1) | 1.26 s/pair (Vertex run, 2,415 pairs), 1.09 s/pair (MegaLoc run) |
| Per query, cached embeddings + search + verification | median 1.15 s, p95 2.04 s (Vertex); 1.33 s / 2.09 s (MegaLoc) |
| Peak RSS | 1.76 GB (Vertex run), 2.11 GB (MegaLoc run); 1,000-pair stress test flat (+2.9 % GPU driver memory) |
| Vertex logical requests this phase | 4,050 (112 ops/smoke + 3,704 paired + 234 robustness) = HTTP attempts (0 retries) |
| Vertex cost estimate | 258 tokens/image × $0.45 per 1M → $0.000116/image; ≈ $0.47 for this phase (price-list estimate, not a bill) |
| Re-runs | 0 requests: 3,734 / 3,734 cache hits |
| Gemini Developer API | 0 requests this phase |

Vertex vs the earlier Developer API: on 110 images the vectors were bitwise identical
(same model, same preprocessing), so bench-v1 "Gemini" numbers describe the same model;
they remain labelled as Developer API results.

## 7. Failure inspection (agent only, after the final run)

The gallery (`eval-final/gallery-*/failures.html`) and a fixed 90-row human review sheet per
backend (`review_sheet.csv/html`, reviewer columns empty) were generated after the frozen
evaluation. An agent looked at six accepted Vertex "errors": five accepted references were
labelled *ambiguous* and one *negative*, yet all six image pairs visibly show the same
statue, chess board, stove, desk or shrine roof, and all six passed verification with
40–375 inliers. This
suggests the overlap labels are conservative and part of the counted errors and ambiguous
accepts are true visual matches. Per the label rules nothing was changed; a person
should fill the review sheet before labels are revised (with a change-log entry).
**Because test outputs have now been inspected, the v2 test split must be treated as
development data for any future system change**; a new untouched set is needed for the next
final evaluation.

## 8. Recommendation

- **Default: MegaLoc (local) with calibrated thresholds; verification optional.** Best recall
  in every dataset and condition (test R@1 0.975, R@5 0.994), FAR 0.019, no API cost, ~3
  images/s embedding on this laptop. Verification adds little here (2 wrong accepts
  removed vs 28 correct ones downgraded); use it when a false accept is costly, or show
  it as evidence alongside the match.
- **Vertex AI embeddings: only with geometric verification.** Alone, FAR 0.073 and accepted
  precision 0.913 on test (0.316 FAR on CLoc). With verification, precision 0.985 and FAR
  0.015, but coverage drops to 0.535 and recall stays at R@1 0.887; it is weakest under
  viewpoint change (0.63), partial views (0.57), exposure change (0.70) and different
  cameras/long-term change (CLoc 0.40). Cost ≈ $0.000116 per image (estimate), ~4.6
  images/s with 4 workers; cached re-runs are free.
- **Abstain** (return *uncertain* / *no supported match*) when: top-1 cosine is below the
  calibrated reject threshold; Vertex retrieval is not geometrically verified; the place is
  known but the view may not be covered by any reference (the main residual error: FAR
  0.13–0.15 even for MegaLoc on "absent view" queries); and for deployments unlike the
  validation data (new buildings, different cameras), where thresholds must be
  re-validated (Vertex FAR rose 5× from validation to test).

## 9. Not tested or limited

- No phone video: video ingestion was tested on real recordings re-encoded with rotation
  and variable frame rate (ops tests), not on handheld phone footage.
- No day/night pairs; lighting is covered only by measured exposure change and 11 low-light
  queries. Map-free is mostly outdoor; InLoc (403), Baidu Mall (sign-in), St Lucia (403),
  ScanNet (signed form) and Map-free val/test scenes were not used.
- CLoc has no validation data and a single test recording; 7-Scenes heads has no new
  recording. Location-disjoint validation is empty by design.
- Verification thresholds were not calibrated; only top-1 was verified; only the `us`
  Vertex region; no Vertex batch prediction; ADC has no quota project set.
- Distractor sweep: only 40 same-site distractors.
- Labels are automatic plus agent inspection; no human review yet (sheet prepared).
