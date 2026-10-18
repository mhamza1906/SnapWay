"""placematch-v2 dataset helpers (offline) and consistency checks on the built benchmark
(skipped when data/bench/placematch-v2 is not present)."""

from __future__ import annotations

import json

import numpy as np
import pytest

from placematch.datasets import bench_v2, cloc, mapfree, twelvescenes
from placematch.datasets.imagestats import hamming, near_duplicate_pairs, phash_grey
from placematch.schemas import LabelSet, Manifest

BENCH = bench_v2.BENCH_DIR / bench_v2.NAME
V1 = bench_v2.V1_DIR


# ------------------------------------------------------------------------- helpers


def test_phash_and_near_duplicates():
    rng = np.random.default_rng(0)
    a = (rng.random((120, 160)) * 255).astype(np.uint8)
    b = np.clip(a.astype(int) + 3, 0, 255).astype(np.uint8)  # tiny brightness change
    c = (rng.random((120, 160)) * 255).astype(np.uint8)
    ha, hb, hc = phash_grey(a), phash_grey(b), phash_grey(c)
    assert hamming(ha, hb) <= 2 and hamming(ha, hc) > 10
    pairs = near_duplicate_pairs({"a": ha, "b": hb, "c": hc})
    assert [(x, y) for x, y, _ in pairs] == [("a", "b")]


def test_mapfree_parsers_and_spacing():
    text = (
        "seq0/frame_00000.jpg 1 0 0 0 0 0 0\n"
        "seq0/frame_00010.jpg 1 0 0 0 0 0 0.1\n"
        "seq0/frame_00020.jpg 1 0 0 0 -2 0 0\n"
        "seq1/frame_00000.jpg 0 0 0 0 0 0 0\n"  # invalid (zero quaternion: withheld pose)
    )
    poses = mapfree.parse_poses(text)
    assert set(poses) == {"seq0/frame_00000.jpg", "seq0/frame_00010.jpg", "seq0/frame_00020.jpg"}
    assert np.allclose(mapfree.camera_centre(poses["seq0/frame_00020.jpg"]), [2, 0, 0])
    sel = mapfree.spaced_selection(list(poses), poses, 3, min_trans=0.5, min_rot=15)
    assert "seq0/frame_00020.jpg" in sel and len(sel) == 2  # 0 and 10 are 0.1 m apart
    intr = mapfree.parse_intrinsics("seq0/frame_00000.jpg 500 500 270 360 540 720\n")
    assert intr["seq0/frame_00000.jpg"][-1] == 720
    order = mapfree.scene_order(["s1", "s2", "s3"])
    assert sorted(order) == ["s1", "s2", "s3"] and order == mapfree.scene_order(["s3", "s1", "s2"])


def test_twelvescenes_parsers():
    split = (
        "sequence0 [frames=357]  [start=0 ; end=356]\nsequence1 [frames=3] [start=357 ; end=359]"
    )
    assert twelvescenes.parse_split(split) == {0: (0, 356), 1: (357, 359)}
    assert twelvescenes.parse_pose("1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1") is not None
    assert twelvescenes.parse_pose("-inf -inf -inf -inf\n" * 4) is None
    assert twelvescenes.parse_pose("2 0 0 0\n0 2 0 0\n0 0 2 0\n0 0 0 1") is None
    poses = {i: np.eye(4) for i in range(0, 50, 5)}
    for i in poses:
        poses[i] = poses[i].copy()
        poses[i][0, 3] = i * 0.1  # 0.5 m per step
    assert len(twelvescenes.spaced(poses, 4, (0.4, 90))) == 4
    assert len(twelvescenes.spaced(poses, 4, (10.0, 90))) == 1


def test_cloc_spaced_queries():
    members = [f"SFB/Query/query_sequences/sess/0000/frames{i:05d}.jpg" for i in range(0, 100, 10)]
    gt = {}
    for i, m in enumerate(members):
        rel = m.split("/query_sequences/")[1]
        gt[rel] = (np.array([0.0, 0.0, -0.4 * i]), np.array([1.0, 0, 0, 0]))  # 0.4 m steps
    out = cloc.spaced_queries(members, gt, stride=1, spacing=(1.0, 20.0), k=100)
    assert len(out) == 4  # every third frame is >= 1 m from the previous kept one
    assert len(cloc.spaced_queries(members, gt, stride=1, spacing=(1.0, 20.0), k=2)) == 2


def test_robustness_edits_shapes():
    img = np.full((48, 64, 3), 100, np.uint8)
    for edit in bench_v2.ROBUST_EDITS:
        out, mask, params = bench_v2._edit(img, edit)
        assert params
        if edit == "rotate90":
            assert out.shape[:2] == (64, 48)
        elif edit == "crop":
            assert out.shape[:2] == (34, 45) and mask.sum() == 34 * 45
        else:
            assert out.shape == img.shape and mask is None
    dark, _, _ = bench_v2._edit(img, "dark")
    assert dark.mean() < img.mean()


def test_cloc_db_name_fields():
    assert bench_v2._cloc_db_name_fields("f1/1639460951.255076671_3.png")["rig_camera"] == 3
    f = bench_v2._cloc_db_name_fields("img/cubemap_0020_rdy(30)_rdz(60)_surface1.png")
    assert f == {"panorama": "cubemap_0020_rdy(30)_rdz(60)", "cubemap_face": 1}


# ------------------------------------------------------------------------- built benchmark

built = pytest.mark.skipif(
    not (BENCH / "labels.json").is_file(), reason="placematch-v2 not built (data/ is local)"
)


@pytest.fixture(scope="module")
def v2():
    m = Manifest.model_validate_json((BENCH / "manifest.json").read_text())
    lab = LabelSet.model_validate_json((BENCH / "labels.json").read_text())
    return m, lab


@built
def test_v2_files_ids_and_labels(v2):
    m, lab = v2
    for fn in (
        "summary.json",
        "splits.json",
        "paired_subset.json",
        "robustness_vertex_subset.json",
        "label_changelog.jsonl",
        "duplicates.json",
        "raw_scores.json",
    ):
        assert (BENCH / fn).is_file(), fn
    ids = [e.image_id for e in m.entries]
    assert len(ids) == len(set(ids))
    by = {e.image_id: e for e in m.entries}
    assert {lb.query_id for lb in lab.labels} == {e.image_id for e in m.queries()}
    for lb in lab.labels:
        assert not lb.reviewed  # nothing was reviewed by a person
        assert lb.has_valid_reference == bool(lb.positives)
        assert not set(lb.positives) & set(lb.ambiguous)
        assert lb.label_version == "v2" and lb.group_id
        q = by[lb.query_id]
        assert lb.split == q.split and q.content_sha256
        for r in lb.positives:
            assert by[r].role == "reference" and by[r].pose.frame == q.pose.frame


@built
def test_v2_split_rules(v2):
    m, lab = v2
    real = [e for e in m.queries() if not e.derived_from]
    rec_split: dict[str, set] = {}
    for e in real:
        rec_split.setdefault(e.group_id, set()).add(e.split)
    assert all(len(s) == 1 for s in rec_split.values()), "a recording is in two splits"
    v1 = Manifest.model_validate_json((V1 / "manifest.json").read_text())
    v1_rec = {e.group_id or e.image_id.split("/", 1)[0] for e in v1.queries()}
    v1_rec |= {
        f"cloc:{e.scene_id}:{e.extra['session']}" for e in v1.queries() if "session" in e.extra
    }
    for e in real:
        if e.split in ("validation", "test"):
            assert e.group_id not in v1_rec, f"bench-v1 recording reused: {e.group_id}"
    v1_ids = {e.image_id for e in v1.queries() if not e.extra.get("derived_from")}
    v2_ids = {e.image_id: e for e in real}
    for i in v1_ids & set(v2_ids):
        assert v2_ids[i].split == "development"
    ref_seqs = {e.sequence_id for e in m.references()}
    assert not {e.sequence_id for e in real} & ref_seqs
    val_locs = {e.location_id for e in real if e.split == "validation"}
    labs = {lb.query_id: lb for lb in lab.labels}
    for e in real:
        if "location_disjoint" in labs[e.image_id].eval_sets:
            assert e.split == "test" and e.location_id not in val_locs


@built
def test_v2_robustness_and_subsets(v2):
    m, lab = v2
    by = {e.image_id: e for e in m.entries}
    for lb in lab.labels:
        if "robustness" in lb.eval_sets:
            src = by[lb.derived_from]
            assert lb.split == src.split and lb.conditions[0].startswith("synthetic:")
            assert by[lb.query_id].derived_from == src.image_id
    paired = json.loads((BENCH / "paired_subset.json").read_text())
    assert paired["unique_images"] <= bench_v2.PAIRED_MAX_IMAGES
    assert set(paired["reference_ids"]) <= {e.image_id for e in m.references()}
    for q in paired["query_ids"]:
        assert by[q].split in ("validation", "test") and not by[q].derived_from
    rob = json.loads((BENCH / "robustness_vertex_subset.json").read_text())
    assert rob["unique_images_including_sources"] <= bench_v2.ROBUSTNESS_MAX_IMAGES
    for line in (BENCH / "label_changelog.jsonl").read_text().splitlines():
        rec = json.loads(line)
        assert "not human reviewed" in rec["inspected_by"]
        assert rec["old"] != rec["new"] and rec["evidence"]
