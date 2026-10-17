"""Offline tests for placematch.evaluation with hand-made RunResult/LabelSet fixtures."""

from __future__ import annotations

import csv
import json

import pytest

from placematch.evaluation import report
from placematch.evaluation.metrics import compute, evaluate, verification_effect
from placematch.evaluation.run import evaluate_runs, main, method_name
from placematch.schemas import (
    Candidate,
    Decision,
    LabelSet,
    QueryLabel,
    QueryResult,
    RunResult,
    RunStats,
    VerificationResult,
)


def _q(qid, ranked, outcome=None, ref=None, verify=None):
    cands = [
        Candidate(rank=i + 1, reference_id=r, location_id=r.split("/")[0], cosine=0.9 - 0.1 * i)
        for i, r in enumerate(ranked)
    ]
    if verify is not None and cands:
        cands[0].verification = VerificationResult(status=verify)
    dec = None if outcome is None else Decision(outcome=outcome, reference_id=ref)
    return QueryResult(query_id=qid, path=f"{qid}.png", candidates=cands, decision=dec)


def _run(queries, backend="gemini:test", use_verification=False, run_id="r1"):
    return RunResult(
        run_id=run_id,
        created_utc="2026-10-17T00:00:00Z",
        backend=backend,
        backend_config={},
        manifest="manifest.json",
        settings={"decisions": {"use_verification": use_verification}},
        queries=queries,
        stats=RunStats(
            n_references=4,
            n_queries=len(queries),
            expected_uncached_requests=3,
            api_requests=3,
            cache_hits=5,
            cache_misses=3,
            timings_s={"embed": 1.5},
        ),
    )


def _labels():
    L = [
        # q1: positive a/1; top-1 is ambiguous a/9 (dropped) -> R@1 hit
        QueryLabel(query_id="q1", has_valid_reference=True, positives=["a/1"],
                   ambiguous=["a/9"], method="t", split="test"),
        # q2: positive a/2 only at rank 3 -> R@1 miss, R@5 hit
        QueryLabel(query_id="q2", has_valid_reference=True, positives=["a/2"],
                   method="t", split="test", conditions=["real:motion_blur"]),
        # q3: no reference (held out)
        QueryLabel(query_id="q3", has_valid_reference=False, method="t", split="test"),
        # q4: ambiguous only
        QueryLabel(query_id="q4", has_valid_reference=False, ambiguous=["b/1"],
                   method="t", split="test"),
        # q5: validation query, must not leak into test
        QueryLabel(query_id="q5", has_valid_reference=True, positives=["a/1"],
                   method="t", split="validation"),
        # q1 synthetic copy: kept out of headline numbers
        QueryLabel(query_id="q1:synthetic:dark", has_valid_reference=True, positives=["a/1"],
                   method="t", split="test", conditions=["synthetic:dark"]),
    ]  # fmt: skip
    return LabelSet(manifest="manifest.json", definition="test", labels=L)


def _base_queries():
    return [
        _q("q1", ["a/9", "a/1", "b/1"], "likely_match", "a/1"),  # correct accept
        _q("q2", ["b/1", "b/2", "a/2"], "likely_match", "b/1"),  # wrong accept
        _q("q3", ["a/1", "b/1"], "likely_match", "a/1"),  # false acceptance
        _q("q4", ["b/1", "a/1"], "likely_match", "b/1"),  # accepted ambiguous: not counted
        _q("q5", ["c/1"], "no_supported_match"),
        _q("q1:synthetic:dark", ["b/2", "a/3"], "uncertain"),
    ]


def test_headline_metrics_real_only():
    m = evaluate(_run(_base_queries()), _labels(), "test", "gemini")
    assert m.n_queries == 4  # synthetic and validation excluded
    assert (m.n_with_reference, m.n_without_reference) == (2, 2)
    assert m.recall_at_1 == pytest.approx(0.5)
    assert m.recall_at_5 == pytest.approx(1.0)
    # q3 is a false acceptance; q4 accepted an ambiguous ref -> excluded from FAR
    assert m.false_acceptance_rate == pytest.approx(1.0)
    # accepted: q1 correct, q2 wrong, q3 wrong, q4 ambiguous -> precision 1/3
    assert m.accepted_precision == pytest.approx(1 / 3)
    assert m.accepted_recall == pytest.approx(0.5)
    assert m.outcome_counts == {"likely_match": 4}
    assert m.extra["n_ambiguous_only"] == 1
    assert m.api_requests == 3 and m.cache_hits == 5
    assert m.extra["run_stats"]["cache_hit_rate"] == pytest.approx(5 / 8)


def test_conditions_and_synthetic_kept_separate():
    m = evaluate(_run(_base_queries()), _labels(), "test", "gemini")
    assert m.by_condition["real:motion_blur"]["n_queries"] == 1
    assert m.by_condition["real:motion_blur"]["recall_at_1"] == 0.0
    assert m.by_condition["synthetic:dark"]["recall_at_1"] == 0.0
    assert m.by_condition["synthetic:all"]["n_queries"] == 1
    assert m.by_condition["real:synthetic_sources"]["recall_at_1"] == 1.0
    assert "q1:synthetic:dark" not in m.extra["by_scene"]


def test_no_decisions_gives_none_rates():
    qs = [_q("q1", ["a/1"]), _q("q3", ["a/1"])]
    m = evaluate(_run(qs), _labels(), "test", "megaloc")
    assert m.recall_at_1 == 1.0
    assert m.false_acceptance_rate is None and m.accepted_precision is None
    assert m.extra["n_missing"] == 3  # q2, q4 and the synthetic copy are not in the run


def test_empty_candidates_is_failure():
    d = compute([(_q("q1", []), _labels().labels[0])])
    assert d["recall_at_1"] == 0.0 and d["n_no_candidates"] == 1


def test_verification_effect_counts():
    without = _run(_base_queries())
    with_v = _run(
        [
            _q("q1", ["a/9", "a/1", "b/1"], "uncertain", verify="inconclusive"),  # rejected
            _q("q2", ["b/1", "b/2", "a/2"], "uncertain", verify="inconclusive"),  # removed
            _q("q3", ["a/1", "b/1"], "uncertain", verify="verified"),  # removed
            _q("q4", ["b/1", "a/1"], "likely_match", "b/1", verify="verified"),
        ],
        use_verification=True,
        run_id="r2",
    )
    eff = verification_effect(without, with_v, _labels(), "test")
    assert eff["counts"]["correct_rejected_or_downgraded"] == 1
    assert eff["counts"]["wrong_removed"] == 2
    assert eff["counts"]["unchanged_ambiguous"] == 1
    assert eff["top1_verification_status"] == {"inconclusive": 2, "verified": 2}
    assert eff["notes"] == []


def test_rescued_and_added():
    lab = _labels()
    a = _run([_q("q1", ["a/1"], "uncertain"), _q("q3", ["a/1"], "uncertain")])
    b = _run([_q("q1", ["a/1"], "likely_match", "a/1"), _q("q3", ["a/1"], "likely_match", "a/1")])
    eff = verification_effect(a, b, lab, "test")
    assert eff["counts"] == {"correct_rescued": 1, "wrong_added": 1}


def test_report_files(tmp_path):
    runs = {
        "gemini": _run(_base_queries()),
        "gemini+verify": _run(_base_queries(), use_verification=True, run_id="r2"),
    }
    rep = evaluate_runs(
        runs, _labels(), splits=["test", "validation"], manifest_path="m", labels_path="l"
    )
    assert len(rep.methods) == 4
    v = [m for m in rep.methods if m.method == "gemini+verify" and m.split == "test"][0]
    assert "verification_effect" in v.extra
    report.write(rep, tmp_path)
    data = json.loads((tmp_path / "metrics.json").read_text())
    assert len(data["methods"]) == 4
    rows = list(csv.DictReader((tmp_path / "metrics.csv").open()))
    assert any(r["scope"] == "synthetic" and r["group"] == "synthetic:dark" for r in rows)
    md = (tmp_path / "report.md").read_text()
    assert "synthetic edits (kept separate)" in md and "Definitions" in md


def test_cli_end_to_end(tmp_path):
    from placematch.schemas import Manifest

    bench = tmp_path / "bench"
    bench.mkdir()
    (bench / "manifest.json").write_text(Manifest(name="t", entries=[]).model_dump_json())
    (bench / "labels.json").write_text(_labels().model_dump_json())
    rp = tmp_path / "results.json"
    rp.write_text(_run(_base_queries()).model_dump_json())
    main(["--bench", str(bench), "--runs", str(rp), "--out", str(tmp_path / "out")])
    assert (tmp_path / "out" / "report.md").is_file()
    assert method_name(_run([], use_verification=True)) == "gemini+verify"
