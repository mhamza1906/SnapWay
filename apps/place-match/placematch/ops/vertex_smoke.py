"""Vertex AI smoke test: project, API, permission and quota with ~5 real images.

``python -m placematch.ops.vertex_smoke [--dry-run] [--n 5]`` -> ``runs/ops/vertex_smoke.json``.
Images come from the bench-v1 ops subset (read-only). Requests run one at a time so the
first (cold: credentials + TLS) and later (warm) latencies can be told apart. A response
hook records only the *names* of the top-level JSON fields (to see whether a model version is
returned); no values, headers or credentials are stored.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from placematch.backends.base import RequestBudget
from placematch.ops.common import (
    OPS_DIR,
    ledger_add,
    load_bench_v1,
    now,
    rel,
    remaining_allowance,
    stratified_subset,
    write_json,
)
from placematch.ops.telemetry import hardware, peak_rss_mb, percentiles
from placematch.retrieval import embed_only, estimate
from placematch.schemas import Manifest


def smoke_manifest(n: int) -> Manifest:
    sub = stratified_subset(load_bench_v1(), 5, 10)
    seen, picked = set(), []
    for e in sub.entries:  # one image per scene first, then fill up
        if e.scene_id not in seen:
            seen.add(e.scene_id)
            picked.append(e)
    picked = picked[:n]
    return Manifest(name="vertex-smoke", entries=picked, notes={"from": sub.notes})


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)

    from placematch.backends import get_backend

    t_import = time.perf_counter()
    backend = get_backend("vertex", concurrency=1)
    manifest = smoke_manifest(a.n)
    mpath = OPS_DIR / "vertex_smoke_manifest.json"
    OPS_DIR.mkdir(parents=True, exist_ok=True)
    mpath.write_text(manifest.model_dump_json(indent=1), encoding="utf-8")
    est = estimate(manifest, mpath, backend)
    print(json.dumps(est, indent=2))
    allowance = remaining_allowance()
    print(f"ops allowance left: {allowance} logical Vertex requests")
    if a.dry_run:
        return 0
    if est["expected_requests"] > allowance:
        print("refusing: would exceed the Subagent 1 allowance", file=sys.stderr)
        return 2

    response_fields: dict[str, int] = {}

    def on_response(response):  # field names only
        try:
            response.read()
            body = response.json()
            for k in body:
                response_fields[k] = response_fields.get(k, 0) + 1
            for k in body.get("usageMetadata", {}) or {}:
                response_fields[f"usageMetadata.{k}"] = 1
        except Exception:
            response_fields["<unparsed>"] = response_fields.get("<unparsed>", 0) + 1

    backend.telemetry.hooks = lambda: {
        "request": [backend.telemetry.on_request],
        "response": [backend.telemetry.on_response, on_response],
    }
    budget = RequestBudget(limit=est["expected_requests"])
    t0 = time.perf_counter()
    stats = embed_only(manifest, mpath, backend, budget=budget, allow_partial=False)
    wall = time.perf_counter() - t0
    tel = backend.telemetry
    ledger_add(
        "vertex_smoke", stats.api_requests, tel.http_attempts, f"{len(manifest.entries)} images"
    )
    lat = tel.embed_latency_s
    out = {
        "created_utc": now(),
        "backend": backend.key,
        "backend_config": backend.config(),
        "manifest": rel(mpath),
        "images": [e.image_id for e in manifest.entries],
        "estimate_before": est,
        "logical_requests": stats.api_requests,
        "http_attempts": tel.http_attempts,
        "http_by_host": dict(tel.http_by_host),
        "http_status": dict(tel.http_status),
        "retries": stats.retries,
        "failed": stats.failed,
        "usage": dict(tel.usage),
        "response_fields": response_fields,
        "cost_estimate": stats.telemetry["cost_estimate"],
        "latency_s": {
            "client_and_adc_setup": tel.events,
            "first_request": round(lat[0], 4) if lat else None,
            "later_requests": percentiles(lat[1:]),
            "all_requests": percentiles(lat),
            "http_attempts": percentiles(tel.attempt_latency_s),
            "wall_total": round(wall, 3),
            "process_to_done": round(time.perf_counter() - t_import, 3),
        },
        "estimate_after": estimate(manifest, mpath, backend),
        "peak_rss_mb": peak_rss_mb(),
        "hardware": hardware(),
        "ok": not stats.failed and stats.api_requests == len(manifest.entries),
    }
    path = write_json("vertex_smoke.json", out)
    print(json.dumps({k: out[k] for k in ("logical_requests", "http_attempts", "failed")}))
    print(path)
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
