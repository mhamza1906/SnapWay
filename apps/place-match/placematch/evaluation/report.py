"""Write an EvalReport as metrics.json, metrics.csv and a short report.md."""

from __future__ import annotations

import csv
from pathlib import Path

from placematch.evaluation.metrics import METRIC_DEFINITIONS
from placematch.schemas import EvalReport, MethodMetrics

RATE_FIELDS = [
    "recall_at_1",
    "recall_at_5",
    "false_acceptance_rate",
    "accepted_precision",
    "accepted_recall",
]
EXTRA_RATE_FIELDS = [
    "acceptance_coverage",
    "precision_strict",
    "far_strict",
    "far_absent_location",
    "far_absent_view",
]
COUNT_FIELDS = [
    "correct_accepts",
    "wrong_accepts",
    "wrong_accepts_with_reference",
    "false_accepts_no_reference",
    "ambiguous_accepts",
    "rejected_valid",
    "uncertain",
    "correct_rejections",
    "excluded_no_decision",
]
CSV_FIELDS = [
    "method",
    "split",
    "eval_set",
    "scope",
    "group",
    "n_queries",
    "n_with_reference",
    "n_without_reference",
    *RATE_FIELDS,
    "likely_match",
    "uncertain_outcome",
    "no_supported_match",
    "no_decision",
    *EXTRA_RATE_FIELDS,
    *COUNT_FIELDS,
    "r1_ci_low",
    "r1_ci_high",
    "far_ci_low",
    "far_ci_high",
    "precision_ci_low",
    "precision_ci_high",
    "ci_n_groups",
]


def _fmt(x) -> str:
    if x is None:
        return "n/a"
    if isinstance(x, float):
        return f"{x:.3f}"
    return str(x)


def _ci_txt(m: MethodMetrics, key: str) -> str:
    c = m.ci.get(key)
    if not c or c.get("low") is None:
        return ""
    flag = "!" if "warning" in c else ""
    return f" [{c['low']:.3f}, {c['high']:.3f}]{flag}"


def _row(m: MethodMetrics, scope: str, group: str, d: dict, ci: dict | None = None) -> dict:
    oc = d.get("outcome_counts", {})
    counts = d.get("counts", {})
    ci = ci or {}
    r1, far, prec = (ci.get(k, {}) for k in RATE_FIELDS[:1] + RATE_FIELDS[2:4])
    return {
        "method": m.method,
        "split": m.split,
        "eval_set": m.extra.get("eval_set", "main"),
        "scope": scope,
        "group": group,
        "n_queries": d.get("n_queries"),
        "n_with_reference": d.get("n_with_reference"),
        "n_without_reference": d.get("n_without_reference"),
        **{k: d.get(k) for k in RATE_FIELDS},
        "likely_match": oc.get("likely_match", 0),
        "uncertain_outcome": oc.get("uncertain", 0),
        "no_supported_match": oc.get("no_supported_match", 0),
        "no_decision": oc.get("no_decision", 0),
        **{k: d.get(k) for k in EXTRA_RATE_FIELDS},
        **{k: counts.get(k) for k in COUNT_FIELDS},
        "r1_ci_low": r1.get("low"),
        "r1_ci_high": r1.get("high"),
        "far_ci_low": far.get("low"),
        "far_ci_high": far.get("high"),
        "precision_ci_low": prec.get("low"),
        "precision_ci_high": prec.get("high"),
        "ci_n_groups": r1.get("n_groups"),
    }


def _overall(m: MethodMetrics) -> dict:
    return {
        "n_queries": m.n_queries,
        "n_with_reference": m.n_with_reference,
        "n_without_reference": m.n_without_reference,
        "recall_at_1": m.recall_at_1,
        "recall_at_5": m.recall_at_5,
        "false_acceptance_rate": m.false_acceptance_rate,
        "accepted_precision": m.accepted_precision,
        "accepted_recall": m.accepted_recall,
        "outcome_counts": m.outcome_counts,
        "counts": m.counts,
        **m.extra.get("decision_metrics", {}),
    }


def rows(report: EvalReport) -> list[dict]:
    out = []
    for m in report.methods:
        out.append(_row(m, "overall_real", "all", _overall(m), m.ci))
        for g, d in m.extra.get("by_dataset", {}).items():
            out.append(_row(m, "dataset_real", g, d))
        for g, d in m.extra.get("by_scene", {}).items():
            out.append(_row(m, "scene_real", g, d))
        for g, d in m.extra.get("by_eval_set", {}).items():
            out.append(_row(m, "eval_set_real", g, d))
        for g, d in m.by_condition.items():
            scope = "synthetic" if g.startswith("synthetic:") else "condition_real"
            out.append(_row(m, scope, g, d))
    return out


def _table(lines: list[str], header: list[str], body: list[list[str]]) -> None:
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join("---" for _ in header) + " |")
    lines.extend("| " + " | ".join(r) + " |" for r in body)
    lines.append("")


def _sections(report: EvalReport) -> list[tuple[str, str, list[MethodMetrics]]]:
    keys = []
    for m in report.methods:
        k = (m.split, m.extra.get("eval_set", "main"))
        if k not in keys:
            keys.append(k)
    keys.sort(key=lambda k: (k[0] != "test", k[0], k[1] != "main", k[1]))
    out = []
    for s, e in keys:
        ms = [m for m in report.methods if (m.split, m.extra.get("eval_set", "main")) == (s, e)]
        out.append((s, e, ms))
    return out


def markdown(report: EvalReport) -> str:
    lines = ["# Place-match evaluation", ""]
    lines += [f"- manifest: `{report.manifest}`", f"- labels: `{report.labels}`"]
    lines += [f"- thresholds: `{report.thresholds or 'none (decisions as stored in runs)'}`"]
    lines += [
        "- intervals: 95% cluster bootstrap by recording (`group_id`); `!` marks fewer than "
        "10 clusters (unreliable)",
        "",
    ]
    head = ["method", "n", "with ref", "no ref", "R@1", "R@5", "FAR", "prec"]
    head += ["acc. recall", "likely", "uncertain", "no match"]
    for split, eval_set, ms in _sections(report):
        title = f"{split}: real queries" + ("" if eval_set == "main" else f", set `{eval_set}`")
        lines.append(f"## {title}")
        lines.append("")
        body = []
        for m in ms:
            oc = m.outcome_counts
            body.append(
                [
                    m.method,
                    str(m.n_queries),
                    str(m.n_with_reference),
                    str(m.n_without_reference),
                    _fmt(m.recall_at_1) + _ci_txt(m, "recall_at_1"),
                    _fmt(m.recall_at_5) + _ci_txt(m, "recall_at_5"),
                    _fmt(m.false_acceptance_rate) + _ci_txt(m, "false_acceptance_rate"),
                    _fmt(m.accepted_precision) + _ci_txt(m, "accepted_precision"),
                    _fmt(m.accepted_recall),
                    str(oc.get("likely_match", 0)),
                    str(oc.get("uncertain", 0)),
                    str(oc.get("no_supported_match", 0)),
                ]
            )
        _table(lines, head, body)
        if any(m.counts for m in ms):
            lines.append(f"### {split}/{eval_set}: decision counts")
            lines.append("")
            ch = ["method", "correct acc.", "wrong acc. (valid q)", "false acc. (no ref)"]
            ch += ["ambiguous acc.", "rejected valid", "uncertain", "correct rejections"]
            ch += ["excluded", "coverage", "strict prec.", "strict FAR", "FAR absent loc."]
            body = []
            for m in ms:
                c, dm = m.counts, m.extra.get("decision_metrics", {})
                excl = c.get("excluded_no_decision", 0) + c.get("excluded_missing_in_run", 0)
                body.append(
                    [
                        m.method,
                        *[
                            str(c.get(k, 0))
                            for k in (
                                "correct_accepts",
                                "wrong_accepts_with_reference",
                                "false_accepts_no_reference",
                                "ambiguous_accepts",
                                "rejected_valid",
                                "uncertain",
                                "correct_rejections",
                            )
                        ],
                        str(excl),
                        _fmt(dm.get("acceptance_coverage")),
                        _fmt(dm.get("precision_strict")),
                        _fmt(dm.get("far_strict")),
                        _fmt(dm.get("far_absent_location")),
                    ]
                )
            _table(lines, ch, body)
        sub = ["method", "group", "n", "R@1", "R@5", "FAR", "prec"]
        for title, getter in (
            ("by dataset (real)", lambda m: m.extra.get("by_dataset", {}).items()),
            ("by evaluation set (real)", lambda m: m.extra.get("by_eval_set", {}).items()),
            (
                "by condition (real)",
                lambda m: [(k, v) for k, v in m.by_condition.items() if k.startswith("real:")],
            ),
            (
                "synthetic edits (kept separate)",
                lambda m: [(k, v) for k, v in m.by_condition.items() if k.startswith("synth")],
            ),
        ):
            body = []
            for m in ms:
                for g, d in getter(m):
                    body.append(
                        [
                            m.method,
                            g,
                            str(d["n_queries"]),
                            _fmt(d["recall_at_1"]),
                            _fmt(d["recall_at_5"]),
                            _fmt(d["false_acceptance_rate"]),
                            _fmt(d["accepted_precision"]),
                        ]
                    )
            if body:
                lines.append(f"### {split}/{eval_set}: {title}")
                lines.append("")
                _table(lines, sub, body)
        effects = [
            (m.method, m.extra["verification_effect"])
            for m in ms
            if "verification_effect" in m.extra
        ]
        if effects:
            lines.append(f"### {split}/{eval_set}: effect of geometric verification on decisions")
            lines.append("")
            keys = ["correct_rescued", "correct_rejected_or_downgraded", "wrong_removed"]
            keys.append("wrong_added")
            body = [
                [name, *[str(e["counts"].get(k, 0)) for k in keys]]
                + [str(e["top1_verification_status"])]
                for name, e in effects
            ]
            _table(lines, ["method", *keys, "top-1 verification status"], body)
        cost = []
        for m in ms:
            rs = m.extra.get("run_stats", {})
            ops = m.extra.get("operations", {})
            tot = ops.get("per_query_timings", {}).get("total", {})
            usd = (ops.get("cost_estimate") or {}).get("usd")
            cost.append(
                [
                    m.method,
                    str(m.api_requests),
                    str(ops.get("http_attempts", 0)),
                    str(m.cache_hits),
                    _fmt(rs.get("cache_hit_rate")),
                    _fmt(tot.get("median_s")),
                    _fmt(tot.get("p95_s")),
                    _fmt(ops.get("throughput_images_per_s")),
                    _fmt(ops.get("peak_rss_mb")),
                    _fmt(usd),
                ]
            )
        lines.append(f"### {split}/{eval_set}: operations (whole run)")
        lines.append("")
        _table(
            lines,
            ["method", "API requests", "HTTP attempts", "cache hits", "hit rate"]
            + ["query total median s", "p95 s", "images/s", "peak RSS MB", "est. USD"],
            cost,
        )
    lines.append("## Definitions")
    lines.append("")
    lines.append(METRIC_DEFINITIONS)
    lines.append("")
    if report.notes:
        lines.append("## Notes")
        lines.append("")
        lines.extend(f"- {n}" for n in report.notes)
        lines.append("")
    return "\n".join(lines)


def write(report: EvalReport, out_dir: Path) -> None:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metrics.json").write_text(report.model_dump_json(indent=1), encoding="utf-8")
    with (out_dir / "metrics.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for r in rows(report):
            w.writerow({k: ("" if v is None else v) for k, v in r.items()})
    (out_dir / "report.md").write_text(markdown(report), encoding="utf-8")
