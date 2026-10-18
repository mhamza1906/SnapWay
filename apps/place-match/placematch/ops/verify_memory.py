"""Memory stability over >= 1,000 verification pairs: ``python -m placematch.ops.verify_memory``.

Real image pairs from ``data/raw`` (7-Scenes colour frames and CLoC database images,
read-only): each query is paired with references of the same scene from a different
sequence/folder. Runs the production path :func:`placematch.verify.verify_run` (its bounded
per-run feature cache included), while a sampler thread records process RSS (``ps``) and
MPS allocator/driver memory every few seconds. Writes ``runs/ops/verify_memory.json``.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from placematch.env import DATA_DIR
from placematch.ops.common import now, write_json
from placematch.ops.telemetry import (
    current_rss_mb,
    hardware,
    mps_memory_mb,
    peak_rss_mb,
    percentiles,
)
from placematch.schemas import Candidate, Manifest, ManifestEntry, QueryResult, RunResult, RunStats


def pick_pairs(n_pairs: int, per_query: int, seed: int = 0) -> tuple[Manifest, RunResult]:
    rng = np.random.default_rng(seed)
    groups: dict[str, dict[str, list[Path]]] = defaultdict(lambda: defaultdict(list))
    for p in sorted((DATA_DIR / "raw" / "7scenes").glob("*/seq-*/frame-*.color.png")):
        groups[p.parts[-3]][p.parts[-2]].append(p)
    for p in sorted((DATA_DIR / "raw" / "cloc").glob("*/Database/images/*/*.png")):
        groups[f"cloc-{p.parts[-5]}"][p.parts[-2]].append(p)
    scenes = sorted(s for s, seqs in groups.items() if len(seqs) >= 2)
    n_queries = -(-n_pairs // per_query)
    entries, queries = {}, []
    for k in range(n_queries):
        scene = scenes[k % len(scenes)]
        seqs = sorted(groups[scene])
        qs, rs = rng.choice(len(seqs), 2, replace=False)
        qp = groups[scene][seqs[qs]][rng.integers(len(groups[scene][seqs[qs]]))]
        refs = groups[scene][seqs[rs]]
        rps = [refs[i] for i in rng.choice(len(refs), min(per_query, len(refs)), replace=False)]
        qid = f"q{k}:{qp.relative_to(DATA_DIR).as_posix()}"
        entries[qid] = ManifestEntry(
            image_id=qid, path=str(qp), role="query", dataset="raw", scene_id=scene
        )
        cands = []
        for r, rp in enumerate(rps, start=1):
            rid = f"r:{rp.relative_to(DATA_DIR).as_posix()}"
            entries.setdefault(
                rid,
                ManifestEntry(
                    image_id=rid, path=str(rp), role="reference", dataset="raw", scene_id=scene
                ),
            )
            cands.append(Candidate(rank=r, reference_id=rid, location_id=scene, cosine=0.0))
        queries.append(QueryResult(query_id=qid, path=str(qp), candidates=cands))
    m = Manifest(name="verify-memory", entries=list(entries.values()))
    run = RunResult(
        run_id="verify-memory",
        created_utc=now(),
        backend="none",
        backend_config={},
        manifest="(in memory)",
        queries=queries,
        stats=RunStats(
            n_references=sum(e.role == "reference" for e in m.entries),
            n_queries=len(queries),
            expected_uncached_requests=0,
            api_requests=0,
            cache_hits=0,
            cache_misses=0,
        ),
    )
    return m, run


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", type=int, default=1000)
    ap.add_argument("--per-query", type=int, default=2)
    ap.add_argument("--sample-s", type=float, default=3.0)
    a = ap.parse_args(argv)

    t_proc = time.perf_counter()
    import torch  # noqa: F401  (timed separately from model load)

    import placematch.verify as V

    t_import = time.perf_counter() - t_proc
    m, run = pick_pairs(a.pairs, a.per_query)
    n_pairs = sum(len(q.candidates[: a.per_query]) for q in run.queries)
    done = {"n": 0}
    first: dict = {}
    orig = V.verify_pair

    def counted(*args, **kw):
        t = time.perf_counter()
        r = orig(*args, **kw)
        if not first:
            first["first_pair_s"] = round(time.perf_counter() - t, 4)
        done["n"] += 1
        return r

    samples: list[dict] = []
    stop = threading.Event()
    t0 = time.perf_counter()

    def sampler():
        while not stop.is_set():
            samples.append(
                {
                    "t_s": round(time.perf_counter() - t0, 2),
                    "pairs_done": done["n"],
                    "rss_mb": current_rss_mb(),
                    **mps_memory_mb(),
                }
            )
            stop.wait(a.sample_s)

    hw_before = hardware("start of run")
    th = threading.Thread(target=sampler, daemon=True)
    V.verify_pair = counted
    th.start()
    try:
        out_run = V.verify_run(run, m, Path("(in memory)"), top_n=a.per_query, overlay_dir=None)
    finally:
        V.verify_pair = orig
        stop.set()
        th.join()
    wall = time.perf_counter() - t0
    samples.append(
        {"t_s": round(wall, 2), "pairs_done": done["n"], "rss_mb": current_rss_mb(),
         **mps_memory_mb()}
    )  # fmt: skip
    res = [c.verification for q in out_run.queries for c in q.candidates if c.verification]
    status = defaultdict(int)
    for r in res:
        status[r.status] += 1
    lat = [r.elapsed_s for r in res]

    def window(lo: float, hi: float, key: str):
        vals = [
            s[key] for s in samples if key in s and lo <= s["pairs_done"] / n_pairs <= hi and s[key]
        ]
        return round(float(np.median(vals)), 1) if vals else None

    trend = {}
    for key in ("rss_mb", "mps_driver_allocated_mb", "mps_current_allocated_mb"):
        early, late = window(0.1, 0.3, key), window(0.7, 0.95, key)
        vals = [s[key] for s in samples if s.get(key) is not None]
        trend[key] = {
            "median_10_30pct": early,
            "median_70_95pct": late,
            "delta_mb": None if early is None or late is None else round(late - early, 1),
            "max": max(vals) if vals else None,
            "min_after_first_10pct": min(
                (s[key] for s in samples if s.get(key) and s["pairs_done"] / n_pairs >= 0.1),
                default=None,
            ),
        }
    out = {
        "created_utc": now(),
        "n_pairs": len(res),
        "n_queries": len(run.queries),
        "n_distinct_images": len(m.entries),
        "status_counts": dict(status),
        "wall_s": round(wall, 1),
        "cold_warm": {
            "import_torch_and_verify_s": round(t_import, 3),
            "first_pair_s_incl_model_load": first.get("first_pair_s"),
            "pairs_2_to_50": percentiles(lat[1:50]),
            "steady_state_after_50": percentiles(lat[50:]),
        },
        "latency_verify_per_pair": percentiles(lat),
        "memory_trend": trend,
        "peak_rss_mb": peak_rss_mb(),
        "settings": out_run.settings.get("verify"),
        "feature_cache_note": "verify_run clears its per-run feature cache above 512 images",
        "hardware_start": hw_before,
        "hardware_end": hardware("end of run"),
        "samples": samples,
    }
    path = write_json("verify_memory.json", out)
    print(json.dumps({k: v for k, v in out.items() if k not in ("samples",)}, indent=1)[:5000])
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
