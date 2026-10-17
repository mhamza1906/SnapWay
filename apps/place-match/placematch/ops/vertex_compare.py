"""Vertex AI vs Developer API vectors on a stratified bench-v1 subset, with resume checks.

``python -m placematch.ops.vertex_compare [--dry-run]`` embeds the subset (<= 120 images)
with the Vertex backend in three phases that double as the interruption/resume test:

A. budget-limited partial batch (``embed_only(..., budget=40, allow_partial=True)``);
B. a worker subprocess that is SIGKILLed mid-batch;
C. resume until done. Requests in C must only be for images not cached before C.

Then it compares, per image, the Vertex vector with the bench-v1 Developer API vector
(read from the frozen-era cache in read-only mode: 0 Developer API requests), and the
query->reference rankings both produce. Writes ``runs/ops/vertex_vs_devapi.json`` and
``runs/ops/resume.json``.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from placematch.backends.base import RequestBudget
from placematch.cache import file_sha256
from placematch.ops.common import (
    OPS_DIR,
    devapi_vectors,
    ledger_add,
    load_bench_v1,
    now,
    rel,
    remaining_allowance,
    stratified_subset,
    write_json,
)
from placematch.ops.telemetry import hardware
from placematch.retrieval import embed_only, estimate
from placematch.schemas import Manifest

MANIFEST = OPS_DIR / "vertex_compare_manifest.json"
WORKER_LOG = OPS_DIR / "resume_worker_attempts.log"


def _manifest() -> Manifest:
    m = stratified_subset(load_bench_v1(), 5, 10)
    OPS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(m.model_dump_json(indent=1), encoding="utf-8")
    return m


def _cached_count(db_path: Path, shas: set[str]) -> int:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return sum(1 for (s,) in db.execute("SELECT sha FROM emb") if s in shas)
    finally:
        db.close()


def worker(limit: int) -> int:
    """Subprocess body for phase B: logs one line per HTTP attempt (no content)."""
    from placematch.backends import get_backend

    backend = get_backend("vertex", concurrency=2)
    log = open(WORKER_LOG, "a", buffering=1, encoding="utf-8")  # noqa: SIM115

    def on_request(request):
        log.write(f"{time.time():.3f} attempt\n")

    backend.telemetry.hooks = lambda: {
        "request": [backend.telemetry.on_request, on_request],
        "response": [backend.telemetry.on_response],
    }
    m = Manifest.model_validate_json(MANIFEST.read_text(encoding="utf-8"))
    embed_only(m, MANIFEST, backend, budget=RequestBudget(limit=limit), chunk_size=4)
    return 0


def rank_compare(m: Manifest, vx: dict, dv: dict, sha_of: dict) -> dict:
    from scipy.stats import kendalltau, spearmanr

    refs = [e for e in m.entries if e.role == "reference"]
    qs = [e for e in m.entries if e.role == "query"]
    R1 = np.stack([vx[sha_of[e.image_id]] for e in refs])
    R2 = np.stack([dv[sha_of[e.image_id]] for e in refs])
    Q1 = np.stack([vx[sha_of[e.image_id]] for e in qs])
    Q2 = np.stack([dv[sha_of[e.image_id]] for e in qs])
    S1, S2 = Q1 @ R1.T, Q2 @ R2.T
    top1_same, top5_overlap, rho, tau, loc1, loc2 = [], [], [], [], [], []
    for i, q in enumerate(qs):
        o1, o2 = np.argsort(-S1[i], kind="stable"), np.argsort(-S2[i], kind="stable")
        top1_same.append(bool(o1[0] == o2[0]))
        top5_overlap.append(len(set(o1[:5]) & set(o2[:5])) / 5)
        rho.append(float(spearmanr(S1[i], S2[i]).statistic))
        tau.append(float(kendalltau(S1[i], S2[i]).statistic))
        if q.location_id is not None and any(r.location_id == q.location_id for r in refs):
            loc1.append(refs[o1[0]].location_id == q.location_id)
            loc2.append(refs[o2[0]].location_id == q.location_id)
    d = np.abs(S1 - S2)
    return {
        "n_queries": len(qs),
        "n_references": len(refs),
        "top1_agreement": round(float(np.mean(top1_same)), 4),
        "top1_disagreements": int(len(qs) - sum(top1_same)),
        "top5_overlap_mean": round(float(np.mean(top5_overlap)), 4),
        "spearman_rho": {"mean": round(float(np.mean(rho)), 6), "min": round(min(rho), 6)},
        "kendall_tau": {"mean": round(float(np.mean(tau)), 6), "min": round(min(tau), 6)},
        "query_ref_cosine_abs_diff": {
            "mean": float(d.mean()),
            "p95": float(np.percentile(d, 95)),
            "max": float(d.max()),
        },
        "top1_location_correct_on_subset": {
            "n_queries_with_reference_in_subset": len(loc1),
            "vertex": round(float(np.mean(loc1)), 4) if loc1 else None,
            "developer_api": round(float(np.mean(loc2)), 4) if loc2 else None,
            "note": "diagnostic only: bench-v1 is development data; small sub-gallery",
        },
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--worker", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--phase-a", type=int, default=40)
    ap.add_argument("--phase-b", type=int, default=40)
    ap.add_argument("--kill-after-stored", type=int, default=12)
    a = ap.parse_args(argv)
    if a.worker is not None:
        return worker(a.worker)

    from placematch.backends import get_backend

    m = _manifest()
    backend = get_backend("vertex")
    est0 = estimate(m, MANIFEST, backend)
    print(json.dumps(est0, indent=2))
    allowance = remaining_allowance()
    print(f"ops allowance left: {allowance}")
    if a.dry_run:
        return 0
    if est0["expected_requests"] + 8 > allowance:  # + in-flight requests lost to the kill
        print("refusing: would exceed the Subagent 1 allowance", file=sys.stderr)
        return 2
    sha_of = {e.image_id: file_sha256(Path(e.path)) for e in m.entries}
    shas = set(sha_of.values())
    db_path = backend.cache.directory / "embeddings.sqlite"
    resume = {"created_utc": now(), "backend": backend.key, "manifest": rel(MANIFEST)}
    resume["start"] = {"cached": _cached_count(db_path, shas), "estimate": est0}

    # A: budget-limited partial batch
    st = embed_only(m, MANIFEST, backend, budget=RequestBudget(limit=a.phase_a))
    ledger_add("compare_phase_a", st.api_requests, st.telemetry["http_attempts"], "partial")
    resume["phase_a_partial_budget"] = {
        "budget": a.phase_a,
        "logical_requests": st.api_requests,
        "http_attempts": st.telemetry["http_attempts"],
        "failed": st.failed,
        "cached_after": _cached_count(db_path, shas),
        "remaining_uncached": st.telemetry["remaining_uncached"],
    }

    # B: worker killed mid-batch
    WORKER_LOG.unlink(missing_ok=True)
    before_b = _cached_count(db_path, shas)
    proc = subprocess.Popen(
        [sys.executable, "-m", "placematch.ops.vertex_compare", "--worker", str(a.phase_b)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )  # fmt: skip
    t0 = time.perf_counter()
    while proc.poll() is None and time.perf_counter() - t0 < 300:
        if _cached_count(db_path, shas) - before_b >= a.kill_after_stored:
            break
        time.sleep(0.2)
    killed = proc.poll() is None
    if killed:
        os.kill(proc.pid, signal.SIGKILL)
    proc.wait()
    time.sleep(0.5)
    attempts_b = (
        len(WORKER_LOG.read_text(encoding="utf-8").splitlines()) if WORKER_LOG.exists() else 0
    )
    stored_b = _cached_count(db_path, shas) - before_b
    # Logical requests of a killed worker are not reported; count each HTTP attempt as one
    # logical request for the ledger (upper bound: no retries were possible to observe).
    ledger_add("compare_phase_b_killed", attempts_b, attempts_b, "SIGKILL mid-batch")
    resume["phase_b_killed_worker"] = {
        "budget": a.phase_b,
        "killed_with_sigkill": killed,
        "returncode": proc.returncode,
        "http_attempts_sent": attempts_b,
        "vectors_stored": stored_b,
        "in_flight_lost": attempts_b - stored_b,
        "seconds_before_kill": round(time.perf_counter() - t0, 2),
    }

    # C: resume
    cached_before_c = set(backend.cache.get_many(shas))
    est_c = estimate(m, MANIFEST, backend)
    backend.telemetry.per_sha_s.clear()
    st = embed_only(m, MANIFEST, backend, budget=RequestBudget(limit=est_c["expected_requests"]))
    ledger_add("compare_phase_c_resume", st.api_requests, st.telemetry["http_attempts"], "")
    requested_c = set(backend.telemetry.per_sha_s)
    resume["phase_c_resume"] = {
        "estimate_before": est_c,
        "logical_requests": st.api_requests,
        "http_attempts": st.telemetry["http_attempts"],
        "retries": st.retries,
        "failed": st.failed,
        "requested_images_already_cached_before": len(requested_c & cached_before_c),
        "remaining_uncached": st.telemetry["remaining_uncached"],
    }
    total_logical = (
        resume["phase_a_partial_budget"]["logical_requests"]
        + attempts_b
        + resume["phase_c_resume"]["logical_requests"]
    )
    resume["summary"] = {
        "images_needed_at_start": est0["n_uncached"],
        "logical_requests_total": total_logical,
        "extra_requests": total_logical - est0["n_uncached"],
        "extra_explained_by_in_flight_at_kill": attempts_b - stored_b,
        "duplicate_requests_for_stored_vectors": len(requested_c & cached_before_c),
        "complete": st.telemetry["remaining_uncached"] == 0,
    }
    resume["hardware"] = hardware()
    write_json("resume.json", resume)
    print(json.dumps(resume["summary"], indent=2))

    # comparison
    vx = backend.cache.get_many(shas)
    dv = devapi_vectors(sorted(shas))
    per_image = []
    for e in m.entries:
        s = sha_of[e.image_id]
        if s in vx and s in dv:
            a1, a2 = vx[s] / np.linalg.norm(vx[s]), dv[s] / np.linalg.norm(dv[s])
            per_image.append(
                {
                    "image_id": e.image_id,
                    "scene": e.scene_id,
                    "role": e.role,
                    "cosine": float(a1 @ a2),
                    "max_abs_diff": float(np.abs(a1 - a2).max()),
                    "bitwise_identical": bool(np.array_equal(vx[s], dv[s])),
                }
            )
    cos = np.array([r["cosine"] for r in per_image])
    out = {
        "created_utc": now(),
        "vertex_backend": backend.key,
        "vertex_config": backend.config(),
        "developer_api_backend": "gemini:gemini-embedding-2:d3072:max1024:jpg90",
        "developer_api_source": "bench-v1 cache (read-only); 0 new Developer API requests",
        "manifest": rel(MANIFEST),
        "n_images": len(per_image),
        "per_image_cosine": {
            "min": float(cos.min()),
            "p05": float(np.percentile(cos, 5)),
            "median": float(np.median(cos)),
            "mean": float(cos.mean()),
            "max": float(cos.max()),
            "n_bitwise_identical": int(sum(r["bitwise_identical"] for r in per_image)),
            "n_cosine_ge_0.9999": int((cos >= 0.9999).sum()),
            "n_cosine_ge_0.999": int((cos >= 0.999).sum()),
            "n_cosine_lt_0.99": int((cos < 0.99).sum()),
        },
        "ranking": rank_compare(m, vx, dv, sha_of),
        "per_image": per_image,
        "hardware": hardware(),
    }
    write_json("vertex_vs_devapi.json", out)
    print(json.dumps({k: out[k] for k in ("n_images", "per_image_cosine", "ranking")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
