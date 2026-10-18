"""Decisions and validation-only calibration on synthetic runs."""

from __future__ import annotations

from placematch.decide import apply_decisions, calibrate, margin
from placematch.schemas import (
    BackendThresholds,
    Candidate,
    LabelSet,
    QueryLabel,
    QueryResult,
    RunResult,
    RunStats,
    ThresholdSet,
    VerificationResult,
)

KEY = "mock:v1"


def _q(qid, cands, verified=None):
    cs = [
        Candidate(rank=i + 1, reference_id=r, location_id=loc, cosine=c)
        for i, (r, loc, c) in enumerate(cands)
    ]
    if verified is not None:
        cs[0].verification = VerificationResult(
            status="verified" if verified else "inconclusive",
            n_inliers=200 if verified else 3,
            inlier_ratio=0.8 if verified else 0.1,
            coverage_query=0.5 if verified else 0.0,
            coverage_reference=0.5 if verified else 0.0,
        )
    return QueryResult(query_id=qid, path=f"/{qid}.jpg", candidates=cs)


def _run(queries):
    stats = RunStats(
        n_references=3,
        n_queries=len(queries),
        expected_uncached_requests=0,
        api_requests=0,
        cache_hits=0,
        cache_misses=0,
    )
    return RunResult(
        run_id="r",
        created_utc="now",
        backend=KEY,
        backend_config={},
        manifest="m.json",
        queries=queries,
        stats=stats,
    )


TH = ThresholdSet(
    calibrated_on="labels.json:validation",
    method="test",
    backends={KEY: BackendThresholds(accept_cosine=0.8, reject_cosine=0.5, min_margin=0.05)},
)


def test_margin_uses_different_location():
    q = _q("a", [("r1", "L1", 0.9), ("r2", "L1", 0.88), ("r3", "L2", 0.7)])
    assert round(margin(q.candidates)[0], 6) == 0.2
    assert margin(_q("b", [("r1", None, 0.9)]).candidates)[0] is None


def test_outcomes_calibrated():
    run = _run(
        [
            _q("acc", [("r1", "L1", 0.9), ("r2", "L2", 0.7)]),
            _q("low", [("r1", "L1", 0.4), ("r2", "L2", 0.3)]),
            _q("mid", [("r1", "L1", 0.7), ("r2", "L2", 0.6)]),
            _q("tie", [("r1", "L1", 0.9), ("r2", "L2", 0.89)]),
            _q("none", []),
        ]
    )
    out = {q.query_id: q.decision for q in apply_decisions(run, TH, use_verification=False).queries}
    assert out["acc"].outcome == "likely_match" and out["acc"].reference_id == "r1"
    assert out["low"].outcome == "no_supported_match"
    assert out["mid"].outcome == "uncertain"
    assert out["tie"].outcome == "uncertain"
    assert out["none"].outcome == "uncertain"
    assert out["acc"].thresholds == "labels.json:validation" and out["acc"].reasons


def test_verification_requirement_and_never_reorders():
    run = _run(
        [
            _q("v", [("r1", "L1", 0.9), ("r2", "L2", 0.7)], verified=True),
            _q("i", [("r1", "L1", 0.9), ("r2", "L2", 0.7)], verified=False),
        ]
    )
    out = apply_decisions(run, TH, use_verification=True)
    d = {q.query_id: q for q in out.queries}
    assert d["v"].decision.outcome == "likely_match"
    assert d["i"].decision.outcome == "uncertain"  # inconclusive is not a rejection
    assert [c.reference_id for c in d["i"].candidates] == ["r1", "r2"]


def test_uncalibrated_is_conservative():
    run = _run([_q("hi", [("r1", "L1", 0.99)]), _q("neg", [("r1", "L1", -0.2)])])
    run.backend = "gemini:gemini-embedding-2:d3072:max1024:jpg90"
    out = {
        q.query_id: q.decision for q in apply_decisions(run, None, use_verification=False).queries
    }
    assert out["hi"].outcome == "uncertain" and out["hi"].thresholds == "uncalibrated"
    assert out["neg"].outcome == "no_supported_match"


def test_calibrate_uses_only_validation_split():
    queries, labels = [], []
    for i in range(10):  # correct, high cosine
        queries.append(_q(f"p{i}", [("r1", "L1", 0.85 + i * 0.01), ("r2", "L2", 0.5)]))
        labels.append(QueryLabel(query_id=f"p{i}", has_valid_reference=True, positives=["r1"],
                                 method="t", split="validation"))  # fmt: skip
    for i in range(10):  # place absent, cosine up to 0.79
        queries.append(_q(f"n{i}", [("r1", "L1", 0.6 + i * 0.02), ("r2", "L2", 0.4)]))
        labels.append(QueryLabel(query_id=f"n{i}", has_valid_reference=False, method="t",
                                 split="validation"))  # fmt: skip
    # Test-split negative with a very high cosine must not influence calibration.
    queries.append(_q("t0", [("r1", "L1", 0.99), ("r2", "L2", 0.4)]))
    labels.append(QueryLabel(query_id="t0", has_valid_reference=False, method="t", split="test"))
    ls = LabelSet(manifest="m.json", definition="d", labels=labels)
    th = calibrate({"mock": _run(queries)}, ls, labels_path="bench/labels.json")
    bt = th.backends[KEY]
    assert 0.78 < bt.accept_cosine <= 0.85
    assert bt.reject_cosine <= bt.accept_cosine
    assert th.calibrated_on == "bench/labels.json:validation" and "validation" in th.method
