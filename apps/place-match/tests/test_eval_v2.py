"""Offline tests for the v2 evaluation additions (counts, CIs, sets, sensitivity, scaling,
gallery) with hand-made fixtures."""

from __future__ import annotations

import csv
import json

import numpy as np
import pytest
from PIL import Image

from placematch.backends.base import EmbeddingIndex
from placematch.evaluation import gallery, report, scaling, sensitivity
from placematch.evaluation.metrics import cluster_bootstrap, compute, evaluate
from placematch.evaluation.run import evaluate_runs, load_subset, select_labels
from placematch.schemas import (
    Candidate,
    Decision,
    LabelSet,
    Manifest,
    ManifestEntry,
    QueryLabel,
    QueryResult,
    RunResult,
    RunStats,
)


def _q(qid, ranked, outcome=None, ref=None, timings=None):
    cands = [
        Candidate(rank=i + 1, reference_id=r, location_id=r.split("/")[0], cosine=0.9 - 0.1 * i)
        for i, r in enumerate(ranked)
    ]
    dec = None if outcome is None else Decision(outcome=outcome, reference_id=ref)
    return QueryResult(
        query_id=qid, path=f"{qid}.png", candidates=cands, decision=dec, timings_s=timings or {}
    )


def _run(queries, run_id="r"):
    return RunResult(
        run_id=run_id,
        created_utc="2026-10-17T00:00:00Z",
        backend="megaloc:test",
        backend_config={},
        manifest="manifest.json",
        queries=queries,
        stats=RunStats(
            n_references=4,
            n_queries=len(queries),
            expected_uncached_requests=0,
            api_requests=0,
            cache_hits=0,
            cache_misses=0,
            timings_s={"embed": 2.0},
            peak_rss_mb=512.0,
        ),
    )


def _lab(qid, valid, pos=(), amb=(), method="t", split="test", group=None, sets=(), **kw):
    return QueryLabel(
        query_id=qid,
        has_valid_reference=valid,
        positives=list(pos),
        ambiguous=list(amb),
        method=method,
        split=split,
        group_id=group,
        eval_sets=list(sets),
        **kw,
    )


def _labels():
    L = [
        _lab("d:a:s1/q1", True, ["a/1"], group="g1"),  # correct accept
        _lab("d:a:s1/q2", True, ["a/2"], group="g1"),  # wrong accept (wrong place)
        _lab("d:a:s2/q3", True, ["a/1"], group="g2"),  # rejected valid
        _lab("d:b:s3/q4", False, method="held_out_scene(d)", group="g3"),  # false accept
        _lab("d:b:s3/q5", False, method="held_out_scene(d)", group="g3"),  # correct rejection
        _lab("d:a:s4/q6", False, amb=["a/9"], group="g4", sets=["location_disjoint"]),
        _lab("d:a:s4/q7", True, ["a/1"], group="g4", sets=["location_disjoint"]),  # uncertain
        _lab(
            "d:a:s1/q1:synthetic:dark",
            True,
            ["a/1"],
            group="g1",
            sets=["robustness"],
            conditions=["synthetic:dark"],
            derived_from="d:a:s1/q1",
        ),
    ]
    return LabelSet(manifest="manifest.json", definition="t", labels=L)


def _queries():
    t = {"total": 0.5, "embed": 0.3}
    return [
        _q("d:a:s1/q1", ["a/1", "a/2"], "likely_match", "a/1", t),
        _q("d:a:s1/q2", ["b/1", "a/2"], "likely_match", "b/1", {"total": 1.5}),
        _q("d:a:s2/q3", ["a/1"], "no_supported_match"),
        _q("d:b:s3/q4", ["a/1"], "likely_match", "a/1"),
        _q("d:b:s3/q5", ["a/1"], "no_supported_match"),
        _q("d:a:s4/q6", ["a/9"], "likely_match", "a/9"),  # ambiguous accept
        _q("d:a:s4/q7", ["a/1"], "uncertain"),
        _q("d:a:s1/q1:synthetic:dark", ["a/1"], "likely_match", "a/1"),
    ]


def test_decision_counts_and_rates():
    m = evaluate(_run(_queries()), _labels(), "test", "megaloc", n_boot=200)
    c = m.counts
    assert c["correct_accepts"] == 1
    assert c["wrong_accepts_with_reference"] == 1 and c["false_accepts_no_reference"] == 1
    assert c["wrong_accepts"] == 2
    assert c["ambiguous_accepts"] == 1  # never a correct rejection
    assert c["rejected_valid"] == 1 and c["uncertain"] == 1 and c["correct_rejections"] == 1
    dm = m.extra["decision_metrics"]
    assert dm["acceptance_coverage"] == pytest.approx(4 / 7)
    assert dm["precision_strict"] == pytest.approx(1 / 4)
    assert m.accepted_precision == pytest.approx(1 / 3)
    # FAR excludes the ambiguous accept; strict FAR counts it
    assert m.false_acceptance_rate == pytest.approx(1 / 2)
    assert dm["far_strict"] == pytest.approx(2 / 3)
    assert dm["far_absent_location"] == pytest.approx(1 / 2)
    assert dm["n_absent_location"] == 2 and dm["n_absent_view"] == 1
    assert m.extra["by_eval_set"]["location_disjoint"]["n_queries"] == 2
    ops = m.extra["operations"]
    assert ops["per_query_timings"]["total"]["n"] == 2
    assert ops["per_query_timings"]["total"]["median_s"] == pytest.approx(1.0)
    assert ops["throughput_images_per_s"] == pytest.approx(12 / 2.0)  # (4 refs + 8 q) / 2 s


def test_cluster_bootstrap_groups_and_warning():
    lab = {lb.query_id: lb for lb in _labels().labels}
    pairs = [(q, lab[q.query_id]) for q in _queries()[:7]]
    ci = cluster_bootstrap(pairs, n_boot=300, seed=1)
    r1 = ci["recall_at_1"]
    assert r1["n_groups"] == 3  # g1, g2, g4 hold valid queries
    assert "warning" in r1 and 0.0 <= r1["low"] <= r1["point"] <= r1["high"] <= 1.0
    assert cluster_bootstrap(pairs, n_boot=300, seed=1) == ci  # deterministic
    by_scene = cluster_bootstrap(pairs, by="scene", n_boot=50)
    assert by_scene["recall_at_1"]["n_groups"] == 1


def test_bootstrap_fallback_recording_from_id():
    lab = _lab("7scenes:chess:seq-03/frame-000010", True, ["r"])
    q = _q(lab.query_id, ["r"], "likely_match", "r")
    ci = cluster_bootstrap([(q, lab)], n_boot=10)
    assert ci["recall_at_1"]["by"].startswith("group_id(recording")


def test_select_labels_and_subset(tmp_path):
    labels = _labels()
    assert len(select_labels(labels, "main").labels) == 7
    assert {lb.query_id for lb in select_labels(labels, "location_disjoint").labels} == {
        "d:a:s4/q6",
        "d:a:s4/q7",
    }
    rob = select_labels(labels, "robustness").labels
    assert {lb.query_id for lb in rob} == {"d:a:s1/q1:synthetic:dark", "d:a:s1/q1"}
    p = tmp_path / "s.json"
    p.write_text(json.dumps({"query_ids": ["d:a:s1/q1"], "reference_ids": ["a/1"]}))
    assert load_subset(p) == {"d:a:s1/q1"}
    assert len(select_labels(labels, "main", load_subset(p)).labels) == 1
    with pytest.raises(ValueError):
        select_labels(labels, "nope")


def test_report_with_sets(tmp_path):
    rep = evaluate_runs(
        {"megaloc": _run(_queries())},
        _labels(),
        splits=["test"],
        manifest_path="m",
        labels_path="l",
        eval_sets=["main", "location_disjoint", "robustness"],
        n_boot=50,
    )
    assert [m.extra["eval_set"] for m in rep.methods] == [
        "main",
        "location_disjoint",
        "robustness",
    ]
    rob = rep.methods[2]
    assert rob.n_queries == 1 and "synthetic:dark" in rob.by_condition
    report.write(rep, tmp_path)
    md = (tmp_path / "report.md").read_text()
    assert "set `location_disjoint`" in md and "decision counts" in md
    rows = list(csv.DictReader((tmp_path / "metrics.csv").open()))
    assert {r["eval_set"] for r in rows} == {"main", "location_disjoint", "robustness"}


# ------------------------------------------------------------------------- sensitivity


def test_relabel_variants():
    depth = _lab("7scenes:x:seq-01/f", True, ["r1"], ["r2"], method="depth")
    raw = {"r1": 0.35, "r2": 0.15, "r3": 0.05}
    d = sensitivity.relabel(depth, raw, sensitivity.DEFAULT)
    assert (d.positives, d.ambiguous) == (["r1"], ["r2"])
    hi = sensitivity.relabel(depth, raw, sensitivity.Boundary("x", depth=(0.4, 0.1)))
    assert not hi.has_valid_reference and hi.ambiguous == ["r1", "r2"]
    nb = [b for b in sensitivity.VARIANTS if b.name == "no_ambiguous_band"][0]
    assert sensitivity.relabel(depth, raw, nb).ambiguous == []
    cl = _lab("cloc:NEB1:s/c/f", False, [], ["c1"], method="sfm")
    craw = {"c1": {"shared": 140, "covq": 0.47, "covr": 0.188}}
    assert not sensitivity.relabel(cl, craw, sensitivity.DEFAULT).has_valid_reference
    covr = [b for b in sensitivity.VARIANTS if b.name == "cloc_covr0.15"][0]
    assert sensitivity.relabel(cl, craw, covr).positives == ["c1"]
    mf = _lab("mapfree:s1:seq1/f", True, ["m1"], method="mf")
    assert sensitivity.relabel(mf, {"m1": {"overlap": 0.25}}, sensitivity.DEFAULT).positives
    # 12-Scenes: unscored same-site refs stay ambiguous unless cross_room_negative
    tw = _lab("12scenes:apt1-kitchen:frame-1", True, ["k1"], ["l1"], method="depth")
    assert sensitivity.relabel(tw, {"k1": 0.5}, sensitivity.DEFAULT).ambiguous == ["l1"]
    crn = [b for b in sensitivity.VARIANTS if b.name == "cross_room_negative"][0]
    assert sensitivity.relabel(tw, {"k1": 0.5}, crn).ambiguous == []
    held = _lab("12scenes:apt2-luke:frame-1", False, [], ["b1"], method="held_out_scene(x)")
    assert sensitivity.relabel(held, {}, sensitivity.DEFAULT).ambiguous == ["b1"]
    assert sensitivity.relabel(held, {}, crn).ambiguous == []


def test_run_sensitivity_reports_all_variants():
    labels = LabelSet(
        manifest="m",
        definition="t",
        labels=[
            _lab("7scenes:x:seq-01/a", True, ["r1"], ["r2"]),
            _lab("7scenes:x:seq-01/b", False, [], ["r2"]),
        ],
    )
    raw = {"7scenes:x:seq-01/a": {"r1": 0.35, "r2": 0.15}, "7scenes:x:seq-01/b": {"r2": 0.25}}
    run = _run(
        [
            _q("7scenes:x:seq-01/a", ["r2", "r1"], "likely_match", "r2"),
            _q("7scenes:x:seq-01/b", ["r2"], "likely_match", "r2"),
        ]
    )
    agent = [{"query_id": "7scenes:x:seq-01/b", "reference_id": "r2", "decision": "positive"}]
    res = sensitivity.run_sensitivity({"m": run}, labels, raw, splits=["test"], agent=agent)
    names = {r["variant"] for r in res.rows}
    assert names == {b.name for b in sensitivity.VARIANTS}
    default = [r for r in res.rows if r["variant"] == sensitivity.DEFAULT.name][0]
    assert default["ambiguous_accepts"] == 2  # stored labels used as they are
    amb_pos = [r for r in res.rows if r["variant"] == "ambiguous_as_positive"][0]
    assert amb_pos["recall_at_1"] == 1.0
    assert sensitivity.ranges(res.rows)[0]["recall_at_1"][0] <= 1.0
    md = sensitivity.markdown(res, "t")
    assert "Ranges over variants" in md


# ------------------------------------------------------------------------- scaling


def _entry(iid, role, loc, ds="d", site=None, split=None):
    return ManifestEntry(
        image_id=iid,
        path=f"{iid}.png",
        role=role,
        dataset=ds,
        scene_id=loc,
        location_id=loc,
        split=split,
        extra={"site": site or loc},
    )


def test_scaling_nested_sweeps(tmp_path):
    rng = np.random.default_rng(0)
    d = 8
    base = np.eye(d, dtype=np.float32)
    refs = ["A/1", "A/2"] + [f"D/{i}" for i in range(6)]
    a1 = base[0] + base[4]  # cosine 0.71 with query qa
    rv = np.stack([a1, base[1]] + [rng.normal(size=d) for _ in range(6)]).astype(np.float32)
    rv[-1] = base[0]  # a distractor that looks more like qa than its true reference
    rv /= np.linalg.norm(rv, axis=1, keepdims=True)
    qv = np.stack([base[0], base[3]]).astype(np.float32)
    run_dir = tmp_path / "run"
    EmbeddingIndex("k", refs, rv).save(run_dir / "index" / "k" / "references")
    EmbeddingIndex("k", ["qa", "qx"], qv).save(run_dir / "index" / "k" / "queries")
    entries = [_entry(r, "reference", r.split("/")[0]) for r in refs]
    entries += [_entry("qa", "query", "A", split="test"), _entry("qx", "query", "X", split="test")]
    manifest = Manifest(name="t", entries=entries)
    labels = LabelSet(
        manifest="m",
        definition="t",
        labels=[
            _lab("qa", True, ["A/1"]),
            _lab("qx", False, method="held_out_scene(d)"),
        ],
    )
    r, q = scaling.load_indexes(run_dir)
    res = scaling.sweeps(manifest, labels, r, q, split="test", steps=3, accept_cosine=0.9)
    gs = res["gallery_size_sweep"]
    assert res["n_base_references"] == 2 and res["n_distractor_pool"] == 6
    assert [s["n_references"] for s in gs] == sorted(s["n_references"] for s in gs)
    assert gs[0]["recall_at_1"] == 1.0 and gs[-1]["recall_at_1"] == 0.0
    assert res["distractor_sweep"][-1]["distractor_tiers"] == {"2_same_dataset": 6}
    assert "Gallery size" in scaling.markdown(res)


# ------------------------------------------------------------------------- gallery


def test_gallery_and_review_sheet(tmp_path):
    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    ids = ["A/1", "A/2", "B/1", "qa", "qb", "qc"]
    for i in ids:
        Image.new("RGB", (64, 48), (len(i) * 30, 80, 120)).save(
            img_dir / f"{i.replace('/', '_')}.png"
        )
    entries = [
        ManifestEntry(
            image_id=i,
            path=f"imgs/{i.replace('/', '_')}.png",
            role="query" if i.startswith("q") else "reference",
            dataset="d",
            scene_id="s",
            split="test" if i.startswith("q") else None,
        )
        for i in ids
    ]
    manifest = Manifest(name="t", entries=entries)
    mp = tmp_path / "manifest.json"
    labels = LabelSet(
        manifest="m",
        definition="t",
        labels=[
            _lab("qa", True, ["A/1"], ["A/2"], agent_inspected=True),
            _lab("qb", True, ["A/2"]),
            _lab("qc", False, method="held_out_scene(d)"),
        ],
    )
    run = _run(
        [
            _q("qa", ["A/1", "A/2"], "likely_match", "A/1"),
            _q("qb", ["B/1", "A/2"], "likely_match", "B/1"),
            _q("qc", ["B/1"], "likely_match", "B/1"),
        ]
    )
    out = tmp_path / "g"
    info = gallery.build(run, "m", labels, manifest, mp, out, splits=["test"], seed=3)
    assert info["failure_categories"]["wrong_accepts_with_reference"]["total"] == 1
    assert info["failure_categories"]["false_accepts_no_reference"]["total"] == 1
    assert (out / "failures.html").is_file() and (out / "review_sheet.html").is_file()
    rows = list(csv.DictReader((out / "review_sheet.csv").open()))
    assert [r["category"] for r in rows].count("ambiguous_pair") == 1
    assert all(r["reviewer_decision"] == "" for r in rows)
    qa = [r for r in rows if r["query_id"] == "qa"][0]
    assert "agent-only" in qa["inspection_status"] and "NOT human" in qa["inspection_status"]
    assert "human reviewed" not in rows[1]["inspection_status"]
    again = tmp_path / "g2"
    gallery.build(run, "m", labels, manifest, mp, again, splits=["test"], seed=3)
    assert (again / "review_sheet.csv").read_text() == (out / "review_sheet.csv").read_text()


def test_compute_keeps_v1_keys():
    lab = _labels().labels[0]
    d = compute([(_queries()[0], lab)])
    for k in ("recall_at_1", "false_acceptance_rate", "acceptance_counts", "counts"):
        assert k in d
