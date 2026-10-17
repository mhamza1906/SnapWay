"""Static visual failure gallery and a fixed human review sheet (CSV + HTML).

* ``failures.html``: for each failure category (wrong accept of a query that has a valid
  reference, false accept of a query without one, accepted ambiguous reference, Recall@1
  miss, valid query rejected) up to ``per_category`` queries with their top candidates,
  cosine, verification and the label of every candidate.
* ``review_sheet.csv`` / ``review_sheet.html``: a fixed sample (seeded) of successes
  (correct accepts), failures and ambiguous pairs. The ``reviewer_*`` columns are empty
  for a person to fill in. ``inspection_status`` states what happened so far: never
  "human reviewed" unless a person filled the sheet; agent-only inspection is marked as
  such.

Thumbnails are written next to the HTML (``thumbs/``) so the folder is self-contained.

CLI::

    uv run python -m placematch.evaluation.gallery --bench data/bench/placematch-v2 \\
        --run METHOD=results.json [--thresholds ...] --split test --out <dir>
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
from pathlib import Path

from PIL import Image

from placematch.evaluation.metrics import acceptance, classify, dataset_of, is_synthetic
from placematch.schemas import LabelSet, Manifest, QueryLabel, QueryResult, RunResult

REVIEW_COLUMNS = [
    "sample_id",
    "category",
    "split",
    "dataset",
    "query_id",
    "reference_id",
    "auto_label",
    "label_method",
    "model_method",
    "model_outcome",
    "model_rank",
    "cosine",
    "verification_status",
    "verification_inliers",
    "inspection_status",
    "query_path",
    "reference_path",
    "reviewer_decision",  # positive / ambiguous / negative / cannot tell
    "reviewer_initials",
    "review_date",
    "reviewer_notes",
]
FAILURE_CATEGORIES = (
    "wrong_accepts_with_reference",
    "false_accepts_no_reference",
    "ambiguous_accepts",
    "recall_at_1_miss",
    "rejected_valid",
)


def _seeded(items: list[str], salt: str, seed: int) -> list[str]:
    return sorted(items, key=lambda s: hashlib.sha256(f"{seed}:{salt}:{s}".encode()).hexdigest())


def label_of(ref: str, lb: QueryLabel) -> str:
    return "positive" if ref in lb.positives else "ambiguous" if ref in lb.ambiguous else "negative"


def inspection_status(lb: QueryLabel) -> str:
    if lb.reviewed:
        return "human reviewed (recorded in labels)"
    if lb.agent_inspected:
        return "agent-only inspection; NOT human reviewed"
    return "not inspected; automatic label"


class Thumbs:
    def __init__(self, out_dir: Path, height: int = 200) -> None:
        self.dir = out_dir / "thumbs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.height = height

    def get(self, src: Path) -> str:
        name = hashlib.sha1(str(src).encode()).hexdigest()[:16] + ".jpg"
        dst = self.dir / name
        if not dst.is_file():
            try:
                im = Image.open(src).convert("RGB")
                w = max(1, round(im.width * self.height / im.height))
                im.resize((w, self.height)).save(dst, quality=82)
            except OSError:
                return ""
        return f"thumbs/{name}"


def _categories(q: QueryResult, lb: QueryLabel) -> list[str]:
    cats = []
    c = classify(q, lb)
    if c in FAILURE_CATEGORIES:
        cats.append(c)
    if lb.has_valid_reference:
        amb = set(lb.ambiguous)
        ranked = [x.reference_id for x in sorted(q.candidates, key=lambda x: x.rank)]
        ranked = [r for r in ranked if r not in amb]
        if not ranked or ranked[0] not in lb.positives:
            cats.append("recall_at_1_miss")
    return cats


def build(
    run: RunResult,
    method: str,
    labels: LabelSet,
    manifest: Manifest,
    manifest_path: Path,
    out_dir: Path,
    *,
    splits: list[str],
    per_category: int = 20,
    n_success: int = 30,
    n_failure: int = 30,
    n_ambiguous: int = 30,
    top_n: int = 3,
    seed: int = 0,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    thumbs = Thumbs(out_dir)
    by = {e.image_id: e for e in manifest.entries}
    lab = {lb.query_id: lb for lb in labels.labels if lb.split in splits and not is_synthetic(lb)}
    results = {q.query_id: q for q in run.queries if q.query_id in lab}

    def path(i: str) -> Path:
        return manifest.resolve(by[i], manifest_path)

    cats: dict[str, list[str]] = {c: [] for c in FAILURE_CATEGORIES}
    successes, failures = [], []
    for qid, q in results.items():
        cs = _categories(q, lab[qid])
        for c in cs:
            cats[c].append(qid)
        if cs:
            failures.append(qid)
        if acceptance(q, lab[qid]) == "correct":
            successes.append(qid)

    # ---------------------------------------------------------------- failure gallery
    parts = [
        "<!doctype html><meta charset='utf-8'><title>Failure gallery</title>",
        "<style>body{font:14px system-ui;margin:16px}img{height:160px;margin:2px}"
        ".c{display:inline-block;vertical-align:top;margin-right:6px;font-size:12px}"
        ".positive{border:4px solid #2a7}.ambiguous{border:4px solid #e90}"
        ".negative{border:4px solid #c33}.q{border:4px solid #555}"
        "section{border-top:1px solid #ccc;margin-top:12px}</style>",
        f"<h1>Failure gallery: {html.escape(method)} ({html.escape(', '.join(splits))})</h1>",
        "<p>Border: green = labelled positive, orange = ambiguous, red = negative. Labels are "
        "automatic unless the query says otherwise; nothing here is a human review.</p>",
    ]
    shown = {}
    for c in FAILURE_CATEGORIES:
        ids = _seeded(cats[c], c, seed)[:per_category]
        shown[c] = {"total": len(cats[c]), "shown": len(ids)}
        parts.append(f"<h2>{c} ({len(cats[c])}, showing {len(ids)})</h2>")
        for qid in ids:
            q, lb = results[qid], lab[qid]
            dec = q.decision
            head = (
                f"<b>{html.escape(qid)}</b> - outcome {dec.outcome if dec else 'none'}; "
                f"accepted {html.escape(str(dec.reference_id if dec else None))}; "
                f"{inspection_status(lb)}; label: {html.escape(lb.method)}"
            )
            cells = [f"<div class='c'><img class='q' src='{thumbs.get(path(qid))}'><br>query</div>"]
            for cand in sorted(q.candidates, key=lambda x: x.rank)[:top_n]:
                lab_c = label_of(cand.reference_id, lb)
                v = cand.verification
                vtxt = f"{v.status}, {v.n_inliers} inl" if v else "not verified"
                src = thumbs.get(path(cand.reference_id)) if cand.reference_id in by else ""
                cells.append(
                    f"<div class='c'><img class='{lab_c}' src='{src}'><br>#{cand.rank} "
                    f"cos {cand.cosine:.3f} - {lab_c}<br>{html.escape(vtxt)}<br>"
                    f"{html.escape(cand.reference_id)}</div>"
                )
            if lb.positives and lb.positives[0] not in [x.reference_id for x in q.candidates]:
                p = lb.positives[0]
                cells.append(
                    f"<div class='c'><img class='positive' src='{thumbs.get(path(p))}'><br>"
                    f"best labelled positive (not in top-k)<br>{html.escape(p)}</div>"
                )
            parts.append(f"<section><p>{head}</p>{''.join(cells)}</section>")
    (out_dir / "failures.html").write_text("\n".join(parts), encoding="utf-8")

    # ---------------------------------------------------------------- review sheet
    rows: list[dict] = []

    def add(category: str, qid: str, ref: str | None) -> None:
        q, lb = results.get(qid), lab[qid]
        cand = next((c for c in (q.candidates if q else []) if c.reference_id == ref), None)
        v = cand.verification if cand else None
        rows.append(
            {
                "sample_id": f"S{len(rows) + 1:04d}",
                "category": category,
                "split": lb.split,
                "dataset": dataset_of(qid),
                "query_id": qid,
                "reference_id": ref or "",
                "auto_label": label_of(ref, lb) if ref else "",
                "label_method": lb.method,
                "model_method": method,
                "model_outcome": q.decision.outcome if q and q.decision else "",
                "model_rank": cand.rank if cand else "",
                "cosine": f"{cand.cosine:.4f}" if cand else "",
                "verification_status": v.status if v else "",
                "verification_inliers": v.n_inliers if v else "",
                "inspection_status": inspection_status(lb),
                "query_path": str(path(qid)),
                "reference_path": str(path(ref)) if ref and ref in by else "",
                "reviewer_decision": "",
                "reviewer_initials": "",
                "review_date": "",
                "reviewer_notes": "",
            }
        )

    for qid in _seeded(successes, "success", seed)[:n_success]:
        add("success_correct_accept", qid, results[qid].decision.reference_id)
    for qid in _seeded(failures, "failure", seed)[:n_failure]:
        q = results[qid]
        if q.decision and q.decision.outcome == "likely_match":
            ref = q.decision.reference_id
        else:
            ref = q.candidates[0].reference_id if q.candidates else None
        add("failure", qid, ref)
    amb_pairs = sorted(
        f"{qid}\t{r}" for qid, lb in lab.items() if qid in results for r in lb.ambiguous
    )
    for pair in _seeded(amb_pairs, "ambiguous", seed)[:n_ambiguous]:
        qid, ref = pair.split("\t")
        add("ambiguous_pair", qid, ref)
    with (out_dir / "review_sheet.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=REVIEW_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    h = [
        "<!doctype html><meta charset='utf-8'><title>Review sheet</title>",
        "<style>body{font:14px system-ui;margin:16px}img{height:180px}td{vertical-align:top;"
        "border-bottom:1px solid #ccc;padding:4px}</style>",
        "<h1>Human review sheet</h1>",
        f"<p>Fixed sample (seed {seed}) of {len(rows)} pairs. Fill in <code>reviewer_decision"
        "</code> (positive / ambiguous / negative / cannot tell), initials and date in "
        "<code>review_sheet.csv</code>. Until then every row is <b>not human reviewed</b>; "
        "agent-only inspection is marked in <i>inspection status</i>.</p><table>",
        "<tr><th>id</th><th>query</th><th>reference</th><th>details</th>"
        "<th>reviewer decision</th></tr>",
    ]
    for r in rows:
        qimg = thumbs.get(Path(r["query_path"]))
        rimg = thumbs.get(Path(r["reference_path"])) if r["reference_path"] else ""
        det = "<br>".join(
            f"{k}: {html.escape(str(r[k]))}"
            for k in REVIEW_COLUMNS[1:15]
            if k not in ("query_id",) and r[k] != ""
        )
        h.append(
            f"<tr><td>{r['sample_id']}</td><td><img src='{qimg}'><br>"
            f"{html.escape(r['query_id'])}</td><td>"
            + (f"<img src='{rimg}'>" if rimg else "(none)")
            + f"</td><td>{det}</td><td>____________</td></tr>"
        )
    h.append("</table>")
    (out_dir / "review_sheet.html").write_text("\n".join(h), encoding="utf-8")
    return {"failure_categories": shown, "review_rows": len(rows), "out_dir": str(out_dir)}


def main(argv: list[str] | None = None) -> None:
    from placematch.evaluation.run import load_run, parse_runs

    ap = argparse.ArgumentParser(prog="python -m placematch.evaluation.gallery")
    ap.add_argument("--bench", type=Path, required=True)
    ap.add_argument("--run", required=True, help="METHOD=results.json")
    ap.add_argument("--thresholds", type=Path, default=None)
    ap.add_argument("--split", nargs="+", default=["test"])
    ap.add_argument("--per-category", type=int, default=20)
    ap.add_argument("--n-sample", type=int, default=30, help="per review category")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    (name, path), *_ = parse_runs([args.run])
    run = load_run(path)
    method = name or run.backend
    if args.thresholds:
        from placematch.decide import apply_decisions
        from placematch.schemas import ThresholdSet

        th = ThresholdSet.model_validate_json(args.thresholds.read_text())
        run = apply_decisions(run, th, use_verification="+verify" in method)
    mp = args.bench / "manifest.json"
    info = build(
        run,
        method,
        LabelSet.model_validate_json((args.bench / "labels.json").read_text()),
        Manifest.model_validate_json(mp.read_text()),
        mp,
        args.out,
        splits=args.split,
        per_category=args.per_category,
        n_success=args.n_sample,
        n_failure=args.n_sample,
        n_ambiguous=args.n_sample,
        seed=args.seed,
    )
    print(info)


if __name__ == "__main__":
    main()
