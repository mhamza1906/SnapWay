"""Gallery-size and distractor sweeps from saved index vectors (no re-embedding).

A run directory holds ``index/<slug>/{references,queries}`` written by the pipeline
(:class:`placematch.backends.base.EmbeddingIndex`). For a *fixed* query set this module
retrieves against *nested* reference subsets and reports retrieval quality per step:

* **gallery-size sweep**: base = every reference of the query set's locations (so each
  valid query keeps its positives), then distractor references (other locations) are
  added in one fixed seeded order; each step contains the previous one.
* **distractor sweep**: same base, then distractors added by similarity tier: (1) other
  locations of the same site (another floor / room of the same building), (2) other
  locations of the same dataset family, (3) other datasets. Within a tier the order is
  seeded; steps are nested.

Per step: Recall@1/5 over queries with a valid reference (ambiguous references removed from
the ranking, as in ``metrics``), the top-1 cosine of queries without a valid reference
(median / p95), and - if a ThresholdSet for the same backend key is given - a cosine-only
acceptance rate (top-1 cosine >= ``accept_cosine``; margin and verification are not
applied here, so this is not the pipeline's decision FAR).

CLI::

    uv run python -m placematch.evaluation.scaling --bench data/bench/placematch-v2 \\
        --run-dir runs/v2/megaloc --split validation [--thresholds ...] --out <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from placematch.backends.base import EmbeddingIndex
from placematch.schemas import LabelSet, Manifest, ThresholdSet

DEFAULT_STEPS = 8


def load_indexes(run_dir: Path, slug: str | None = None) -> tuple[EmbeddingIndex, EmbeddingIndex]:
    root = Path(run_dir) / "index"
    slugs = sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    if slug is None:
        if len(slugs) != 1:
            raise ValueError(f"{root}: choose --slug from {slugs}")
        slug = slugs[0]
    refs = EmbeddingIndex.load(root / slug / "references")
    qs = EmbeddingIndex.load(root / slug / "queries")
    refs.check_compatible(qs)
    return refs, qs


def _order(ids: list[str], salt: str, seed: int) -> list[str]:
    return sorted(ids, key=lambda s: hashlib.sha256(f"{seed}:{salt}:{s}".encode()).hexdigest())


def _site(e) -> str:
    return e.extra.get("site") or e.location_id or e.scene_id


def retrieve_metrics(
    q_vecs: np.ndarray,
    q_ids: list[str],
    r_vecs: np.ndarray,
    r_ids: list[str],
    labels: dict,
    *,
    accept_cosine: float | None = None,
) -> dict:
    sims = q_vecs @ r_vecs.T
    k = min(sims.shape[1], 64)
    top = np.argpartition(-sims, k - 1, axis=1)[:, :k] if k < sims.shape[1] else None
    hits1 = hits5 = n_valid = 0
    absent_top1: list[float] = []
    accepted_no_ref = 0
    accepted_correct = 0
    for i, qid in enumerate(q_ids):
        lb = labels[qid]
        cand = top[i] if top is not None else np.arange(sims.shape[1])
        cand = cand[np.argsort(-sims[i, cand])]
        amb = set(lb.ambiguous)
        ranked = [(r_ids[j], float(sims[i, j])) for j in cand if r_ids[j] not in amb]
        if lb.has_valid_reference:
            n_valid += 1
            pos = set(lb.positives)
            hits1 += any(r in pos for r, _ in ranked[:1])
            hits5 += any(r in pos for r, _ in ranked[:5])
            if accept_cosine is not None and ranked and ranked[0][1] >= accept_cosine:
                accepted_correct += ranked[0][0] in pos
        elif ranked:
            absent_top1.append(ranked[0][1])
            if accept_cosine is not None and ranked[0][1] >= accept_cosine:
                accepted_no_ref += 1
    n_absent = sum(1 for q in q_ids if not labels[q].has_valid_reference)
    out = {
        "n_references": len(r_ids),
        "n_queries": len(q_ids),
        "n_with_reference": n_valid,
        "n_without_reference": n_absent,
        "recall_at_1": hits1 / n_valid if n_valid else None,
        "recall_at_5": hits5 / n_valid if n_valid else None,
        "no_ref_top1_cosine_median": float(np.median(absent_top1)) if absent_top1 else None,
        "no_ref_top1_cosine_p95": float(np.quantile(absent_top1, 0.95)) if absent_top1 else None,
    }
    if accept_cosine is not None:
        out["cosine_only_accept_rate_no_ref"] = accepted_no_ref / n_absent if n_absent else None
        out["cosine_only_correct_accept_rate"] = accepted_correct / n_valid if n_valid else None
        out["accept_cosine"] = accept_cosine
    return out


def sweeps(
    manifest: Manifest,
    labels: LabelSet,
    refs: EmbeddingIndex,
    queries: EmbeddingIndex,
    *,
    split: str,
    eval_set: str = "main",
    subset: set[str] | None = None,
    steps: int = DEFAULT_STEPS,
    seed: int = 0,
    accept_cosine: float | None = None,
) -> dict:
    from placematch.evaluation.run import select_labels

    lab = {lb.query_id: lb for lb in select_labels(labels, eval_set, subset).labels}
    by = {e.image_id: e for e in manifest.entries}
    q_pos = {qid: i for i, qid in enumerate(queries.image_ids)}
    q_ids = sorted(q for q, lb in lab.items() if lb.split == split and q in q_pos)
    if not q_ids:
        raise ValueError("no queries of this split / set are in the query index")
    missing = sorted(q for q, lb in lab.items() if lb.split == split and q not in q_pos)
    r_pos = {rid: i for i, rid in enumerate(refs.image_ids)}
    all_refs = [r for r in refs.image_ids if r in by]
    q_locs = {by[q].location_id for q in q_ids}
    q_sites = {_site(by[q]) for q in q_ids}
    q_datasets = {by[q].dataset for q in q_ids}
    base = [r for r in all_refs if by[r].location_id in q_locs]
    distract = [r for r in all_refs if by[r].location_id not in q_locs]
    qv = queries.vectors[[q_pos[q] for q in q_ids]]

    def run(ids: list[str]) -> dict:
        rv = refs.vectors[[r_pos[r] for r in ids]]
        return retrieve_metrics(qv, q_ids, rv, ids, lab, accept_cosine=accept_cosine)

    def nested(order: list[str], tiers: dict[str, str] | None = None) -> list[dict]:
        res = []
        n = len(order)
        cuts = sorted({0, n, *[round(n * (i + 1) / steps) for i in range(steps)]})
        for c in cuts:
            ids = base + order[:c]
            rec = {"n_distractors": c, **run(ids)}
            if tiers is not None:
                comp: dict[str, int] = {}
                for r in order[:c]:
                    comp[tiers[r]] = comp.get(tiers[r], 0) + 1
                rec["distractor_tiers"] = comp
            res.append(rec)
        return res

    size_order = _order(distract, "gallery", seed)
    tier = {}
    for r in distract:
        e = by[r]
        tier[r] = (
            "1_same_site"
            if _site(e) in q_sites
            else "2_same_dataset"
            if e.dataset in q_datasets
            else "3_other_dataset"
        )
    tier_order = sorted(_order(distract, "tier", seed), key=lambda r: tier[r])
    return {
        "backend_key": refs.backend_key,
        "split": split,
        "eval_set": eval_set,
        "n_queries": len(q_ids),
        "n_queries_missing_from_index": len(missing),
        "n_base_references": len(base),
        "n_distractor_pool": len(distract),
        "distractor_pool_by_tier": {
            t: sum(1 for r in distract if tier[r] == t) for t in sorted(set(tier.values()))
        },
        "seed": seed,
        "gallery_size_sweep": nested(size_order),
        "distractor_sweep": nested(tier_order, tier),
        "definition": __doc__.split("CLI::", 1)[0].strip(),
    }


def _f(x) -> str:
    return "n/a" if x is None else f"{x:.3f}" if isinstance(x, float) else str(x)


def markdown(res: dict) -> str:
    lines = [f"# Gallery-size and distractor sweeps ({res['backend_key']})", ""]
    lines.append(
        f"split `{res['split']}`, set `{res['eval_set']}`, {res['n_queries']} queries, "
        f"{res['n_base_references']} base references, {res['n_distractor_pool']} distractors "
        f"{res['distractor_pool_by_tier']}"
    )
    lines.append("")
    for key, title in (("gallery_size_sweep", "Gallery size"), ("distractor_sweep", "Distractors")):
        lines.append(f"## {title}")
        lines.append("")
        head = ["refs", "distractors", "R@1", "R@5", "no-ref top-1 cos median", "p95"]
        has_acc = any("cosine_only_accept_rate_no_ref" in r for r in res[key])
        if has_acc:
            head += ["cosine-only accept (no ref)", "cosine-only correct accept"]
        if key == "distractor_sweep":
            head.append("tiers")
        lines.append("| " + " | ".join(head) + " |")
        lines.append("|" + "---|" * len(head))
        for r in res[key]:
            cells = [
                str(r["n_references"]),
                str(r["n_distractors"]),
                _f(r["recall_at_1"]),
                _f(r["recall_at_5"]),
                _f(r["no_ref_top1_cosine_median"]),
                _f(r["no_ref_top1_cosine_p95"]),
            ]
            if has_acc:
                cells += [
                    _f(r.get("cosine_only_accept_rate_no_ref")),
                    _f(r.get("cosine_only_correct_accept_rate")),
                ]
            if key == "distractor_sweep":
                cells.append(str(r.get("distractor_tiers", {})))
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m placematch.evaluation.scaling")
    ap.add_argument("--bench", type=Path, required=True)
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument("--slug", default=None)
    ap.add_argument("--split", default="validation")
    ap.add_argument("--set", dest="eval_set", default="main")
    ap.add_argument("--subset", type=Path, default=None)
    ap.add_argument("--steps", type=int, default=DEFAULT_STEPS)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--thresholds", type=Path, default=None)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    from placematch.evaluation.run import load_subset

    manifest = Manifest.model_validate_json((args.bench / "manifest.json").read_text())
    labels = LabelSet.model_validate_json((args.bench / "labels.json").read_text())
    refs, qs = load_indexes(args.run_dir, args.slug)
    acc = None
    if args.thresholds:
        th = ThresholdSet.model_validate_json(args.thresholds.read_text())
        bt = th.backends.get(refs.backend_key)
        acc = bt.accept_cosine if bt else None
    res = sweeps(
        manifest,
        labels,
        refs,
        qs,
        split=args.split,
        eval_set=args.eval_set,
        subset=load_subset(args.subset) if args.subset else None,
        steps=args.steps,
        seed=args.seed,
        accept_cosine=acc,
    )
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "scaling.json").write_text(json.dumps(res, indent=1))
    (args.out / "scaling.md").write_text(markdown(res))
    print(f"wrote {args.out}/scaling.json, scaling.md")


if __name__ == "__main__":
    main()
