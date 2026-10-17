"""Turn ranked candidates into likely_match / uncertain / no_supported_match decisions.

Cosine is a raw similarity, not a probability; thresholds are per backend and only valid
for the exact backend key they were calibrated on.
"""

from __future__ import annotations

import numpy as np

from placematch.schemas import (
    BackendThresholds,
    Candidate,
    Decision,
    LabelSet,
    QueryResult,
    RunResult,
    ThresholdSet,
)
from placematch.verify import DEFAULT_THRESHOLDS, passes

#: Without calibration we only say "no supported match" below these clearly-low top-1
#: cosines (per backend family); everything else stays "uncertain". Set below the cosines
#: seen between *unrelated* 7-Scenes rooms in a 7-image smoke test (Gemini ~0.58-0.68,
#: MegaLoc ~0.00-0.07); a guard, not a calibration. "vertex" serves the same model with the
#: same preprocessing (110/110 bench-v1 vectors bitwise identical, runs/ops/vertex_vs_devapi.json)
#: so it shares the Gemini guard. Calibrated thresholds stay per backend key.
UNCALIBRATED_REJECT_FLOOR = {"gemini": 0.45, "vertex": 0.45, "megaloc": 0.02}
MARGIN_GRID = (0.0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15)


def margin(cands: list[Candidate]) -> tuple[float | None, str]:
    """top-1 cosine minus the best candidate from a different known location_id."""
    if not cands or cands[0].location_id is None:
        return None, "location ids unknown; margin not checked"
    top = cands[0]
    other = [c for c in cands[1:] if c.location_id is not None and c.location_id != top.location_id]
    if other:
        return top.cosine - other[0].cosine, f"margin over {other[0].reference_id}"
    if len(cands) > 1:
        return top.cosine - cands[-1].cosine, "all top-k share the location; margin is a bound"
    return None, "single candidate; margin not checked"


def _verify_ok(c: Candidate, bt: BackendThresholds) -> tuple[bool, str]:
    v = c.verification
    if v is None:
        return False, "top-1 not verified (no verification run)"
    if v.status != "verified":
        return False, f"verification {v.status}: {v.message}"[:200]
    th = bt.verify or DEFAULT_THRESHOLDS
    if not passes(v, th):
        return False, "verification below calibrated evidence thresholds"
    return True, (
        f"verified: {v.n_inliers} inliers, ratio {v.inlier_ratio:.2f}, "
        f"coverage {v.coverage_query:.2f}/{v.coverage_reference:.2f}"
    )


def _family(key: str) -> str:
    return key.split(":", 1)[0]


def decide_query(
    q: QueryResult, backend: str, bt: BackendThresholds | None, label: str, use_verification: bool
) -> Decision:
    reasons = []
    if q.quality and q.quality.flags:
        reasons.append("frame quality: " + ", ".join(q.quality.flags))
    if not q.candidates:
        return Decision(
            outcome="uncertain",
            reasons=["no candidates (embedding failed or no references)", *reasons],
            thresholds=label,
        )
    top = q.candidates[0]
    m, m_note = margin(q.candidates)
    reasons.insert(0, f"top-1 {top.reference_id} cosine {top.cosine:.4f}")
    if m is not None:
        reasons.append(f"{m_note}: {m:.4f}")
    else:
        reasons.append(m_note)

    if bt is None:
        floor = UNCALIBRATED_REJECT_FLOOR.get(_family(backend), -1.0)
        if top.cosine < floor:
            reasons.append(f"below uncalibrated reject floor {floor}")
            return Decision(outcome="no_supported_match", reasons=reasons, thresholds=label)
        reasons.append("thresholds uncalibrated; not accepting any match")
        if use_verification and top.verification is not None:
            reasons.append(f"verification {top.verification.status} (informational)")
        return Decision(outcome="uncertain", reasons=reasons, thresholds=label)

    if top.cosine < bt.reject_cosine:
        reasons.append(f"below reject threshold {bt.reject_cosine:.4f}")
        return Decision(outcome="no_supported_match", reasons=reasons, thresholds=label)
    if top.cosine < bt.accept_cosine:
        reasons.append(f"below accept threshold {bt.accept_cosine:.4f}")
        return Decision(outcome="uncertain", reasons=reasons, thresholds=label)
    if m is not None and m < bt.min_margin:
        reasons.append(f"margin below {bt.min_margin:.4f} (another place scores similarly)")
        return Decision(outcome="uncertain", reasons=reasons, thresholds=label)
    if use_verification:
        ok, note = _verify_ok(top, bt)
        reasons.append(note)
        if not ok:
            return Decision(outcome="uncertain", reasons=reasons, thresholds=label)
    reasons.append(f"at/above accept threshold {bt.accept_cosine:.4f}")
    return Decision(
        outcome="likely_match", reference_id=top.reference_id, reasons=reasons, thresholds=label
    )


def apply_decisions(
    run: RunResult, thresholds: ThresholdSet | None, *, use_verification: bool
) -> RunResult:
    """Fill ``query.decision`` for every query (returns a copy)."""
    run = run.model_copy(deep=True)
    bt = thresholds.backends.get(run.backend) if thresholds else None
    label = thresholds.calibrated_on if bt is not None else "uncalibrated"
    for q in run.queries:
        q.decision = decide_query(q, run.backend, bt, label, use_verification)
    run.settings["decisions"] = {"use_verification": use_verification, "thresholds": label}
    return run


def _calibrate_one(points, target_far: float, target_precision: float) -> tuple[dict, str]:
    neg = np.array([not p["has_ref"] for p in points])
    correct = np.array([p["correct"] is True for p in points])
    wrong = np.array([p["correct"] is False for p in points])
    cos = np.array([p["cos"] for p in points])
    mar = np.array([np.nan if p["margin"] is None else p["margin"] for p in points])
    cosines = sorted(set(cos.tolist()))
    margins = MARGIN_GRID if any(p["margin"] is not None for p in points) else (0.0,)
    best = None
    for a in cosines:
        for m in margins:
            acc = (cos >= a) & (np.isnan(mar) | (mar >= m))
            tp, fp = int((acc & correct).sum()), int((acc & wrong).sum())
            if tp + fp == 0:
                continue
            prec = tp / (tp + fp)
            far = (acc & neg).sum() / neg.sum() if neg.any() else None
            if prec < target_precision or (far is not None and far > target_far):
                continue
            score = (tp, prec, a, m)
            if best is None or score > best[0]:
                best = (score, dict(accept_cosine=a, min_margin=m), far)
    if best is None:
        accept = (cosines[-1] if cosines else 1.0) + 1e-6
        rule = dict(accept_cosine=min(accept, 1.0 + 1e-6), min_margin=0.0)
        note = "no threshold met the targets; accept set above every validation top-1 cosine"
    else:
        (tp, prec, _, _), rule, far = best
        note = f"accepts {tp} correct, precision {prec:.3f}, FAR " + (
            "n/a (no queries without reference)" if far is None else f"{far:.3f}"
        )
    pos_cos = [p["cos"] for p in points if p["has_ref"] and p["correct"] is True] or [
        p["cos"] for p in points if p["has_ref"]
    ]
    reject = float(np.quantile(pos_cos, 0.05)) if pos_cos else min(cosines or [0.0])
    rule["reject_cosine"] = min(reject, rule["accept_cosine"])
    return rule, note


def calibrate(
    runs: dict[str, RunResult],
    labels: LabelSet,
    split: str = "validation",
    *,
    target_far: float = 0.05,
    target_precision: float = 0.9,
    labels_path: str | None = None,
) -> ThresholdSet:
    """Choose per-backend thresholds using ONLY labels of ``split``.

    Rule: among (accept cosine, min margin) pairs, maximise correctly accepted queries
    subject to accepted precision >= ``target_precision`` and false-acceptance rate (accepted
    among queries without a valid reference) <= ``target_far``; ties prefer higher precision
    then stricter thresholds. Reject = 5th percentile of top-1 cosines of queries whose top-1
    is correct (so <=5% of those are called no_supported_match). Verification evidence
    thresholds are the fixed verify.DEFAULT_THRESHOLDS (not tuned) when a run has them.
    """
    by_q = {lb.query_id: lb for lb in labels.labels if lb.split == split}
    if not by_q:
        raise ValueError(f"no labels for split {split!r}")
    backends, notes = {}, []
    for name, run in runs.items():
        points = []
        for q in run.queries:
            lb = by_q.get(q.query_id)
            if lb is None or not q.candidates:
                continue
            top = q.candidates[0].reference_id
            if not lb.has_valid_reference:
                correct = False
            elif top in lb.positives:
                correct = True
            elif top in lb.ambiguous:
                correct = None
            else:
                correct = False
            points.append(
                dict(
                    cos=q.candidates[0].cosine,
                    margin=margin(q.candidates)[0],
                    has_ref=lb.has_valid_reference,
                    correct=correct,
                )
            )
        if not points:
            notes.append(f"{name}: no labelled {split} queries; skipped")
            continue
        rule, note = _calibrate_one(points, target_far, target_precision)
        has_verify = any(c.verification for q in run.queries for c in q.candidates[:1])
        backends[run.backend] = BackendThresholds(
            **rule, verify=DEFAULT_THRESHOLDS if has_verify else None
        )
        notes.append(f"{name} ({run.backend}): n={len(points)}; {note}")
    method = (
        f"grid search on {split} labels only: maximise correct accepts s.t. precision>="
        f"{target_precision} and FAR<={target_far}; margin grid {list(MARGIN_GRID)}; reject = "
        "p05 of correct top-1 cosines. " + " | ".join(notes)
    )
    src = labels_path or f"labels[{labels.manifest}]"
    return ThresholdSet(calibrated_on=f"{src}:{split}", method=method, backends=backends)
