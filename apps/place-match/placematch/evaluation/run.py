"""End-to-end evaluation of pipeline RunResult files against a benchmark.

Usage::

    uv run python -m placematch.evaluation.run --bench data/bench/placematch-v1 \\
        --runs gemini=runs/a/results.json megaloc=runs/b/results.json \\
               gemini+verify=runs/a_verified/results.json \\
        [--thresholds runs/thresholds.json] [--splits test validation] [--out DIR] \\
        [--subset data/bench/placematch-v2/paired_subset.json] \\
        [--sets main location_disjoint robustness]

Each ``--runs`` item is ``METHOD=PATH`` (or just ``PATH``; the method is then the backend
family plus ``+verify`` when the run's stored decisions used verification).

Without ``--thresholds`` the decisions stored in each run are evaluated as they are. With
``--thresholds`` decisions are recomputed with ``placematch.decide.apply_decisions``;
methods whose name contains ``+verify`` use verification, the others do not (so one
verified run file can be passed twice, as ``gemini=...`` and ``gemini+verify=...``).
For every pair ``X`` / ``X+verify`` the effect of verification on decisions is added to
the ``X+verify`` metrics (``extra.verification_effect``).

``--subset`` restricts the evaluated queries to the ids in a JSON file (``query_ids``,
``variant_ids`` + ``source_query_ids``, or a plain list). ``--sets`` chooses evaluation
sets: ``main`` (default; every label not in the robustness set, i.e. the v1 behaviour),
``location_disjoint``, ``robustness`` (variants plus their real sources) or ``all``.
Each (split, set) gets its own MethodMetrics with ``extra.eval_set``. The subset filter
applies to every set: use ``robustness_vertex_subset.json`` (variants + sources) with
``--sets robustness``; ``paired_subset.json`` holds no variants.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from placematch.evaluation import report as report_mod
from placematch.evaluation.metrics import evaluate, verification_effect
from placematch.schemas import EvalReport, LabelSet, Manifest, RunResult, ThresholdSet

EVAL_SETS = ("main", "location_disjoint", "robustness", "all")


def load_subset(path: Path) -> set[str]:
    import json

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, list):
        return set(data)
    ids = set()
    for key in ("query_ids", "variant_ids", "source_query_ids"):
        ids |= set(data.get(key, []))
    if not ids:
        raise ValueError(f"{path}: no query_ids / variant_ids / source_query_ids")
    return ids


def select_labels(labels: LabelSet, eval_set: str, subset: set[str] | None = None) -> LabelSet:
    """Labels of one evaluation set (optionally restricted to ``subset`` query ids)."""
    if eval_set not in EVAL_SETS:
        raise ValueError(f"unknown eval set {eval_set!r}; choose from {EVAL_SETS}")
    if eval_set == "main":
        keep = [lb for lb in labels.labels if "robustness" not in lb.eval_sets]
    elif eval_set == "robustness":
        rob = [lb for lb in labels.labels if "robustness" in lb.eval_sets]
        src = {lb.derived_from for lb in rob}
        keep = rob + [lb for lb in labels.labels if lb.query_id in src]
    elif eval_set == "all":
        keep = list(labels.labels)
    else:
        keep = [lb for lb in labels.labels if eval_set in lb.eval_sets]
    if subset is not None:
        keep = [lb for lb in keep if lb.query_id in subset]
    return labels.model_copy(update={"labels": keep})


def load_run(path: Path) -> RunResult:
    return RunResult.model_validate_json(Path(path).read_text(encoding="utf-8"))


def method_name(run: RunResult) -> str:
    fam = run.backend.split(":", 1)[0]
    dec = run.settings.get("decisions") or {}
    return fam + ("+verify" if dec.get("use_verification") else "")


def parse_runs(items: list[str]) -> list[tuple[str | None, Path]]:
    out = []
    for it in items:
        if "=" in it and not Path(it).exists():
            name, path = it.split("=", 1)
            out.append((name, Path(path)))
        else:
            out.append((None, Path(it)))
    return out


def evaluate_runs(
    runs: dict[str, RunResult],
    labels: LabelSet,
    *,
    splits: list[str],
    manifest_path: str,
    labels_path: str,
    thresholds: ThresholdSet | None = None,
    thresholds_path: str | None = None,
    eval_sets: list[str] | None = None,
    subset: set[str] | None = None,
    subset_path: str | None = None,
    n_boot: int = 1000,
) -> EvalReport:
    notes: list[str] = []
    if thresholds is not None:
        from placematch.decide import apply_decisions  # pipeline module (Subagent 1)

        runs = {
            name: apply_decisions(run, thresholds, use_verification="+verify" in name)
            for name, run in runs.items()
        }
        notes.append(f"decisions recomputed with thresholds {thresholds.calibrated_on}")
        if any(s == "validation" for s in splits) and "validation" in thresholds.calibrated_on:
            notes.append(
                "validation-split numbers use thresholds calibrated on that split; only "
                "test-split numbers are an unbiased estimate"
            )
    label_ids = {lb.query_id for lb in labels.labels}
    sets = eval_sets or ["main"]
    if subset is not None:
        notes.append(f"queries restricted to {len(subset)} ids from {subset_path or 'subset'}")
    methods = []
    for eval_set in sets:
        lab = select_labels(labels, eval_set, subset)
        for split in splits:
            for name, run in runs.items():
                m = evaluate(run, lab, split, name, n_boot=n_boot)  # type: ignore[arg-type]
                m.extra["eval_set"] = eval_set
                base = name.replace("+verify", "")
                if "+verify" in name and base in runs:
                    m.extra["verification_effect"] = verification_effect(
                        runs[base],
                        run,
                        lab,
                        split,  # type: ignore[arg-type]
                    )
                methods.append(m)
    for name, run in runs.items():
        extra_ids = {q.query_id for q in run.queries} - label_ids
        if extra_ids:
            notes.append(f"{name}: {len(extra_ids)} run queries have no label (ignored)")
    return EvalReport(
        manifest=manifest_path,
        labels=labels_path,
        thresholds=thresholds_path,
        methods=methods,
        notes=notes,
    )


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m placematch.evaluation.run")
    ap.add_argument("--bench", type=Path, required=True, help="dir with manifest/labels.json")
    ap.add_argument("--runs", nargs="+", required=True, help="METHOD=results.json or path")
    ap.add_argument("--thresholds", type=Path, default=None)
    ap.add_argument("--splits", nargs="+", default=["test", "validation"], help="also: development")
    ap.add_argument("--subset", type=Path, default=None, help="JSON with query ids")
    ap.add_argument("--sets", nargs="+", default=["main"], choices=EVAL_SETS)
    ap.add_argument("--n-boot", type=int, default=1000, help="bootstrap resamples (0: no CIs)")
    ap.add_argument("--out", type=Path, default=None, help="default: <bench>/eval")
    args = ap.parse_args(argv)

    manifest_path = args.bench / "manifest.json"
    labels_path = args.bench / "labels.json"
    Manifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))  # sanity check
    labels = LabelSet.model_validate_json(labels_path.read_text(encoding="utf-8"))
    runs: dict[str, RunResult] = {}
    for name, path in parse_runs(args.runs):
        run = load_run(path)
        key = name or method_name(run)
        if key in runs:
            raise SystemExit(f"duplicate method name {key!r}; use METHOD=PATH")
        runs[key] = run
    th = (
        ThresholdSet.model_validate_json(args.thresholds.read_text(encoding="utf-8"))
        if args.thresholds
        else None
    )
    rep = evaluate_runs(
        runs,
        labels,
        splits=args.splits,
        manifest_path=str(manifest_path),
        labels_path=str(labels_path),
        thresholds=th,
        thresholds_path=str(args.thresholds) if args.thresholds else None,
        eval_sets=args.sets,
        subset=load_subset(args.subset) if args.subset else None,
        subset_path=str(args.subset) if args.subset else None,
        n_boot=args.n_boot,
    )
    out = args.out or (args.bench / "eval")
    report_mod.write(rep, out)
    print(f"wrote {out}/metrics.json, metrics.csv, report.md")
    for m in rep.methods:
        print(
            f"{m.extra.get('eval_set', 'main'):17s} "
            f"{m.split:10s} {m.method:16s} n={m.n_queries:3d} R@1={m.recall_at_1} "
            f"R@5={m.recall_at_5} FAR={m.false_acceptance_rate} prec={m.accepted_precision}"
        )


if __name__ == "__main__":
    main()
