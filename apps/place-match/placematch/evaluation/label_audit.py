"""Label audit: ambiguous-band statistics, excluded denominators and accepted-ambiguous cases.

Reads a benchmark (labels + raw scores) and decision runs, and writes ``audit.json`` with:

* per split: how many queries have ambiguous references, how many are "ambiguous only"
  (no positive, at least one ambiguous reference), ambiguous references per query;
* per method and split: queries removed from the FAR denominator because an ambiguous
  reference was accepted, accepted ambiguous references among queries with a valid
  reference (removed from precision), and Recall candidates skipped as ambiguous;
* every accepted ambiguous case with its raw co-visibility scores, which boundary it
  missed, and the verification evidence of the accepted candidate - as a case list for
  inspection. Model evidence is reported next to the label; it is never used to change it.

CLI::

    uv run python -m placematch.evaluation.label_audit --bench data/bench/placematch-v1 \\
        --runs megaloc=... --thresholds ... --out <dir>
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from placematch.evaluation.metrics import acceptance, dataset_of, is_synthetic, pair_up
from placematch.evaluation.sensitivity import _norm, load_raw
from placematch.schemas import LabelSet, RunResult

CLOC_POS = {"shared": 50, "covq": 0.30, "covr": 0.20}


def missed_boundary(raw: dict) -> list[str]:
    """Which positive criteria an ambiguous reference failed."""
    if "shared" in raw:
        return [f"{k}<{v}" for k, v in CLOC_POS.items() if raw[k] < v]
    return [f"overlap {raw['overlap']:.3f} < positive boundary"]


def label_stats(labels: LabelSet, split: str) -> dict:
    real = [lb for lb in labels.labels if lb.split == split and not is_synthetic(lb)]
    c: Counter = Counter()
    per_ds: dict[str, Counter] = {}
    for lb in real:
        ds = dataset_of(lb.query_id)
        d = per_ds.setdefault(ds, Counter())
        status = (
            "with_valid_reference"
            if lb.has_valid_reference
            else "ambiguous_only"
            if lb.ambiguous
            else "no_valid_reference"
        )
        c[status] += 1
        d[status] += 1
        if lb.ambiguous:
            c["queries_with_ambiguous_refs"] += 1
            d["queries_with_ambiguous_refs"] += 1
        c["ambiguous_refs_total"] += len(lb.ambiguous)
        c["agent_inspected"] += lb.agent_inspected
        c["agent_override"] += "+agent_override" in lb.method
    return {"n_real_queries": len(real), **c, "by_dataset": {k: dict(v) for k, v in per_ds.items()}}


def run_stats(run: RunResult, labels: LabelSet, split: str, raw: dict) -> dict:
    pairs, _ = pair_up(run, labels, split)  # type: ignore[arg-type]
    real = [(q, lb) for q, lb in pairs if not is_synthetic(lb)]
    out: Counter = Counter()
    cases = []
    for q, lb in real:
        amb = set(lb.ambiguous)
        ranked = sorted(q.candidates, key=lambda c: c.rank)
        if lb.has_valid_reference and ranked and ranked[0].reference_id in amb:
            out["valid_queries_top1_ambiguous_skipped_in_recall"] += 1
        a = acceptance(q, lb)
        if a != "ambiguous":
            continue
        ref = q.decision.reference_id  # type: ignore[union-attr]
        if lb.has_valid_reference:
            out["ambiguous_accepts_valid_query_excluded_from_precision"] += 1
        else:
            out["ambiguous_accepts_no_ref_query_excluded_from_FAR_denominator"] += 1
        cand = next((c for c in ranked if c.reference_id == ref), None)
        v = cand.verification if cand else None
        r = _norm(raw.get(lb.query_id, {})).get(ref, {})
        cases.append(
            {
                "query_id": lb.query_id,
                "split": split,
                "has_valid_reference": lb.has_valid_reference,
                "accepted_reference": ref,
                "rank": cand.rank if cand else None,
                "cosine": cand.cosine if cand else None,
                "raw_scores": r,
                "missed_positive_criteria": missed_boundary(r) if r else ["no raw score"],
                "verification": (
                    {
                        "status": v.status,
                        "inliers": v.n_inliers,
                        "inlier_ratio": round(v.inlier_ratio, 3),
                        "coverage_query": round(v.coverage_query, 3),
                        "coverage_reference": round(v.coverage_reference, 3),
                    }
                    if v
                    else None
                ),
                "agent_inspected": lb.agent_inspected,
                "label_method": lb.method,
            }
        )
    return {"counts": dict(out), "accepted_ambiguous_cases": cases}


def audit(runs: dict[str, RunResult], labels: LabelSet, raw: dict, splits: list[str]) -> dict:
    return {
        "labels": {s: label_stats(labels, s) for s in splits},
        "runs": {
            name: {s: run_stats(r, labels, s, raw) for s in splits} for name, r in runs.items()
        },
        "note": (
            "Model outputs are listed next to the labels for inspection only; no label is "
            "changed because a model accepted it or verification found inliers."
        ),
    }


def main(argv: list[str] | None = None) -> None:
    from placematch.evaluation.run import load_run, parse_runs

    ap = argparse.ArgumentParser(prog="python -m placematch.evaluation.label_audit")
    ap.add_argument("--bench", type=Path, required=True)
    ap.add_argument("--runs", nargs="+", required=True)
    ap.add_argument("--thresholds", type=Path, default=None)
    ap.add_argument("--splits", nargs="+", default=["test", "validation"])
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    labels = LabelSet.model_validate_json((args.bench / "labels.json").read_text())
    runs = {n or p.stem: load_run(p) for n, p in parse_runs(args.runs)}
    if args.thresholds:
        from placematch.decide import apply_decisions
        from placematch.schemas import ThresholdSet

        th = ThresholdSet.model_validate_json(args.thresholds.read_text())
        runs = {n: apply_decisions(r, th, use_verification="+verify" in n) for n, r in runs.items()}
    res = audit(runs, labels, load_raw(args.bench), args.splits)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "audit.json").write_text(json.dumps(res, indent=1))
    print(f"wrote {args.out}/audit.json")


if __name__ == "__main__":
    main()
