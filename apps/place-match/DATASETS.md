# Datasets and benchmark

Owner: datasets/evaluation (Subagent 2). Everything under `data/` is local only
(`data/` is git-ignored); this file and the code in `placematch/datasets/` are the
reproducible record. Downloads are treated as untrusted data: nothing from them is
executed; CLoc ground-truth pickles are read with a restricted unpickler, COLMAP files
with a pure `struct` parser, Map-free `overlaps.npz` with `np.load(allow_pickle=False)`,
text files are parsed by hand.

Two benchmarks exist:

* **placematch-v2** (`data/bench/placematch-v2/`, current, this phase) - section 1-4.
* **placematch-v1** (`data/bench/placematch-v1/`, frozen baseline, read-only) - section 5,
  unchanged from the v1 phase. All of its queries are `development` data in v2.

The label audit of v1 (ambiguity rules, denominators, sensitivity) is in
[LABEL_AUDIT.md](LABEL_AUDIT.md).

## 1. Datasets inspected (2026-10-17)

| Dataset | Source (original) | Size | Licence / terms | Access result |
| --- | --- | --- | --- | --- |
| Microsoft 7-Scenes | https://www.microsoft.com/en-us/research/project/rgb-d-dataset-7-scenes/ (zips `https://download.microsoft.com/download/2/8/5/28564B23-0828-408F-8631-23B1EFF1DAC8/<scene>.zip`) | 7 scene zips, 0.96-6.14 GB (24.6 GB total) | Microsoft Research License Agreement, non-commercial ([RTF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/7-scenes-msr-la-dataset-7-scenes.rtf)); using the data means accepting it, no click-through | **Used**, all 7 scenes. 27 sequences on disk (13 new in v2). Deflated inner zips must be streamed whole: v2 streamed 6.02 GB for the 13 new sequences, plus partial streams lost when the first run hit a read timeout (at most ~2.3 GB, not logged) |
| Stanford 12-Scenes | http://graphics.stanford.edu/projects/reloc/ (`data/{apt1,apt2,office1,office2}.zip`) | 1.49 / 3.00 / 6.3 / 1.85 GB | CC BY-NC-SA 4.0 (project page); no form | **Used** (new). Members are individually deflated, so 4,572 pose files (every 5th frame) and 1,258 selected frames (colour+depth+pose) were range-fetched: 0.93 GB |
| CLoc (NEB1, NEB2, SFB) | https://github.com/kimjh069/CLoc, authors' Google Drive folder https://drive.google.com/drive/folders/12e2J_Eg7lICdEyDwDxKJHEDBoy5ytwAS | 2.63 / 3.86 / 8.01 GB | CC BY-NC 4.0 (repo LICENSE) | **Used**. v2 adds the SFB SfM model (33.7 MB metadata call) and 241 SFB images (0.32 GB), by HTTP range requests |
| Niantic Map-free | https://nianticspatial.com/research/map-free/dataset, https://github.com/nianticlabs/map-free-reloc; `train.zip` on `storage.googleapis.com/niantic-lon-static/research/map-free-reloc/dataset/` | train 118.6 GB (460 scenes), val 7.9 GB, test 15 GB (no poses) | "Niantic Map-free Relocalization Dataset License Agreement" (non-commercial), shown on the dataset page: downloading means accepting it. **Accepted by the user in chat on 2026-10-17 ("I accept the terms"), relayed by the head agent**; licence URL https://nianticspatial.com/research/map-free/dataset | **Used** (new): 160 *train* scenes only (the only split with `overlaps.npz` co-visibility GT). Range requests: central directory 60 MB + per-scene poses/intrinsics/overlaps/12 frames, 1.05 GB (plus ~0.3 GB in an aborted first run and probes). Validation scenes (poses, no overlaps) and test scenes (zero placeholder poses) are not used |
| InLoc | http://www.ok.sc.e.titech.ac.jp/INLOC/, https://github.com/HajimeTaira/InLoc_dataset | tens of GB (tar.gz) | MIT-style licence; asks users to agree to it | **Not used**: page reachable (HTTP 200) but `materials/iphone7.tar.gz` and `materials/cutouts.tar.gz` return **HTTP 403** (retried 2026-10-17). kapture's pose-only archives on download.europe.naverlabs.com are reachable but contain no images, and InLoc query poses are withheld (evaluation server) |
| VPR-datasets-downloader | https://github.com/gmberton/VPR-datasets-downloader | - | MIT (code); dataset licences not stated | Inspected only. Its St Lucia, Baidu, Nordland, Eynsham downloads come from an `rsync://vandaldata.polito.it` mirror, not from the original sources, so they were not used. Its formatters label positives by UTM distance (the benchmark repo uses 25 m); that is a geographic, not a visual-overlap criterion |
| Baidu Mall (IDL, CVPR'17) | original page https://sites.google.com/site/xunsunhomepage/ (cited by kapture) | ~690 DSLR database + ~2,300 phone queries (per papers) | not stated | **Not used**: the original page redirects to a Google sign-in (no account registered); only the polito mirror is reachable |
| St Lucia (QUT) | https://wiki.qut.edu.au/display/cyphy/St+Lucia+Multiple+Times+of+Day | - | not stated | **Not used**: original host returns HTTP 403; outdoor driving data with GPS-only ground truth |
| kapture / kapture-localization catalogues | https://github.com/naver/kapture (doc/datasets.adoc), https://github.com/naver/kapture-localization | - | per dataset | Inspected: 7-Scenes, Aachen, Baidu, Cambridge Landmarks (non-commercial), Extended CMU, InLoc, RobotCar, SILDa, Virtual Gallery (CC BY-NC-ND). Converters only; the originals were used where possible (7-Scenes, 12-Scenes) |
| ScanNet | http://www.scan-net.org/ | ~1.3 TB | ScanNet Terms of Use; download script issued only after a signed terms-of-use form | **Not requested** (needs a signed form on the user's behalf) |

## 2. Exact subsets on disk (v2 additions)

### 7-Scenes (`data/raw/7scenes/<scene>/seq-XX/`)

`uv run python -m placematch.datasets.sevenscenes download --subset v2` (`V2_SUBSET`; skips
sequences already complete). Every 5th frame is kept on disk; original `TrainSplit.txt` /
`TestSplit.txt` are saved and every sequence is checked against them. A dropped stream
restarts the sequence (up to 4 attempts; `stream_attempts` in `.complete.json`).

| Scene | References (TrainSplit) | validation queries | test queries | development (bench-v1 queries) |
| --- | --- | --- | --- | --- |
| chess | seq-01 | seq-02 (train split) | seq-04 (train split) | seq-03, seq-05 |
| fire | seq-01 | - | seq-02 (train split) | seq-03, seq-04 |
| heads | seq-02 | - | - (only 2 sequences exist) | seq-01 |
| stairs | seq-02, seq-03 | seq-05 (train split) | seq-06 (train split) | seq-01, seq-04 |
| pumpkin | seq-02 | seq-01 (test split) | seq-07 (test split) | - |
| redkitchen | seq-01 | seq-03 (test split) | seq-04 (test split) | - |
| office | **none (held out)** | seq-07 | seq-09 | seq-02, seq-06 |

All TestSplit recordings of chess, fire, heads and stairs were bench-v1 queries, so new
independent query recordings for those rooms come from other *TrainSplit* sequences
(marked `extra.original_split="train"`); they are never used as references.

### 12-Scenes (`data/raw/12scenes/<site>/<room>/`)

`uv run python -m placematch.datasets.twelvescenes fetch`. Per room: poses of every 5th
frame are read; scan 1 (`split.txt` `sequence1`, original training scan) gives up to 30
references at >= 0.35 m or >= 20 deg spacing; scan 0 (original test scan) and scans >= 2
give up to 40 queries each at >= 0.25 m or >= 15 deg spacing. Invalid (non-finite) poses
are skipped. `selection.json` records everything.

| Site | Rooms (split) | References |
| --- | --- | --- |
| apt1 | kitchen, living (test) | 14, 18 |
| apt2 | bed, kitchen, living (validation); **luke held out** (validation) | 16, 11, 20 |
| office1 | gates362, gates381, lounge (test); **manolis held out** (test) | 15, 30, 16 |
| office2 | **5a, 5b held out** (test; whole site absent) | - |

`office1/gates381` scan 3 is excluded: the leakage check found it duplicates scan 2 (36 of
40 selected scan-2 frames within 3 cm of a scan-3 pose along the same trajectory, 32 pHash
pairs <= 6 bits), so it is not an independent recording.

### CLoc (`data/raw/cloc/`)

`cloc metadata --buildings SFB --no-sfm` (now with the SFB SfM model), `cloc select-v2`
(`selection_v2.json`), `cloc images --select data/raw/cloc/selection_v2.json`.
NEB1/NEB2 references unchanged (45, 46). SFB references: 91 (same rule as v1: >= 150
registered SfM points, farthest-point order over panorama positions; SFB database images
are cubemap faces `cubemap_<id>_rdy(..)_rdz(..)_surface<k>`). New test queries: SFB session
`query-20210607-083241-10` (never used in bench-v1), pose-spaced (>= 1 m or >= 20 deg from
every kept query), 120 kept (even spread). NEB1 / NEB2 each have one query session, fully
used by bench-v1, so NEB queries are development only. Floors: NEB1 = `NEB:f1`, NEB2 =
`NEB:b1` (`floor_id`); SFB defines no floors.

### Map-free (`data/raw/mapfree/train/<scene>/`)

`uv run python -m placematch.datasets.mapfree fetch --n-scenes 160`. Scenes in a seeded
SHA-256 order (`placematch-v2`); per scene 6 references from `seq0` and 6 queries from
`seq1` (the two independent scans), evenly spread and >= 0.5 m or >= 15 deg apart;
`meta.json` keeps poses, intrinsics and the `overlaps.npz` scores between every selected
query and every seq0 frame. The first 50 scenes are validation, the remaining 110 test;
the last 20% of each group (10 / 22 scenes) contribute no references (absent locations).
Some scenes yield fewer than 6 references when spacing cannot be met (3-5 in 7 scenes).

## 3. placematch-v2 (`data/bench/placematch-v2/`)

Build: `uv run python -m placematch.datasets.bench build --version v2` (about 1.5 minutes,
deterministic: two consecutive builds produce byte-identical JSON files). Files:
`manifest.json`, `labels.json` (LabelSet v2 with `boundaries`, `changelog`), `raw_scores.json`,
`summary.json`, `splits.json`, `paired_subset.json`, `robustness_vertex_subset.json`,
`label_changelog.jsonl`, `duplicates.json`, `agent_inspection_applied.json`, `robustness/`,
`build.log`.

### Counts (real queries; from `summary.json`)

| dataset | development | validation (valid / absent place / absent view) | test (valid / absent place / absent view) | references |
| --- | --- | --- | --- | --- |
| 7-Scenes (7 rooms) | 180 | 160 (120 / 40 / 0) | 213 (173 / 40 / 0) | 240 |
| 12-Scenes (12 rooms) | - | 335 (225 / 110 / 0) | 636 (387 / 248 / 1) | 140 |
| CLoc (3 buildings, 2 floors) | 94 | - | 120 (100 / 0 / 20) | 182 |
| Map-free (160 places) | - | 298 (226 / 60 / 12) | 653 (481 / 130 / 42) | 757 |
| **total** | **274** | **793** | **1,622** | **1,319** |

* 2,689 real queries (development 274, validation 793, test 1,622) + 234 robustness
  variants; 1,319 references; 182 locations (145 with references), 219 query recordings.
* Queries without a valid reference: 765 (66 locations, 77 recordings): 668 from places
  with no references at all (7-Scenes office, 12-Scenes apt2-luke / office1-manolis /
  office2, 32 Map-free scenes) and 97 whose place has references but none co-visible.
* `eval_sets=["location_disjoint"]`: 1,449 test queries (Map-free 653, 12-Scenes 636, CLoc
  120, 7-Scenes fire 40) whose location has no validation query; 1,008 with a valid
  reference, 441 without.
* Validation has no CLoc query: both NEB sessions are development, and the only unused SFB
  session is the test recording. Thresholds tuned on validation therefore never saw CLoc.
* CLoc test is one recording session (SFB 083241): clustered intervals for CLoc alone have
  a single cluster and are flagged unreliable.

### Correct-match definition (labels)

Only poses in the same frame are compared; never camera distance, room or building alone.
Raw scores for every (query, reference) pair with a non-zero score are in
`raw_scores.json`, and per label in `QueryLabel.scores` (overlap fraction or CLoc shared
points), so `placematch.evaluation.sensitivity` can recompute labels under other boundaries.

* **7-Scenes, 12-Scenes - depth re-projection overlap** (as v1): query depth sampled on a
  4-px grid, back-projected (7-Scenes fx=fy=585, 12-Scenes fx=fy=572, cx=320, cy=240),
  moved into the reference camera with both camera-to-world poses, kept when it lands inside
  the image on a valid reference depth within max(5 cm, 5%). Positive >= 0.30, ambiguous
  [0.10, 0.30). 12-Scenes depth is aligned to the colour image (identity extrinsics).
* **12-Scenes other rooms of the same site are ambiguous**: rooms are separate
  reconstructions, their co-visibility cannot be computed (a test placing apt1 living
  queries in the kitchen frame found no depth agreement, which cannot distinguish
  "separate frames" from "not co-visible"). Variant `cross_room_negative` in the
  sensitivity module reports the alternative. Rooms of different sites, scenes of
  7-Scenes, CLoc buildings and Map-free scenes are different places.
* **CLoc - SfM co-visibility** (as v1): positive shared >= 50 & covq >= 0.30 & covr >= 0.20;
  ambiguous shared >= 15 & max(cov) >= 0.10. NEB1 and NEB2 are different floors with separate
  models: negative to each other.
* **Map-free - dataset-native `overlaps.npz`** (SfM co-visibility between frames of the two
  scans, computed by the dataset authors): positive >= 0.20 (the `MIN_OVERLAP_SCORE` used by
  the Map-free training code, `config/mapfree.yaml`), ambiguous [0.05, 0.20); pairs absent
  from the file have zero overlap. Assumption: different Map-free scenes are different
  places (the near-duplicate check found no cross-scene duplicates).
* Agent decisions of bench-v1 (21 pairs) are re-applied to the same development pairs; 7
  differ from the automatic v2 label and are recorded in `label_changelog.jsonl` (old/new,
  evidence, "agent ...; not human reviewed"). No label changed because of a model output.
  No label in v2 has been reviewed by a person (`reviewed=False` everywhere).

### Conditions (all measured or derived; `real:*`)

| tag | derivation | queries (all splits) |
| --- | --- | --- |
| `real:viewpoint_change` | rotation >= 30 deg to *every* positive (GT poses) | 262 |
| `real:distance_change` | camera centre >= 1 m from the best positive | 770 |
| `real:partial_view` | best positive overlap < 0.5 (depth) / < 0.4 (Map-free) / query coverage < 0.5 (CLoc) | 272 |
| `real:exposure_change` | mean grey level differs by >= 30 (0..255) from the best positive | 241 |
| `real:low_light` | mean grey level < 50 | 65 |
| `real:motion_blur` | variance of Laplacian < 40 at 640 px long side | 40 |
| `real:repetitive_structure` | 7-Scenes stairs (scene-level) | 74 |
| `real:same_site_distractors` | CLoc / 12-Scenes query whose building or apartment has references of other floors / rooms | 862 |
| `real:absent_location` / `real:absent_view` | place held out / place present but no co-visible reference | 668 / 97 |
| `real:long_term`, `real:different_camera` | CLoc NEB queries 2022 vs database 2021; phone vs rig | 64 / 214 |

The raw values behind the geometric tags are stored per query in
`extra.relative_to_best_positive` (rotation, distance, best score, luma delta). Lighting is
only tagged where measured (`exposure_change`, `low_light`); no dataset documents
day/night sessions for the queries used.

### Robustness study (`eval_sets=["robustness"]`, never in main tables)

42 real source queries (5 with a valid reference + 1 without per (dataset, split), seeded
order) x edits `dark` (x0.35), `bright` (x1.8 + 20), `gaussian_blur` (sigma 3 px at 640),
`jpeg_q15`, `rotate90` (pixels rotated), and `crop` (central 70%, only 7-Scenes /
12-Scenes where the label is recomputed from depth with the crop mask) = 234 variants. Ids
`<source>:synthetic:<edit>`, `derived_from` = source, same split as the source; photometric
and rotation variants inherit the source label.

### Duplicates and leakage (`duplicates.json`)

SHA-256 of every real image (exact) and a 64-bit DCT pHash (Hamming <= 6; no learned model,
so test images are included). Results after the gates381 exclusion: 0 exact duplicates;
recordings in more than one split: none; query recordings that are also reference
recordings: none; near-duplicate pairs: 3 query-reference pairs that are labelled positives
(easy cases, independent recordings), 5 reference-reference pairs and 7 query-query pairs
within the same split and location. The check found the duplicated 12-Scenes scan
described above (32 pairs before the exclusion).

### Subsets for the paired comparison

* `paired_subset.json`: all 2,415 validation + test real queries and all 1,319 references
  fit the 4,500-image budget, so nothing is sampled: **3,734 unique images = 3,734 expected
  Vertex embedding requests** uncached (one per image). By split/dataset: validation
  7-Scenes 160, 12-Scenes 335, Map-free 298; test 7-Scenes 213, 12-Scenes 636, CLoc 120,
  Map-free 653. If the budget shrinks, the builder samples proportionally per (dataset,
  scene, split, reference status) in a seeded order.
* `robustness_vertex_subset.json`: 234 variants + 42 sources (all in the paired subset) =
  276 images; **234 extra Vertex requests** beyond the paired subset; retrieval uses the
  paired subset's references.
* MegaLoc (local) can embed everything including development (3,734 + 274 + 234 images);
  keep its runs separate from the paired Vertex comparison.

### Gallery-size and distractor sweeps

`python -m placematch.evaluation.scaling --bench data/bench/placematch-v2 --run-dir <run>
--split <split> [--thresholds ...] --out <dir>` reads the saved index vectors; definitions
in the module docstring (fixed query set; nested reference subsets: base = the queries'
own locations, then distractors in a seeded order, or by tier same site -> same dataset ->
other datasets).

## 4. Reproduce v2

```bash
cd apps/place-match
uv run python -m placematch.datasets.sevenscenes download --subset v2     # ~6 GB streamed
uv run python -m placematch.datasets.twelvescenes fetch                    # ~0.9 GB
uv run python -m placematch.datasets.cloc metadata --buildings SFB --no-sfm
uv run python -m placematch.datasets.cloc select-v2
uv run python -m placematch.datasets.cloc images --select data/raw/cloc/selection_v2.json
uv run python -m placematch.datasets.mapfree fetch --n-scenes 160          # ~1.1 GB
uv run python -m placematch.datasets.bench build --version v2
# evaluation (runs from the pipeline; see placematch/evaluation/*.py docstrings)
uv run python -m placematch.evaluation.run --bench data/bench/placematch-v2 \
    --runs megaloc=<results.json> vertex=<results.json> --thresholds <thresholds.json> \
    --splits validation test --subset data/bench/placematch-v2/paired_subset.json \
    --sets main location_disjoint --out <dir>
uv run python -m placematch.evaluation.run --bench data/bench/placematch-v2 --runs ... \
    --subset data/bench/placematch-v2/robustness_vertex_subset.json --sets robustness --out <dir>
uv run python -m placematch.evaluation.sensitivity --bench data/bench/placematch-v2 --runs ... --out <dir>
uv run python -m placematch.evaluation.label_audit --bench data/bench/placematch-v2 --runs ... --out <dir>
uv run python -m placematch.evaluation.gallery --bench data/bench/placematch-v2 --run M=<results.json> --split test --out <dir>
```

Targets vs achieved: dataset families 4 (target >= 3); real queries 2,689 (target
2,000-5,000; 2,415 outside development); distinct locations 182 (>= 20); 219 independent
query recordings; 765 no-valid-reference queries from 66 locations (several hundred).
Shortfalls: no CLoc validation data (all NEB sessions are development); CLoc test is a
single session; 7-Scenes heads has no new recording; Map-free scenes are mostly outdoor,
while the indoor share comes from 7-Scenes, 12-Scenes and CLoc.

---

## 5. bench-v1 (frozen baseline; unchanged record of the v1 phase)

### Datasets inspected

| Dataset | Source | Size | Licence / terms | Result |
| --- | --- | --- | --- | --- |
| Microsoft 7-Scenes | https://www.microsoft.com/en-us/research/project/rgb-d-dataset-7-scenes/ (zips at `https://download.microsoft.com/download/2/8/5/28564B23-0828-408F-8631-23B1EFF1DAC8/<scene>.zip`) | heads 0.96 GB, stairs 1.50, fire 2.30, pumpkin 2.89, chess 3.08, office 4.71, redkitchen 6.14 GB | Microsoft Research License Agreement, **non-commercial use only** ([RTF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/7-scenes-msr-la-dataset-7-scenes.rtf)). The licence states that downloading or using the data means accepting it; there is no click-through or form. | Used (priority 1, as instructed). 14 sequences streamed, 6.18 GB transferred. |
| CLoc | https://github.com/kimjh069/CLoc, data on the authors' public Google Drive folder https://drive.google.com/drive/folders/12e2J_Eg7lICdEyDwDxKJHEDBoy5ytwAS | NEB1.zip 2.63 GB, NEB2.zip 3.86 GB, SFB.zip 8.01 GB | CC BY-NC 4.0 (repo LICENSE); cite Kim et al., IEEE Sensors J. 2023 | Used. Only metadata plus 214 selected images fetched with HTTP range requests (~0.47 GB transferred). |
| Niantic Map-free | https://github.com/nianticlabs/map-free-reloc, https://nianticspatial.com/research/map-free/dataset | sample 0.5 GB, val 8 GB, train 110 GB, test 15 GB (no test poses) | Non-commercial licence shown on the download page: "By downloading this dataset you agree to the dataset license terms displayed above." | **Skipped**: needs explicit acceptance of licence terms on the user's behalf. To use it, a person must read and accept the terms on that page; then the 0.5 GB `sample.zip` (one train/val/test scene) is the place to start, using train/val scenes only. |
| InLoc | https://github.com/HajimeTaira/InLoc_dataset | database cutouts/scans tens of GB (tar.gz, no random access) | MIT-style licence in the repo; asks users to "confirm and agree the LICENSE statements" | **Skipped**: the archive host `http://www.ok.sc.e.titech.ac.jp/INLOC/materials/` returned HTTP 403 for `iphone7.tar.gz` and `cutouts.tar.gz` (2026-10-17), the query download contains images only (query poses are evaluated through the visuallocalization.net server), so no usable ground truth. |

Helper consulted: https://github.com/gmberton/VPR-datasets-downloader (none of the four
datasets above is covered by it, so it was not used).

### Exact subsets on disk

#### 7-Scenes (`data/raw/7scenes/<scene>/seq-XX/`)

Each scene zip contains deflated `seq-XX.zip` archives. `placematch.datasets.remote_zip`
streams each selected sequence member once with a single HTTP range request, parses the
inner zip from its local headers, checks CRCs and keeps every 5th frame
(`frame-XXXXXX.{color.png,depth.png,pose.txt}`, index % 5 == 0). The original
`TrainSplit.txt`/`TestSplit.txt` are saved next to the sequences; `download_log.json` and
`seq-XX/.complete.json` record bytes and frame counts.

| Scene | Train (reference) sequences | Test (query) sequences | Role in benchmark |
| --- | --- | --- | --- |
| chess | seq-01 | seq-03 (validation), seq-05 (test) | references + queries |
| fire | seq-01 | seq-03 (validation), seq-04 (test) | references + queries |
| heads | seq-02 | seq-01 (test only: heads has one test sequence) | references + queries |
| stairs | seq-02, seq-03 (500 frames each) | seq-01 (validation), seq-04 (test) | references + queries |
| office | none downloaded | seq-02 (validation), seq-06 (test) | **held out**: queries only, no references |

Every sequence was checked against the original split files (the downloader refuses a
train sequence that is not in `TrainSplit.txt`, and the same for test).

#### CLoc (`data/raw/cloc/<building>/`)

`python -m placematch.datasets.cloc metadata` fetches, per building, `Query/intrinsic/*`,
all `Query/ground_truth/**/query_images_gt.pickle` (merged into `gt_poses.json`) and, for
NEB1/NEB2, `Database/sfm_model/{cameras,images,points3D}.bin`; `listing.json` keeps the
archive listing. `select` writes `data/raw/cloc/selection.json`; `images` fetches it.

* References (NEB1: 45, NEB2: 46): database images with >= 150 registered SfM points
  (about half of the 4-camera rig images have almost none, which would make the
  co-visibility labels meaningless); rig positions ordered by farthest-point sampling over
  camera centres, all qualifying cameras at each position, until >= 45 images.
* Queries: 2 evenly spaced frames from every query chunk (chunks of <= 50 consecutive
  frames as distributed). NEB1/NEB2: chunks alternate validation/test in sorted order
  (one recording session per building, so validation and test share the session but not
  frames or chunks). SFB (held out): session `query-20210526-151031-10` -> validation,
  `query-20210607-083715-10` -> test.
* A first selection pass (15 positions x 4 cameras, before the point-count filter) also
  downloaded ~50 database images that are not used; they stay on disk, unreferenced.

Pose conventions (verified numerically: with the COLMAP reading all NEB1/NEB2 ground-truth query
camera centres lie on the floor plane z = 0.1-0.7 m inside the database trajectory,
the other two readings scatter over tens of metres): database `images.bin` and the query
pickles are both COLMAP **world-to-camera** (`qvec` w,x,y,z and `tvec`, metres), frame
`cloc:<building>:sfm`. Query intrinsics `intrinsic.txt` + OpenCV distortion
`k1,k2,p1,p2,k3`, images 1024x576. Database cameras: SIMPLE_RADIAL f=512, 1024x1024, k=0.

### Benchmark `data/bench/placematch-v1/`

Build: `uv run python -m placematch.datasets.bench build` (about 1 minute) writes
`manifest.json`, `labels.json`, `overlaps.json` (the co-visibility scores behind every
label), `summary.json`, `agent_inspection_applied.json` and `synthetic/`.

Counts (from `summary.json`):

| | references | validation queries | test queries |
| --- | --- | --- | --- |
| 7-Scenes chess | 40 | 20 | 20 |
| 7-Scenes fire | 40 | 20 | 20 |
| 7-Scenes heads | 40 | 0 | 20 |
| 7-Scenes stairs | 40 | 20 | 20 |
| 7-Scenes office (held out) | 0 | 20 | 20 |
| CLoc NEB1 | 45 | 18 | 18 |
| CLoc NEB2 | 46 | 14 | 14 |
| CLoc SFB (held out) | 0 | 14 | 16 |
| **real total** | **251** | **126** | **148** |
| synthetic (test only) | | | 45 |

Real queries: 191 with a valid reference, 70 without (40 office + 30 SFB held out),
13 "ambiguous only" (CLoc queries whose best references are all in the ambiguous band;
they count neither towards Recall nor as false acceptances unless a non-ambiguous
reference is accepted). Validation: 87 / 34 / 5; test: 104 / 36 / 8.
Unique images to embed: 251 + 274 + 45 = 570 (one Gemini request each, uncached).

Manifest conventions: `image_id` = `7scenes:<scene>:seq-XX/frame-XXXXXX` or
`cloc:<building>:<relative path>`; `location_id` = `7scenes:<scene>` / `cloc:<building>`
(a room or a building floor; different scenes never share one); `sequence_id` = the
recording (7-Scenes sequence, CLoc chunk or `database`); `timestamp_s` is always None
(7-Scenes has no per-frame times; CLoc frame numbers have no clock); 7-Scenes
`intrinsics` is None because the RGB camera is uncalibrated, the default depth
intrinsics are in `extra.depth_intrinsics`; `depth_path` for 7-Scenes.

#### Correct-match definition and thresholds

Only poses in the same scene frame are compared. References from another scene or
building are a different place (assumption: separate captures in separate world frames).

* **7-Scenes (depth re-projection overlap).** Query depth (16-bit mm; 0 and 65535
  invalid) sampled on a 4-px grid is back-projected with fx=fy=585, cx=320, cy=240,
  moved to the reference camera with both camera-to-world poses and projected. A pixel
  is co-visible when it lands inside the reference image on a valid reference depth with
  |d_ref - z| <= max(5 cm, 5% z) (visibility + occlusion test). Overlap = co-visible /
  valid query pixels. **Positive >= 0.30; ambiguous 0.10-0.30; otherwise negative.**
  Limitation: RGB and depth are not registered/calibrated, so the RGB content is offset
  by a few pixels from the geometry the label uses; poses are KinectFusion estimates.
  Observation: 7-Scenes rooms are small, so every 7-Scenes query with references has
  2-38 positives; it mostly tests telling rooms apart and rejecting the held-out office.
* **CLoc (sparse SfM co-visibility; lower confidence).** No depth exists. A model point is
  predicted visible from the query when it projects inside the image (with distortion,
  ground-truth pose), lies within 45 degrees of the viewing direction of a database camera
  that observed it, and survives a coarse z-buffer (8-px cells, 30% + 0.2 m). For each
  reference, `shared` = its observed points that are visible in the query;
  `covq`/`covr` = fraction of 128-px grid cells of the query / reference containing them.
  **Positive: shared >= 50 and covq >= 0.30 and covr >= 0.20. Ambiguous: shared >= 15 and
  max(covq, covr) >= 0.10.** Known weakness: textureless walls hold no points, so they
  cannot hide what is behind them; the agent inspection below found the boundary cases
  noisy (see list).
* **Held-out scenes** (7-Scenes office, CLoc SFB): `has_valid_reference=False`,
  method `held_out_scene(...)`, present in both validation and test.

#### Conditions (how each tag was derived)

* `real:motion_blur` — 7-Scenes queries with variance of the Laplacian < 40 (grey, full
  resolution; about the 8th percentile of the downloaded test frames). Measured, not
  annotated; can also fire on low-texture views. 7 validation + 6 test queries.
* `real:long_term` — CLoc NEB queries (sessions dated 2022-08-10) against database images
  captured 2021-12-14 (NEB1) / 2021-03-19 (NEB2), dates from the file names.
* `real:different_camera` — CLoc smartphone queries vs the 4-camera rig database.
* No lighting tag: the mean luma of every downloaded 7-Scenes test frame is >= 96, so
  the data does not support a `real:low_light` tag.
* `synthetic:dark` (pixels x0.25), `synthetic:motion_blur` (21-px horizontal box kernel),
  `synthetic:crop` (central 70% x 70%, not resized; label recomputed with the overlap
  restricted to the cropped pixels) — 15 real 7-Scenes test queries (3 per scene incl. 3
  held-out office queries) x 3 edits = 45 entries, split `test`, ids
  `<source id>:synthetic:<edit>`, `extra.derived_from`. Dark/blur copies inherit the
  source label. They never replace real queries and the evaluation reports them apart.

#### Agent-inspected subset (agent inspection only, no human review)

Pairs viewed side by side by the agent; decisions are stored in
`placematch/datasets/agent_inspection_v1.json` and applied at build time
(`agent_inspected=True`, `reviewed=False`, method suffix `+agent_override` where the
decision differs from the automatic label). Selection: CLoc "ambiguous only" queries
(top ambiguous reference), the 4 weakest CLoc positives, one 7-Scenes pair per scene
closest to the 0.30 threshold, 6 random CLoc positives, and 2 cross-scene distractor
checks.

| query | reference | auto | agent | note |
| --- | --- | --- | --- | --- |
| `cloc:NEB1:query-20220810-014736/008/frame000357.jpg` | `cloc:NEB1:db/f1/1639460951.255076671_3.png` | ambiguous | ambiguous | atrium with column and glass railing; ref shows a similar hall from far away, common content not certain |
| `cloc:NEB1:query-20220810-014736/019/frame000797.jpg` | `cloc:NEB1:db/f1/1639460754.252723901_3.png` | ambiguous | positive | same display wall (TV and red/yellow shield panels) clearly visible in both |
| `cloc:NEB1:query-20220810-014736/027/frame001092.jpg` | `cloc:NEB1:db/f1/1639461167.264225170_3.png` | ambiguous | ambiguous | glass staircase railing appears only small and distant in the ref |
| `cloc:NEB1:query-20220810-014736/012/frame000517.jpg` | `cloc:NEB1:db/f1/1639461044.587695914_2.png` | ambiguous | ambiguous | grey wall with sign stand visible only at the ref's left edge |
| `cloc:NEB1:query-20220810-014736/015/frame000612.jpg` | `cloc:NEB1:db/f1/1639461193.958117645_2.png` | ambiguous | negative | query faces elevator doors; ref is a narrow white corridor; no visible common content |
| `cloc:NEB1:query-20220810-014736/011/frame000477.jpg` | `cloc:NEB1:db/f1/1639461060.593555566_3.png` | positive | ambiguous | same lobby possibly, but views face different walls; only the counter may be shared |
| `cloc:NEB1:query-20220810-014736/007/frame000316.jpg` | `cloc:NEB1:db/f1/1639460754.252723901_2.png` | positive | ambiguous | query corridor ends in a column hall that may be the ref's hall; no clear shared detail |
| `cloc:NEB2:query-20220810-015149/015/frame000612.jpg` | `cloc:NEB2:db/b1/1616152384.659657332_3.png` | positive | negative | query shows dark tiered stairs; ref is a bright corridor; no visible common content |
| `cloc:NEB2:query-20220810-015149/034/frame001372.jpg` | `cloc:NEB2:db/b1/1616152544.642125895_2.png` | positive | positive | same tiered steps on the left and red/blue panels in the background |
| `7scenes:chess:seq-03/frame-000310` | `7scenes:chess:seq-01/frame-000325` | positive | positive | same chess table, chairs and shelf; overlap 0.300 at the threshold |
| `7scenes:fire:seq-03/frame-000110` | `7scenes:fire:seq-01/frame-000100` | ambiguous | positive | same fire-extinguisher stand and plant; depth overlap 0.2998 just below threshold |
| `7scenes:stairs:seq-04/frame-000160` | `7scenes:stairs:seq-02/frame-000100` | ambiguous | ambiguous | repetitive stair flight; looks identical but visual identity cannot be confirmed |
| `7scenes:heads:seq-01/frame-000510` | `7scenes:heads:seq-02/frame-000500` | positive | positive | same desk with keyboard and monitors from a different angle |
| `cloc:NEB1:query-20220810-014736/009/frame000372.jpg` | `cloc:NEB1:db/f1/1639460812.955351940_2.png` | positive | positive | same large hall with columns and windows, reception at the far end |
| `cloc:NEB2:query-20220810-015149/014/frame000597.jpg` | `cloc:NEB2:db/b1/1616152757.976579560_2.png` | positive | positive | same hall with the row of black balls and glass window strip |
| `cloc:NEB1:query-20220810-014736/009/frame000372.jpg` | `cloc:NEB1:db/f1/1639460754.252723901_2.png` | positive | positive | same displayed car and hall |
| `cloc:NEB1:query-20220810-014736/004/frame000203.jpg` | `cloc:NEB1:db/f1/1639460711.592884839_2.png` | positive | positive | same column, door and car seen through the window |
| `cloc:NEB1:query-20220810-014736/027/frame001117.jpg` | `cloc:NEB1:db/f1/1639461137.921372300_3.png` | positive | positive | same elevator lobby (red/green elevator frame), ref from further back |
| `cloc:NEB1:query-20220810-014736/024/frame000978.jpg` | `cloc:NEB1:db/f1/1639461167.264225170_2.png` | positive | ambiguous | similar white corridors with yellow tactile tiles; same corridor not confirmable |
| `7scenes:office:seq-06/frame-000510` | `7scenes:heads:seq-02/frame-000500` | negative | negative | hard distractor: both are similar office desks; dataset treats office and heads as separate scenes, physical separation not verifiable from the data |
| `7scenes:office:seq-02/frame-000210` | `7scenes:chess:seq-01/frame-000200` | negative | negative | different rooms (bookshelf office vs chess table room) |

Findings: 7 of 21 automatic labels were changed. Random CLoc positives looked right
(5 of 6; the sixth is a pair of look-alike corridors); boundary CLoc positives were often
wrong or unclear (3 of 4 downgraded), so CLoc numbers carry more label noise than
7-Scenes. The office/heads distractor pair shows two very similar office desks; the
dataset treats them as separate scenes and the data cannot prove they are physically
different rooms.

### Reproduce

```bash
cd apps/place-match
uv run python -m placematch.datasets.sevenscenes download          # ~6.2 GB streamed, keeps 1/5 frames
uv run python -m placematch.datasets.cloc metadata                  # SfM models, GT, intrinsics
uv run python -m placematch.datasets.cloc select                    # data/raw/cloc/selection.json
uv run python -m placematch.datasets.cloc images                    # selected images only
uv run python -m placematch.datasets.bench build                    # data/bench/placematch-v1
uv run python -m placematch.datasets.bench composite --out pair.jpg <query_id> <ref_id> ...
```

Evaluation (RunResult files from `placematch.retrieval.run_retrieval`, `verify.verify_run`,
`decide.apply_decisions`):

```bash
uv run python -m placematch.evaluation.run --bench data/bench/placematch-v1 \
    --runs gemini=<gemini results.json> megaloc=<megaloc results.json> \
           gemini+verify=<verified gemini results.json> \
    [--thresholds <thresholds.json>] [--splits test validation] [--out <dir>]
```

With `--thresholds`, decisions are recomputed (methods named `*+verify` use verification);
the verification effect (correct matches rescued, correct matches rejected/downgraded,
wrong matches removed/added) is reported for each `X` / `X+verify` pair. Outputs:
`metrics.json` (EvalReport), `metrics.csv`, `report.md`.

Metric definitions: see `placematch/evaluation/metrics.py` (also printed at the end of
every `report.md`).

### Pipeline smoke test on this benchmark (MegaLoc, local, no API requests)

To check that the benchmark, the pipeline's `RunResult` files and the evaluation fit
together, the pipeline's own code was run once on `placematch-v1`:
`run_retrieval(..., get_backend("megaloc"), top_k=5)` -> `decide.calibrate(...,
split="validation")` -> `python -m placematch.evaluation.run --thresholds ...`.
Outputs: `data/bench/placematch-v1/runs/megaloc/{results,thresholds}.json` and
`data/bench/placematch-v1/eval_megaloc_smoke/`. Embedding 570 images took 200 s.
A Gemini dry run (sends nothing) reports 566 uncached requests for the full benchmark.

| split (real queries) | n | R@1 | R@5 | FAR | accepted precision | accepted recall |
| --- | --- | --- | --- | --- | --- | --- |
| test | 148 | 0.923 | 0.962 | 0.023 | 0.987 | 0.721 |
| validation (thresholds fitted here) | 126 | 0.966 | 0.977 | 0.026 | 0.981 | 0.609 |

Test by dataset: 7-Scenes R@1 1.000 (one of 20 held-out office queries accepted, FAR
0.05); CLoc R@1 0.667, R@5 0.833, no false acceptances. Synthetic edits: R@1 1.000 for
all three. 7-Scenes alone is close to saturated for retrieval; CLoc and the held-out
scenes carry most of the signal. Geometric verification and Gemini were not run here.
