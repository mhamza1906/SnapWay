"""Retrieval and decision metrics for one RunResult against benchmark labels.

Definitions (also written into every report):

* Real and synthetic queries are never mixed. Headline numbers use real queries only
  (no ``synthetic:*`` condition); synthetic edits appear only in ``by_condition``.
* Recall@k (k = 1, 5) is computed over queries with ``has_valid_reference``. Candidates
  that are *ambiguous* for that query are removed from the ranking first (they count
  neither as right nor wrong), then a hit is a positive among the first k remaining.
* A query is *accepted* when ``decision.outcome == "likely_match"``. An accepted reference
  is correct if it is a positive, ambiguous if listed as ambiguous (excluded from precision
  and false-acceptance counts), otherwise wrong.
* False acceptance rate: among queries without a valid reference, the fraction accepted
  with a non-ambiguous reference (queries whose acceptance hit an ambiguous reference are
  left out of numerator and denominator).
* Accepted precision: correct / (correct + wrong) over all accepted queries.
  Accepted recall: correct accepted / queries with a valid reference.
* Queries in the labels but missing from the run are reported (``extra.n_missing``) and
  excluded; a query present in the run with no candidates is a retrieval failure.
* Decision counts (``MethodMetrics.counts``, real queries): ``correct_accepts``;
  ``wrong_accepts`` = ``wrong_accepts_with_reference`` (a query that has a valid reference
  accepted a wrong place) + ``false_accepts_no_reference``; ``ambiguous_accepts`` (accepted
  an ambiguous reference: never a correct rejection, never correct); ``rejected_valid``
  (valid reference, outcome no_supported_match); ``uncertain`` (split by reference status);
  ``correct_rejections`` (no valid reference, outcome no_supported_match);
  ``excluded_*`` with the reason (missing from the run, no decision stored).
* Acceptance coverage = accepted / all queries. Strict precision = correct / all accepted
  (ambiguous accepts count against it). Strict FAR = (wrong + ambiguous accepts) / all
  queries without a valid reference. FAR is also reported separately for absent locations
  (place held out of the reference pool) and absent views (place present, no co-visible
  reference).
* Confidence intervals: percentile cluster bootstrap (B resamples of whole clusters with
  replacement, seed fixed). Clusters are ``QueryLabel.group_id`` (recording/session; the
  scene when missing) and, separately, the scene. With fewer than 10 clusters the interval
  is flagged as unreliable.
"""

from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np

from placematch.schemas import LabelSet, MethodMetrics, QueryLabel, QueryResult, RunResult, Split

OUTCOMES = ("likely_match", "uncertain", "no_supported_match")
METRIC_DEFINITIONS = __doc__.split("Definitions (also written into every report):", 1)[1].strip()


def is_synthetic(label: QueryLabel) -> bool:
    return any(c.startswith("synthetic:") for c in label.conditions)


def dataset_of(query_id: str) -> str:
    return query_id.split(":", 1)[0] if ":" in query_id else "unknown"


def scene_of(query_id: str) -> str:
    parts = query_id.split(":")
    return ":".join(parts[:2]) if len(parts) >= 2 else "unknown"


def _ranked_without_ambiguous(q: QueryResult, label: QueryLabel) -> list[str]:
    amb = set(label.ambiguous)
    ranked = sorted(q.candidates, key=lambda c: c.rank)
    return [c.reference_id for c in ranked if c.reference_id not in amb]


def acceptance(q: QueryResult, label: QueryLabel) -> str:
    """'correct' | 'wrong' | 'ambiguous' | 'not_accepted' | 'no_decision'."""
    if q.decision is None:
        return "no_decision"
    if q.decision.outcome != "likely_match":
        return "not_accepted"
    ref = q.decision.reference_id
    if ref in label.positives:
        return "correct"
    if ref in label.ambiguous:
        return "ambiguous"
    return "wrong"


def _ratio(num: int, den: int) -> float | None:
    return None if den == 0 else num / den


def compute(pairs: list[tuple[QueryResult, QueryLabel]]) -> dict:
    """Core metrics over (result, label) pairs. Returns a JSON-safe dict."""
    with_ref = [(q, lb) for q, lb in pairs if lb.has_valid_reference]
    without = [(q, lb) for q, lb in pairs if not lb.has_valid_reference]
    hits1 = hits5 = 0
    for q, lb in with_ref:
        ranked = _ranked_without_ambiguous(q, lb)
        pos = set(lb.positives)
        hits1 += any(r in pos for r in ranked[:1])
        hits5 += any(r in pos for r in ranked[:5])
    acc = Counter(acceptance(q, lb) for q, lb in pairs)
    have_decisions = acc["no_decision"] < len(pairs) or not pairs
    fa_num = sum(1 for q, lb in without if acceptance(q, lb) == "wrong")
    fa_den = sum(1 for q, lb in without if acceptance(q, lb) != "ambiguous")
    correct_acc = sum(1 for q, lb in with_ref if acceptance(q, lb) == "correct")
    outcome_counts = Counter(q.decision.outcome if q.decision else "no_decision" for q, _ in pairs)
    outcome_by_ref = {
        "with_reference": dict(
            Counter(q.decision.outcome if q.decision else "no_decision" for q, _ in with_ref)
        ),
        "without_reference": dict(
            Counter(q.decision.outcome if q.decision else "no_decision" for q, _ in without)
        ),
    }
    counts = decision_counts(pairs)
    n_acc = acc["correct"] + acc["wrong"] + acc["ambiguous"]
    absent_loc = [(q, lb) for q, lb in without if is_absent_location(lb)]
    absent_view = [(q, lb) for q, lb in without if not is_absent_location(lb)]
    return {
        "counts": counts,
        "acceptance_coverage": _ratio(n_acc, len(pairs)) if have_decisions else None,
        "precision_strict": _ratio(acc["correct"], n_acc) if have_decisions else None,
        "far_strict": (
            _ratio(
                sum(1 for q, lb in without if acceptance(q, lb) in ("wrong", "ambiguous")),
                len(without),
            )
            if have_decisions
            else None
        ),  # fmt: skip
        "far_absent_location": _far(absent_loc) if have_decisions else None,
        "far_absent_view": _far(absent_view) if have_decisions else None,
        "n_absent_location": len(absent_loc),
        "n_absent_view": len(absent_view),
        "n_queries": len(pairs),
        "n_with_reference": len(with_ref),
        "n_without_reference": len(without),
        "n_ambiguous_only": sum(1 for _, lb in without if lb.ambiguous),
        "n_no_candidates": sum(1 for q, _ in pairs if not q.candidates),
        "recall_at_1": _ratio(hits1, len(with_ref)),
        "recall_at_5": _ratio(hits5, len(with_ref)),
        "false_acceptance_rate": _ratio(fa_num, fa_den) if have_decisions else None,
        "accepted_precision": (
            _ratio(acc["correct"], acc["correct"] + acc["wrong"]) if have_decisions else None
        ),
        "accepted_recall": _ratio(correct_acc, len(with_ref)) if have_decisions else None,
        "acceptance_counts": {k: acc[k] for k in ("correct", "wrong", "ambiguous")},
        "false_acceptances": fa_num,
        "outcome_counts": dict(outcome_counts),
        "outcome_by_reference_status": outcome_by_ref,
    }


def is_absent_location(label: QueryLabel) -> bool:
    """The query's place is held out of the reference pool (vs. present but not co-visible)."""
    return (not label.has_valid_reference) and label.method.startswith("held_out")


def _far(pairs: list[tuple[QueryResult, QueryLabel]]) -> float | None:
    num = sum(1 for q, lb in pairs if acceptance(q, lb) == "wrong")
    den = sum(1 for q, lb in pairs if acceptance(q, lb) != "ambiguous")
    return _ratio(num, den)


def classify(q: QueryResult, label: QueryLabel) -> str:
    """One decision category per query (see the definitions)."""
    a = acceptance(q, label)
    if a == "no_decision":
        return "excluded_no_decision"
    if a == "correct":
        return "correct_accepts"
    if a == "ambiguous":
        return "ambiguous_accepts"
    if a == "wrong":
        return (
            "wrong_accepts_with_reference"
            if label.has_valid_reference
            else "false_accepts_no_reference"
        )
    outcome = q.decision.outcome  # type: ignore[union-attr]
    if label.has_valid_reference:
        return "rejected_valid" if outcome == "no_supported_match" else "uncertain_with_reference"
    return (
        "correct_rejections" if outcome == "no_supported_match" else "uncertain_without_reference"
    )


COUNT_KEYS = (
    "correct_accepts",
    "wrong_accepts",
    "wrong_accepts_with_reference",
    "false_accepts_no_reference",
    "ambiguous_accepts",
    "rejected_valid",
    "uncertain",
    "uncertain_with_reference",
    "uncertain_without_reference",
    "correct_rejections",
    "excluded_no_decision",
)


def decision_counts(pairs: list[tuple[QueryResult, QueryLabel]]) -> dict[str, int]:
    c = Counter(classify(q, lb) for q, lb in pairs)
    c["wrong_accepts"] = c["wrong_accepts_with_reference"] + c["false_accepts_no_reference"]
    c["uncertain"] = c["uncertain_with_reference"] + c["uncertain_without_reference"]
    return {k: int(c[k]) for k in COUNT_KEYS}


# ----------------------------------------------------------------------- bootstrap CIs


#: metric -> per-query (numerator, denominator) contribution
def _contrib(q: QueryResult, lb: QueryLabel) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    if lb.has_valid_reference:
        ranked = _ranked_without_ambiguous(q, lb)
        pos = set(lb.positives)
        out["recall_at_1"] = (int(any(r in pos for r in ranked[:1])), 1)
        out["recall_at_5"] = (int(any(r in pos for r in ranked[:5])), 1)
    a = acceptance(q, lb)
    if a != "no_decision":
        if not lb.has_valid_reference:
            out["false_acceptance_rate"] = (int(a == "wrong"), int(a != "ambiguous"))
            out["far_strict"] = (int(a in ("wrong", "ambiguous")), 1)
            if is_absent_location(lb):
                out["far_absent_location"] = (int(a == "wrong"), int(a != "ambiguous"))
        out["accepted_precision"] = (int(a == "correct"), int(a in ("correct", "wrong")))
        if lb.has_valid_reference:
            out["accepted_recall"] = (int(a == "correct"), 1)
    return out


CI_METRICS = (
    "recall_at_1",
    "recall_at_5",
    "false_acceptance_rate",
    "far_strict",
    "far_absent_location",
    "accepted_precision",
    "accepted_recall",
)
MIN_CLUSTERS = 10


def recording_from_id(query_id: str) -> str:
    """Fallback cluster for labels without group_id: the id up to the first '/', which is
    the recording for 7-Scenes (``7scenes:chess:seq-03``), CLoc (session) and Map-free."""
    return query_id.split(":synthetic:", 1)[0].split("/", 1)[0]


def group_key(label: QueryLabel, by: str) -> str:
    if by == "scene":
        return scene_of(label.query_id)
    return label.group_id or recording_from_id(label.query_id)


def cluster_bootstrap(
    pairs: list[tuple[QueryResult, QueryLabel]],
    *,
    by: str = "group_id",
    n_boot: int = 1000,
    seed: int = 0,
    level: float = 0.95,
    metrics: tuple[str, ...] = CI_METRICS,
) -> dict[str, dict]:
    """Percentile cluster-bootstrap intervals for ratio metrics (whole clusters resampled)."""
    groups: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    fallback = False
    for q, lb in pairs:
        if by != "scene" and not lb.group_id:
            fallback = True
        g = group_key(lb, by)
        for m, (n, d) in _contrib(q, lb).items():
            groups[g][m][0] += n
            groups[g][m][1] += d
    names = sorted(groups)
    rng = np.random.default_rng(seed)
    out = {}
    for m in metrics:
        num = np.array([groups[g][m][0] if m in groups[g] else 0 for g in names], float)
        den = np.array([groups[g][m][1] if m in groups[g] else 0 for g in names], float)
        keep = den > 0
        n_groups = int(keep.sum())
        if n_groups == 0:
            continue
        num, den = num[keep], den[keep]
        idx = rng.integers(0, n_groups, size=(n_boot, n_groups))
        dsum = den[idx].sum(1)
        ratios = np.where(dsum > 0, num[idx].sum(1) / np.maximum(dsum, 1e-12), np.nan)
        ratios = ratios[np.isfinite(ratios)]
        a = (1 - level) / 2
        rec = {
            "point": float(num.sum() / den.sum()),
            "low": float(np.quantile(ratios, a)) if len(ratios) else None,
            "high": float(np.quantile(ratios, 1 - a)) if len(ratios) else None,
            "method": f"cluster_bootstrap_percentile(B={n_boot}, level={level}, seed={seed})",
            "by": by
            + ("(recording parsed from the id where group_id is missing)" if fallback else ""),
            "n_groups": n_groups,
            "n_queries": int(den.sum()),
        }
        if n_groups < MIN_CLUSTERS:
            rec["warning"] = f"only {n_groups} clusters; interval is unreliable"
        out[m] = rec
    return out


def operations_summary(run: RunResult, query_ids: set[str] | None = None) -> dict:
    """Latency / throughput / memory / API / cost from RunStats and QueryResult.timings_s."""
    st = run.stats
    per_key: dict[str, list[float]] = defaultdict(list)
    for q in run.queries:
        if query_ids is not None and q.query_id not in query_ids:
            continue
        for k, v in q.timings_s.items():
            per_key[k].append(float(v))
    lat = {
        k: {
            "n": len(v),
            "median_s": float(np.median(v)),
            "p95_s": float(np.quantile(v, 0.95)),
            "max_s": float(np.max(v)),
        }
        for k, v in sorted(per_key.items())
        if v
    }
    n_images = st.n_references + st.n_queries
    embed_t = st.timings_s.get("embed")
    return {
        "per_query_timings": lat,
        "run_latency_s": st.latency_s,
        "run_timings_s": st.timings_s,
        "throughput_images_per_s": (n_images / embed_t) if embed_t else None,
        "peak_rss_mb": st.peak_rss_mb,
        "api_requests": st.api_requests,
        "http_attempts": st.http_attempts,
        "retries": st.retries,
        "failed": st.failed,
        "cache_hits": st.cache_hits,
        "cache_misses": st.cache_misses,
        "usage": st.usage,
        "cost_estimate": st.cost_estimate,
        "hardware": st.hardware,
        "cold_start": st.cold_start,
        "note": "run-level values cover the whole run (all splits)",
    }


def pair_up(
    run: RunResult, labels: LabelSet, split: Split
) -> tuple[list[tuple[QueryResult, QueryLabel]], list[str]]:
    by_id = {q.query_id: q for q in run.queries}
    pairs, missing = [], []
    for lb in labels.labels:
        if lb.split != split:
            continue
        q = by_id.get(lb.query_id)
        if q is None:
            missing.append(lb.query_id)
        else:
            pairs.append((q, lb))
    return pairs, missing


def evaluate(
    run: RunResult,
    labels: LabelSet,
    split: Split,
    method: str,
    *,
    n_boot: int = 1000,
    seed: int = 0,
) -> MethodMetrics:
    pairs, missing = pair_up(run, labels, split)
    real = [(q, lb) for q, lb in pairs if not is_synthetic(lb)]
    core = compute(real)
    ci = {}
    if n_boot > 0 and real:
        ci = cluster_bootstrap(real, by="group_id", n_boot=n_boot, seed=seed)
        for k, v in cluster_bootstrap(real, by="scene", n_boot=n_boot, seed=seed).items():
            ci[f"{k}|by_scene"] = v

    by_condition: dict[str, dict] = {}
    groups: dict[str, list] = defaultdict(list)
    for q, lb in pairs:
        conds = lb.conditions or ["real:none"]
        for c in conds:
            groups[c].append((q, lb))
    for c in sorted(groups):
        by_condition[c] = compute(groups[c])
    synth = [(q, lb) for q, lb in pairs if is_synthetic(lb)]
    if synth:
        by_condition["synthetic:all"] = compute(synth)
        # the real source queries of the synthetic edits, for a like-for-like comparison
        src_ids = {lb.query_id.split(":synthetic:", 1)[0] for _, lb in synth}
        src = [(q, lb) for q, lb in real if lb.query_id in src_ids]
        if src:
            by_condition["real:synthetic_sources"] = compute(src)

    by_eval_set: dict[str, dict] = {}
    es: dict[str, list] = defaultdict(list)
    for q, lb in real:
        for name in lb.eval_sets:
            es[name].append((q, lb))
    for name in sorted(es):
        by_eval_set[name] = compute(es[name])

    by_dataset = {}
    by_scene = {}
    for name, key in (("dataset", dataset_of), ("scene", scene_of)):
        g: dict[str, list] = defaultdict(list)
        for q, lb in real:
            g[key(lb.query_id)].append((q, lb))
        (by_dataset if name == "dataset" else by_scene).update(
            {k: compute(v) for k, v in sorted(g.items())}
        )

    st = run.stats
    lookups = st.cache_hits + st.cache_misses
    extra = {
        "backend": run.backend,
        "run_id": run.run_id,
        "scope": "real queries only (synthetic in by_condition)",
        "n_missing": len(missing),
        "missing_examples": missing[:10],
        "n_ambiguous_only": core["n_ambiguous_only"],
        "n_no_candidates": core["n_no_candidates"],
        "acceptance_counts": core["acceptance_counts"],
        "false_acceptances": core["false_acceptances"],
        "outcome_by_reference_status": core["outcome_by_reference_status"],
        "by_dataset": by_dataset,
        "by_scene": by_scene,
        "by_eval_set": by_eval_set,
        "decision_metrics": {
            k: core[k]
            for k in (
                "acceptance_coverage",
                "precision_strict",
                "far_strict",
                "far_absent_location",
                "far_absent_view",
                "n_absent_location",
                "n_absent_view",
            )
        },
        "excluded": {
            "missing_in_run": len(missing),
            "no_decision": core["counts"]["excluded_no_decision"],
        },
        "operations": operations_summary(run, {q.query_id for q, _ in real}),
        "decision_settings": run.settings.get("decisions"),
        "run_stats": {
            "n_references": st.n_references,
            "n_queries": st.n_queries,
            "expected_uncached_requests": st.expected_uncached_requests,
            "api_requests": st.api_requests,
            "cache_hits": st.cache_hits,
            "cache_misses": st.cache_misses,
            "cache_hit_rate": _ratio(st.cache_hits, lookups),
            "requests_saved_by_cache": st.cache_hits,
            "retries": st.retries,
            "failed": st.failed,
            "note": "run-level statistics cover the whole run, not only this split",
        },
    }
    return MethodMetrics(
        method=method,
        split=split,
        n_queries=core["n_queries"],
        n_with_reference=core["n_with_reference"],
        n_without_reference=core["n_without_reference"],
        recall_at_1=core["recall_at_1"],
        recall_at_5=core["recall_at_5"],
        false_acceptance_rate=core["false_acceptance_rate"],
        accepted_precision=core["accepted_precision"],
        accepted_recall=core["accepted_recall"],
        outcome_counts=core["outcome_counts"],
        by_condition=by_condition,
        api_requests=st.api_requests,
        cache_hits=st.cache_hits,
        timings_s=dict(st.timings_s),
        counts={**core["counts"], "excluded_missing_in_run": len(missing)},
        ci=ci,
        extra=extra,
    )


def verification_effect(
    without: RunResult, with_verify: RunResult, labels: LabelSet, split: Split
) -> dict:
    """Compare decisions made without and with geometric verification (real queries).

    Both runs must come from the same backend (verification never reorders candidates).
    """
    notes = []
    if without.backend != with_verify.backend:
        notes.append(
            f"backends differ ({without.backend} vs {with_verify.backend}); comparison is "
            "between different retrieval runs, not only the verification step"
        )
    a_pairs, _ = pair_up(without, labels, split)
    b_by = {q.query_id: q for q in with_verify.queries}
    counts = Counter()
    by_ds: dict[str, Counter] = defaultdict(Counter)
    examples: dict[str, list[str]] = defaultdict(list)
    verify_status = Counter()
    for qa, lb in a_pairs:
        if is_synthetic(lb):
            continue
        qb = b_by.get(qa.query_id)
        if qb is None:
            counts["missing_in_verified_run"] += 1
            continue
        if qb.candidates and qb.candidates[0].verification is not None:
            verify_status[qb.candidates[0].verification.status] += 1
        elif qb.candidates:
            verify_status["not_run"] += 1
        a, b = acceptance(qa, lb), acceptance(qb, lb)
        if "no_decision" in (a, b):
            counts["no_decision"] += 1
            continue
        if b == "correct" and a != "correct":
            key = "correct_rescued"
        elif a == "correct" and b != "correct":
            key = "correct_rejected_or_downgraded"
        elif a == "wrong" and b != "wrong":
            key = "wrong_removed"
        elif b == "wrong" and a != "wrong":
            key = "wrong_added"
        elif a == b:
            key = f"unchanged_{a}"
        else:
            key = f"changed_{a}_to_{b}"
        counts[key] += 1
        by_ds[dataset_of(qa.query_id)][key] += 1
        if len(examples[key]) < 5 and not key.startswith("unchanged"):
            examples[key].append(qa.query_id)
    return {
        "split": split,
        "without_run": without.run_id,
        "with_run": with_verify.run_id,
        "counts": dict(counts),
        "counts_by_dataset": {k: dict(v) for k, v in sorted(by_ds.items())},
        "top1_verification_status": dict(verify_status),
        "examples": dict(examples),
        "notes": notes,
    }
