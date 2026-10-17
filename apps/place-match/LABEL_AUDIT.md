# Label audit (bench-v1, carried into placematch-v2)

Owner: datasets/evaluation subagent. Date: 2026-10-17. Everything here was done by an
agent (code + looking at images); **no person has reviewed any label**. Original bench-v1
labels are preserved unchanged (`data/bench/placematch-v1/` is frozen and read-only).

Reproduce every number below (development data only; bench-v1 runs may be inspected):

```bash
R="gemini=runs/bench-v1/gemini/results.json gemini+verify=runs/bench-v1/gemini/results.json \
   megaloc=runs/bench-v1/megaloc/results.json megaloc+verify=runs/bench-v1/megaloc/results.json"
A=data/bench/placematch-v2-audit/bench-v1
uv run python -m placematch.evaluation.label_audit --bench data/bench/placematch-v1 --runs $R \
    --thresholds data/calibration/thresholds.json --out $A
uv run python -m placematch.evaluation.sensitivity --bench data/bench/placematch-v1 --runs $R \
    --thresholds data/calibration/thresholds.json --out $A/sensitivity_automatic
uv run python -m placematch.evaluation.sensitivity --bench data/bench/placematch-v1 --runs $R \
    --thresholds data/calibration/thresholds.json \
    --agent placematch/datasets/agent_inspection_v1.json --out $A/sensitivity_with_agent_decisions
uv run python -m placematch.evaluation.run --bench data/bench/placematch-v1 --runs $R \
    --thresholds data/calibration/thresholds.json --out $A/eval_v2_metrics
```

The last command re-evaluates bench-v1 with the upgraded evaluation code; every headline
number, `by_condition`, `by_dataset`, `by_scene` and verification-effect value is identical
to the frozen `runs/bench-v1/eval/metrics.json` (checked field by field); only new fields
(counts, strict rates, clustered intervals) are added.

## 1. The ambiguity rules and when they were introduced

There is no Git history for `apps/place-match` (never committed). The only evidence is file
modification times (local time, 2026-10-17) and the frozen source copy
(`data/frozen/bench-v1/source.tar.gz`):

| Rule | Where | Introduced |
| --- | --- | --- |
| 7-Scenes depth overlap: positive >= 0.30, ambiguous [0.10, 0.30) | `datasets/bench.py` (`SEVEN_POS`, `SEVEN_AMB`) | first bench-v1 build; unchanged since |
| CLoc SfM co-visibility: positive shared >= 50 & covq >= 0.30 & covr >= 0.20; ambiguous shared >= 15 & max(cov) >= 0.10 | `datasets/bench.py` (`CLOC_POS`, `CLOC_AMB`) | first bench-v1 build; unchanged since |
| Recall: ambiguous candidates removed from the ranking before counting hits | `evaluation/metrics.py` | last edited 04:22, before any benchmark model run |
| FAR: no-reference queries whose accepted reference is ambiguous are removed from numerator **and** denominator; precision ignores ambiguous accepts | `evaluation/metrics.py` | same (04:22) |
| Agent overrides of 21 pairs (`agent_inspection_v1.json`) | `datasets/bench.py:apply_inspection` | file written 04:20 |

Order of events from timestamps: agent inspection 04:20 -> metrics code 04:22 -> first
MegaLoc smoke run on placematch-v1 04:29 -> final `labels.json` rebuild 04:36 -> Gemini
benchmark run 04:46-04:58 -> thresholds 05:11. The 04:36 rebuild came after the MegaLoc
smoke run; its label counts (validation 87/34/5, test 104/36/8 with/without/ambiguous-only)
are identical to those recorded in the smoke evaluation written at 04:35, so the rebuild did
not change the label counts (timestamps cannot prove that no individual reference list
changed). The pipeline demo runs before 04:20 used the separate demo video, not the
benchmark. The two "cross-scene distractor" inspection pairs (office vs heads / chess) are
exactly the confusion later reported for the models; the timestamps cannot show whether
earlier demo observations prompted that choice. Neither pair changed a label.

## 2. Effect on denominators (bench-v1, real queries)

| | test | validation |
| --- | --- | --- |
| real queries | 148 | 126 |
| with a valid reference | 104 | 87 |
| without (no co-visible reference / held out) | 36 | 34 |
| ambiguous only (no positive, >= 1 ambiguous ref; counted as "without") | 8 (all CLoc) | 5 (all CLoc) |
| queries with >= 1 ambiguous reference | 111 | 91 |
| ambiguous (query, reference) pairs | 1123 | 967 |
| agent-inspected queries / changed by the agent | 9 / 3 | 11 / 4 |

Queries and pairs removed from a denominator by the ambiguity rules (thresholds of
`data/calibration/thresholds.json`):

| method | split | valid queries whose top-1 was an ambiguous ref (skipped for Recall) | ambiguous accepts of valid queries (left out of precision) | ambiguous accepts of no-reference queries (left out of FAR) |
| --- | --- | --- | --- | --- |
| gemini | test | 8 | 3 | 2 |
| gemini+verify | test | 8 | 2 | 2 |
| megaloc | test | 7 | 3 | 0 |
| megaloc+verify | test | 7 | 3 | 0 |
| gemini | validation | 13 | 8 | 1 |
| gemini+verify | validation | 13 | 3 | 1 |
| megaloc | validation | 8 | 1 | 0 |
| megaloc+verify | validation | 8 | 1 | 0 |

The same results with the ambiguous accepts counted against the method (strict) - an
accepted ambiguous reference is **never** a correct rejection:

| method | split | FAR (v1 definition) | strict FAR | accepted precision | strict precision | acceptance coverage |
| --- | --- | --- | --- | --- | --- | --- |
| gemini | test | 0.024 (1/42) | 0.068 (3/44) | 0.922 | 0.874 | 0.642 |
| gemini+verify | test | 0.000 | 0.045 (2/44) | 1.000 | 0.949 | 0.534 |
| megaloc | test | 0.023 (1/44) | 0.023 | 0.987 | 0.949 | 0.534 |
| megaloc+verify | test | 0.023 | 0.023 | 0.986 | 0.947 | 0.514 |
| gemini | validation | 0.000 | 0.026 | 0.951 | 0.829 | 0.556 |
| megaloc | validation | 0.026 | 0.026 | 0.981 | 0.964 | 0.437 |

So the v1 headline "Gemini + verification FAR 0.000" relies on two CLoc no-reference queries
being excluded because the accepted reference sat in the ambiguous band. Both numbers are
now reported side by side (`MethodMetrics.extra.decision_metrics.far_strict`).

**Clustered uncertainty.** bench-v1 test R@1 rests on 6 recordings (validation 5) and FAR on
4. Cluster-bootstrap 95% intervals by recording: MegaLoc test R@1 0.923 [0.756, 1.000], Gemini
0.846 [0.611, 0.992]; FAR intervals span [0, ~0.047]. With so few clusters these intervals
are flagged unreliable; the v1 differences between backends are within them.

## 3. Case study: CLoc no-reference queries accepted with many inliers

The head agent observed CLoc no-reference queries accepted with 80-139 inliers on
same-building references that sit in the ambiguous band. Recomputed from the stored runs
(thresholds above), the accepted-ambiguous CLoc cases are:

| query | split | valid ref? | accepted reference | raw score (shared / covq / covr) | positive criterion missed | verification (top method) |
| --- | --- | --- | --- | --- | --- | --- |
| `NEB1/.../024/frame000978` | test | no | `db/f1/1639461180.591474591_2` | 161 / 0.225 / 0.406 | covq < 0.30 | verified, 80 inliers (gemini) |
| `NEB2/.../010/frame000412` | test | no | `db/b1/1616153008.633601510_3` | 92 / 0.675 / 0.172 | covr < 0.20 | verified, 107 (gemini) |
| `NEB2/.../005/frame000227` | validation | no | `db/b1/1616152928.634052168_2` | 143 / 0.475 / 0.188 | covr < 0.20 | verified, 139 (gemini) |
| `NEB2/.../004/frame000197` | test | yes | `db/b1/1616152880.631148517_2` | 148 / 0.700 / 0.062 | covr < 0.20 | inconclusive, 115 (gemini) |
| `NEB2/.../014/frame000572` | test | yes | `db/b1/1616152432.638440517_3` | 235 / 0.200 / 0.594 | covq < 0.30 | verified, 70 (gemini) |

I find three distinct no-reference CLoc queries (not four) accepted on ambiguous references
with 80-139 inliers; the fourth in the head's count may be one of the two queries with a
valid reference above or a double count across `gemini`/`gemini+verify`. All of them miss the
positive rule only on a *coverage* criterion (the shared-point count is far above 50), i.e.
the overlap is concentrated in one part of one of the images. The query `024/frame000978`
was agent-inspected in v1 against a *different* reference (decision ambiguous).

Decision: **no label was changed.** Inliers from the model pipeline are not ground truth, and
these coverage boundaries are a definitional choice. What changes:
- the pairs are counted explicitly (`ambiguous_accepts`, strict FAR / precision);
- the boundary sensitivity below includes `cloc_covr0.15` and `cloc_loose`, under which
  two / all three of these queries gain a valid reference;
- they belong in the human review sheet (`evaluation.gallery`), category `ambiguous_pair`.

## 4. Label-boundary sensitivity (bench-v1)

Labels re-derived from the stored raw scores (`overlaps.json`) for every variant below; all
variants are reported (`sensitivity_*/sensitivity.md`), none is selected. With "agent
decisions re-applied", the 21 visual decisions of v1 are kept on top of each variant.

Variants: `depth_pos0.20/0.40`, `depth_amb0.05/0.20`, `cloc_covr0.15`, `cloc_strict` (shared
>= 80, covq >= 0.4, covr >= 0.3), `cloc_loose` (30 / 0.2 / 0.1), `cloc_amb_wide`,
`no_ambiguous_band` (everything below positive is negative), `ambiguous_as_positive`.

Ranges over all variants, test split, agent decisions re-applied:

| method | R@1 | R@5 | FAR | accepted precision |
| --- | --- | --- | --- | --- |
| gemini | 0.808 - 0.875 | 0.848 - 0.955 | 0.024 - 0.068 | 0.874 - 0.933 |
| gemini+verify | 0.808 - 0.875 | 0.848 - 0.955 | 0.000 - 0.045 | 0.949 - 1.000 |
| megaloc | 0.885 - 0.948 | 0.949 - 0.982 | 0.020 - 0.028 | 0.962 - 0.987 |
| megaloc+verify | 0.885 - 0.948 | 0.949 - 0.982 | 0.020 - 0.028 | 0.960 - 0.987 |

Automatic labels only (no agent decisions), test: Gemini R@1 0.800-0.875, MegaLoc
0.876-0.948. The largest single effects: `no_ambiguous_band` lowers R@1 (Gemini 0.848 ->
0.800, MegaLoc 0.924 -> 0.876, automatic labels) because candidates that were skipped as
ambiguous now count as misses; `cloc_strict` raises CLoc R@1 while moving 8 test queries to
"no valid reference"; `depth_pos0.40` turns 5 test 7-Scenes queries into ambiguous-only and
raises strict FAR. MegaLoc R@1 > Gemini R@1 holds in every variant and both splits. The
FAR comparison is not stable: on test Gemini's FAR is equal to or higher than MegaLoc's in
every variant (0.024 vs 0.023 by default, 0.068 vs 0.023 with `no_ambiguous_band`), on
validation it is lower in all but one; the differences are 1-2 queries. (`mapfree_*` and
`cross_room_negative` do not apply to bench-v1 and equal the default.)

## 5. Change log and what was carried into placematch-v2

- `data/bench/placematch-v2/label_changelog.jsonl` records every label in v2 that differs from
  the automatic rule, with old / new label, evidence and who inspected it. In this phase
  the only entries are the v1 agent decisions re-applied to the same pairs (all on
  development queries); each is marked `agent (Claude, ...); not human reviewed`.
- No label was changed on the basis of model output (cosine, rank, inliers, acceptance).
- v2 stores every raw score (`raw_scores.json`, and per label `QueryLabel.scores`) so this
  sensitivity analysis can be re-run on v2 without re-deriving labels, and records
  `LabelSet.boundaries` / `label_version` / `changelog`.
- v2 adds a 12-Scenes rule: references of other rooms of the same apartment / office are
  ambiguous, because those rooms are separate reconstructions whose co-visibility cannot
  be computed (a check placing apt1 living queries in the kitchen frame found no depth
  agreement, which is consistent with both "separate frames" and "not co-visible" - the
  data cannot decide). Variant `cross_room_negative` reports the alternative.

## 6. Remaining weaknesses (not fixed)

- CLoc labels come from sparse SfM points; blank walls cannot occlude. Coverage criteria
  decide most boundary cases (section 3).
- 7-Scenes RGB and depth are not registered; overlap is computed on the depth image.
- 7-Scenes `office` vs `heads` look alike; the dataset treats them as separate scenes and
  the data cannot prove they are separate rooms.
- No label in either benchmark has been reviewed by a person. The review sheet
  (`python -m placematch.evaluation.gallery`) is prepared for that.
