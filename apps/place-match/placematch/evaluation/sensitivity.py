"""Label-boundary sensitivity: recompute labels from stored raw scores, then the metrics.

The positive / ambiguous boundaries are a choice. This module re-derives every label
under several reasonable boundary choices from the *stored* raw co-visibility scores
(bench-v1 ``overlaps.json``, v2 ``raw_scores.json``) without touching the stored labels,
and reports the metrics of each variant side by side. All variants are reported; none is
selected. Model outputs never influence a label here.

Raw score formats per query and reference: ``{"overlap": x}`` (7-Scenes, 12-Scenes,
Map-free; a bare float in bench-v1) or ``{"shared": n, "covq": a, "covr": b}`` (CLoc).
References without a stored score (other scenes / buildings, held-out places) stay
negative. 12-Scenes references of other rooms of the same site are ambiguous in the stored
labels (no score exists); variant ``cross_room_negative`` turns them negative.

Agent decisions (bench-v1 ``agent_inspection_v1.json`` pairs) are visual judgements that do
not depend on a boundary; with ``keep_agent=True`` they are re-applied on top of every
variant, otherwise variants are purely automatic.

CLI::

    uv run python -m placematch.evaluation.sensitivity --bench data/bench/placematch-v1 \\
        --runs megaloc=... gemini=... --thresholds data/calibration/thresholds.json \\
        --splits test validation --out <dir>
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path

from placematch.evaluation.metrics import compute, dataset_of, is_synthetic, pair_up
from placematch.schemas import LabelSet, QueryLabel, RunResult


@dataclass(frozen=True)
class Boundary:
    """One boundary choice per score family. ``None`` = keep the default."""

    name: str
    depth: tuple[float, float] = (0.30, 0.10)  # positive, ambiguous (overlap fraction)
    cloc_pos: tuple[int, float, float] = (50, 0.30, 0.20)  # shared, covq, covr
    cloc_amb: tuple[int, float] = (15, 0.10)  # shared, max coverage
    mapfree: tuple[float, float] = (0.20, 0.05)
    amb_as_positive: bool = False  # every ambiguous reference counts as positive
    cross_room_negative: bool = False  # 12-Scenes same-site other-room refs -> negative
    note: str = ""


DEFAULT = Boundary("default (stored boundaries)")

VARIANTS: list[Boundary] = [
    DEFAULT,
    Boundary("depth_pos0.20", depth=(0.20, 0.10), note="7-/12-Scenes positive >= 0.20"),
    Boundary("depth_pos0.40", depth=(0.40, 0.10), note="7-/12-Scenes positive >= 0.40"),
    Boundary("depth_amb0.05", depth=(0.30, 0.05), note="wider ambiguous band"),
    Boundary("depth_amb0.20", depth=(0.30, 0.20), note="narrower ambiguous band"),
    Boundary("cloc_covr0.15", cloc_pos=(50, 0.30, 0.15), note="CLoc reference coverage >= 0.15"),
    Boundary("cloc_strict", cloc_pos=(80, 0.40, 0.30), note="CLoc shared>=80, covq>=.4, covr>=.3"),
    Boundary("cloc_loose", cloc_pos=(30, 0.20, 0.10), note="CLoc shared>=30, covq>=.2, covr>=.1"),
    Boundary("cloc_amb_wide", cloc_amb=(5, 0.05), note="CLoc ambiguous shared>=5, cov>=0.05"),
    Boundary("mapfree_pos0.10", mapfree=(0.10, 0.05)),
    Boundary("mapfree_pos0.30", mapfree=(0.30, 0.05)),
    Boundary(
        "no_ambiguous_band",
        depth=(0.30, 0.30),
        cloc_amb=(10**9, 2.0),
        mapfree=(0.20, 0.20),
        note="everything below the positive boundary is negative",
    ),
    Boundary("ambiguous_as_positive", amb_as_positive=True, note="ambiguous refs count as hits"),
    Boundary(
        "cross_room_negative", cross_room_negative=True, note="12-Scenes other rooms negative"
    ),
]


def _norm(raw: dict) -> dict[str, dict]:
    return {r: ({"overlap": float(v)} if isinstance(v, int | float) else v) for r, v in raw.items()}


def relabel(label: QueryLabel, raw: dict, bd: Boundary) -> QueryLabel:
    """Re-derive positives / ambiguous of one query from its raw scores."""
    if label.method.startswith("held_out") and not bd.cross_room_negative:
        return label  # no references of the place: unaffected by any boundary
    scores = _norm(raw)
    ds = dataset_of(label.query_id)
    pos, amb = [], []
    for ref, s in scores.items():
        if "shared" in s:
            sh, cq, cr = s["shared"], s["covq"], s["covr"]
            if sh >= bd.cloc_pos[0] and cq >= bd.cloc_pos[1] and cr >= bd.cloc_pos[2]:
                pos.append(ref)
            elif sh >= bd.cloc_amb[0] and max(cq, cr) >= bd.cloc_amb[1]:
                amb.append(ref)
        else:
            p, a = bd.mapfree if ds == "mapfree" else bd.depth
            v = s["overlap"]
            if v >= p:
                pos.append(ref)
            elif v >= a:
                amb.append(ref)
    scored = set(scores)
    # references that are ambiguous without a score (12-Scenes other rooms of the site)
    unscored_amb = [r for r in label.ambiguous if r not in scored]
    if not bd.cross_room_negative:
        amb += unscored_amb
    if bd.amb_as_positive:
        pos, amb = pos + amb, []
    out = label.model_copy(deep=True)
    out.positives, out.ambiguous = sorted(pos), sorted(amb)
    out.has_valid_reference = bool(pos)
    return out


def apply_agent(label: QueryLabel, decisions: list[dict]) -> QueryLabel:
    for d in decisions:
        if d["query_id"] != label.query_id:
            continue
        ref = d["reference_id"]
        label.positives = [r for r in label.positives if r != ref]
        label.ambiguous = [r for r in label.ambiguous if r != ref]
        if d["decision"] == "positive":
            label.positives.append(ref)
        elif d["decision"] == "ambiguous":
            label.ambiguous.append(ref)
    label.has_valid_reference = bool(label.positives)
    return label


@dataclass
class SensitivityResult:
    rows: list[dict] = field(default_factory=list)
    label_changes: dict[str, dict] = field(default_factory=dict)


def label_set_for(
    labels: LabelSet, raw: dict, bd: Boundary, *, agent: list[dict] | None
) -> LabelSet:
    new = []
    for lb in labels.labels:
        src = lb.query_id.split(":synthetic:", 1)[0]
        if bd is DEFAULT and agent is not None:
            new.append(lb)  # stored labels already include the agent decisions
            continue
        r = relabel(lb, raw.get(lb.query_id, raw.get(src, {})), bd)
        if agent:
            r = apply_agent(r, agent)
        new.append(r)
    return labels.model_copy(update={"labels": new})


def _diff(a: LabelSet, b: LabelSet, split: str) -> dict:
    out = {"queries_changed": 0, "valid_to_invalid": 0, "invalid_to_valid": 0}
    bb = {lb.query_id: lb for lb in b.labels}
    for la in a.labels:
        if la.split != split or is_synthetic(la):
            continue
        lb = bb[la.query_id]
        if set(la.positives) != set(lb.positives) or set(la.ambiguous) != set(lb.ambiguous):
            out["queries_changed"] += 1
        if la.has_valid_reference and not lb.has_valid_reference:
            out["valid_to_invalid"] += 1
        if lb.has_valid_reference and not la.has_valid_reference:
            out["invalid_to_valid"] += 1
    return out


def run_sensitivity(
    runs: dict[str, RunResult],
    labels: LabelSet,
    raw: dict,
    *,
    splits: list[str],
    agent: list[dict] | None = None,
    variants: list[Boundary] = VARIANTS,
) -> SensitivityResult:
    res = SensitivityResult()
    for bd in variants:
        ls = label_set_for(labels, raw, bd, agent=agent)
        for split in splits:
            res.label_changes[f"{bd.name}|{split}"] = _diff(labels, ls, split)
            for name, run in runs.items():
                pairs, _ = pair_up(run, ls, split)  # type: ignore[arg-type]
                real = [(q, lb) for q, lb in pairs if not is_synthetic(lb)]
                d = compute(real)
                row = {
                    "variant": bd.name,
                    "agent_decisions_reapplied": agent is not None,
                    "note": bd.note,
                    "split": split,
                    "method": name,
                    **{
                        k: d[k]
                        for k in (
                            "n_queries",
                            "n_with_reference",
                            "n_without_reference",
                            "n_ambiguous_only",
                            "recall_at_1",
                            "recall_at_5",
                            "false_acceptance_rate",
                            "far_strict",
                            "accepted_precision",
                            "precision_strict",
                            "accepted_recall",
                        )
                    },
                    "ambiguous_accepts": d["counts"]["ambiguous_accepts"],
                    "false_accepts_no_reference": d["counts"]["false_accepts_no_reference"],
                    "wrong_accepts_with_reference": d["counts"]["wrong_accepts_with_reference"],
                }
                by_ds = {}
                for ds in sorted({dataset_of(q.query_id) for q, _ in real}):
                    sub = [(q, lb) for q, lb in real if dataset_of(q.query_id) == ds]
                    dd = compute(sub)
                    by_ds[ds] = {
                        k: dd[k]
                        for k in ("n_with_reference", "recall_at_1", "false_acceptance_rate")
                    }
                row["by_dataset"] = by_ds
                res.rows.append(row)
    return res


def ranges(rows: list[dict]) -> list[dict]:
    """Min / max of each metric over all variants, per (split, method)."""
    out = []
    keys = sorted({(r["split"], r["method"]) for r in rows})
    for split, method in keys:
        rs = [r for r in rows if r["split"] == split and r["method"] == method]
        rec = {"split": split, "method": method}
        for k in ("recall_at_1", "recall_at_5", "false_acceptance_rate", "accepted_precision"):
            vals = [r[k] for r in rs if r[k] is not None]
            rec[k] = [min(vals), max(vals)] if vals else None
        out.append(rec)
    return out


def _f(x) -> str:
    return "n/a" if x is None else f"{x:.3f}" if isinstance(x, float) else str(x)


def markdown(res: SensitivityResult, title: str) -> str:
    lines = [f"# Label-boundary sensitivity: {title}", ""]
    lines.append(
        "Every variant is reported; none is preferred. Labels are re-derived from stored raw "
        "scores only (no model output)."
    )
    lines.append("")
    head = ["variant", "agent", "split", "method", "with ref", "no ref", "amb-only", "R@1", "R@5"]
    head += ["FAR", "strict FAR", "prec", "strict prec", "amb. acc."]
    lines.append("| " + " | ".join(head) + " |")
    lines.append("|" + "---|" * len(head))
    for r in res.rows:
        cells = [
            r["variant"],
            "yes" if r["agent_decisions_reapplied"] else "no",
            r["split"],
            r["method"],
            str(r["n_with_reference"]),
            str(r["n_without_reference"]),
            str(r["n_ambiguous_only"]),
            _f(r["recall_at_1"]),
            _f(r["recall_at_5"]),
            _f(r["false_acceptance_rate"]),
            _f(r["far_strict"]),
            _f(r["accepted_precision"]),
            _f(r["precision_strict"]),
            str(r["ambiguous_accepts"]),
        ]
        lines.append("| " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("## Ranges over variants")
    lines.append("")
    lines.append("| split | method | R@1 | R@5 | FAR | precision |")
    lines.append("|---|---|---|---|---|---|")
    for r in ranges(res.rows):
        cells = [r["split"], r["method"]]
        for k in ("recall_at_1", "recall_at_5", "false_acceptance_rate", "accepted_precision"):
            v = r[k]
            cells.append("n/a" if v is None else f"{v[0]:.3f} - {v[1]:.3f}")
        lines.append("| " + " | ".join(cells) + " |")
    lines.append("")
    return "\n".join(lines)


def load_raw(bench: Path) -> dict:
    for name in ("raw_scores.json", "overlaps.json"):
        p = bench / name
        if p.is_file():
            return json.loads(p.read_text())
    raise FileNotFoundError(f"no raw_scores.json / overlaps.json in {bench}")


def main(argv: list[str] | None = None) -> None:
    from placematch.evaluation.run import load_run, parse_runs

    ap = argparse.ArgumentParser(prog="python -m placematch.evaluation.sensitivity")
    ap.add_argument("--bench", type=Path, required=True)
    ap.add_argument("--runs", nargs="+", required=True, help="METHOD=results.json")
    ap.add_argument("--thresholds", type=Path, default=None)
    ap.add_argument("--splits", nargs="+", default=["test", "validation"])
    ap.add_argument("--agent", type=Path, default=None, help="agent decisions JSON to re-apply")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    labels = LabelSet.model_validate_json((args.bench / "labels.json").read_text())
    raw = load_raw(args.bench)
    runs = {name or path.stem: load_run(path) for name, path in parse_runs(args.runs)}
    if args.thresholds:
        from placematch.decide import apply_decisions
        from placematch.schemas import ThresholdSet

        th = ThresholdSet.model_validate_json(args.thresholds.read_text())
        runs = {n: apply_decisions(r, th, use_verification="+verify" in n) for n, r in runs.items()}
    agent = json.loads(args.agent.read_text()) if args.agent else None
    res = run_sensitivity(runs, labels, raw, splits=args.splits, agent=agent)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "sensitivity.json").write_text(
        json.dumps(
            {"rows": res.rows, "ranges": ranges(res.rows), "label_changes": res.label_changes},
            indent=1,
        )
    )
    (args.out / "sensitivity.md").write_text(markdown(res, str(args.bench)))
    print(f"wrote {args.out}/sensitivity.json, sensitivity.md")


if __name__ == "__main__":
    main()
