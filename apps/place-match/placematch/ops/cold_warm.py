"""Cold-start vs warm timings: ``python -m placematch.ops.cold_warm`` -> runs/ops/cold_warm.json.

MegaLoc is measured here in a fresh process with a scratch cache (so it really computes):
torch import, model load (hash check + weights), first batch (MPS graph warm-up), then
steady-state batches. Vertex and verification numbers are collected from the smoke test
(``vertex_smoke.json``: one request at a time, first = credentials + TLS) and the 1,000-pair
memory run (``verify_memory.json``); no new Vertex requests are sent.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from placematch.ops.common import OPS_DIR, now, write_json
from placematch.ops.telemetry import hardware, peak_rss_mb, percentiles


def megaloc(n_images: int = 96, batch: int = 8) -> dict:
    t0 = time.perf_counter()
    import torch

    t_torch = time.perf_counter() - t0
    from placematch.backends.base import EmbedStats, RequestBudget
    from placematch.backends.megaloc import MegaLocBackend
    from placematch.schemas import Manifest

    m = Manifest.model_validate_json(
        (OPS_DIR / "vertex_compare_manifest.json").read_text(encoding="utf-8")
    )
    paths = [Path(e.path) for e in m.entries][:n_images]
    tmp = Path(tempfile.mkdtemp(prefix="placematch-coldwarm-"))
    try:
        b = MegaLocBackend(batch_size=batch, cache_root=tmp)
        batches = []
        for i in range(0, len(paths), batch):
            t = time.perf_counter()
            b.embed_paths(paths[i : i + batch], budget=RequestBudget(), stats=EmbedStats())
            if torch.backends.mps.is_available():
                torch.mps.synchronize()
            batches.append(time.perf_counter() - t)
        load = b.telemetry.events.get("model_load_s")
        per_image_steady = [x / batch for x in batches[2:]]
        return {
            "import_torch_s": round(t_torch, 3),
            "model_load_s": load,
            "first_batch_s_incl_model_load": round(batches[0], 3),
            "first_batch_s_excl_model_load": round(batches[0] - (load or 0.0), 3),
            "second_batch_s": round(batches[1], 3),
            "steady_per_image_s": percentiles(per_image_steady),
            "batch_size": batch,
            "n_images": len(paths),
            "note": "batch wall time includes image decode + preprocessing + cache write",
            "device": b.config()["device"],
            "peak_rss_mb": peak_rss_mb(),
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    out: dict = {"created_utc": now(), "hardware_start": hardware("start")}
    out["megaloc"] = megaloc()
    smoke = OPS_DIR / "vertex_smoke.json"
    if smoke.is_file():
        s = json.loads(smoke.read_text(encoding="utf-8"))["latency_s"]
        out["vertex"] = {
            "source": "runs/ops/vertex_smoke.json (5 sequential requests, concurrency 1)",
            "adc_and_client_setup_s": s["client_and_adc_setup"],
            "first_request_s": s["first_request"],
            "later_requests_s": s["later_requests"],
            "http_attempt_s": s["http_attempts"],
        }
    mem = OPS_DIR / "verify_memory.json"
    if mem.is_file():
        v = json.loads(mem.read_text(encoding="utf-8"))
        out["verification"] = {
            "source": "runs/ops/verify_memory.json",
            **v["cold_warm"],
            "all_pairs": v["latency_verify_per_pair"],
        }
    out["hardware_end"] = hardware("end")
    print(json.dumps(out, indent=1)[:4000])
    print(write_json("cold_warm.json", out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
