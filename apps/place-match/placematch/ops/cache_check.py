"""Cache reuse and invalidation: ``python -m placematch.ops.cache_check`` -> runs/ops/cache.json.

Uses the ops subset manifest (bench-v1 images, read-only). Sends 0 Vertex requests: the
Vertex vectors are already cached by ``vertex_compare``; every variant that would need
requests is only *estimated*. MegaLoc runs twice against a fresh scratch cache to show
compute-then-reuse; the real caches are only read.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image

from placematch.backends import get_backend
from placematch.backends.base import RequestBudget
from placematch.cache import backend_slug
from placematch.ops.common import OPS_DIR, now, rel, write_json
from placematch.ops.telemetry import hardware
from placematch.retrieval import estimate, run_retrieval
from placematch.schemas import Manifest, ManifestEntry

MANIFEST = OPS_DIR / "vertex_compare_manifest.json"


def _stats(run) -> dict:
    s = run.stats
    return {
        "api_requests": s.api_requests,
        "http_attempts": s.http_attempts,
        "cache_hits": s.cache_hits,
        "cache_misses": s.cache_misses,
        "cold_start": s.cold_start,
        "embed_s": s.timings_s.get("embed"),
        "total_s": s.timings_s.get("total"),
        "latency_embed_per_image": s.latency_s.get("embed_per_image"),
        "cost_estimate_usd": s.cost_estimate.get("usd"),
    }


def main() -> int:
    if not MANIFEST.is_file():
        print("run placematch.ops.vertex_compare first", file=sys.stderr)
        return 2
    m = Manifest.model_validate_json(MANIFEST.read_text(encoding="utf-8"))
    out: dict = {"created_utc": now(), "manifest": rel(MANIFEST), "n_images": len(m.entries)}
    tmp = Path(tempfile.mkdtemp(prefix="placematch-cache-check-"))
    try:
        # 1. repeat Vertex runs reuse the cache (0 requests; budget 0 would refuse otherwise)
        vx = get_backend("vertex")
        runs = []
        for i in range(2):
            est = estimate(m, MANIFEST, vx)
            run = run_retrieval(
                m, MANIFEST, vx, budget=RequestBudget(limit=0), out_dir=tmp / f"vertex{i}"
            )
            runs.append({"estimate": est, "run": _stats(run)})
        out["vertex_repeat_runs"] = runs

        # 2. MegaLoc: fresh scratch cache -> compute, then reuse
        ml_runs = []
        for i in range(2):
            ml = get_backend("megaloc", cache_root=tmp / "megaloc-cache")
            t = time.perf_counter()
            run = run_retrieval(m, MANIFEST, ml, budget=RequestBudget(), out_dir=tmp / f"ml{i}")
            ml_runs.append({"run": _stats(run), "wall_s": round(time.perf_counter() - t, 2)})
        out["megaloc_repeat_runs_fresh_cache"] = ml_runs
        ml.release()

        # 3. invalidation: every setting that changes vectors -> different key/cache namespace
        variants = {
            "vertex (baseline)": ("vertex", {}),
            "vertex jpeg_quality=85": ("vertex", {"jpeg_quality": 85}),
            "vertex max_side=768": ("vertex", {"max_side": 768}),
            "vertex dims=768": ("vertex", {"dims": 768}),
            "vertex location=eu": ("vertex", {"location": "eu"}),
            "gemini developer api (bench-v1 cache)": ("gemini", {}),
            "megaloc 322 (bench-v1 cache)": ("megaloc", {}),
            "megaloc 224": ("megaloc", {"image_size": 224}),
        }
        inv = {}
        for label, (name, opts) in variants.items():
            b = get_backend(name, **opts)
            est = estimate(m, MANIFEST, b)
            inv[label] = {
                "key": b.key,
                "cache_dir": b.cache.directory.name,
                "provider": b.config().get("provider"),
                "n_cached": est["n_cached"],
                "n_uncached": est["n_uncached"],
                "expected_requests": est["expected_requests"],
                "cost_usd_if_run": est["cost_usd"],
            }
        out["invalidation_estimates_only"] = inv
        dirs = [v["cache_dir"] for v in inv.values()]
        out["all_cache_namespaces_distinct"] = len(set(dirs)) == len(dirs)

        # 4. content change: same file name, different bytes -> miss (sha256-keyed)
        src = Path(m.entries[0].path)
        same = tmp / "content" / "same.png"
        edited = tmp / "content" / "edited.png"
        same.parent.mkdir(parents=True)
        shutil.copyfile(src, same)
        im = Image.open(src).convert("RGB")
        im.putpixel((0, 0), (0, 0, 0) if im.getpixel((0, 0)) != (0, 0, 0) else (255, 255, 255))
        im.save(edited)
        cm = Manifest(
            name="content",
            entries=[
                ManifestEntry(image_id=p.stem, path=str(p), role="query", dataset="x", scene_id="x")
                for p in (same, edited)
            ],
        )
        cmp_ = tmp / "content" / "m.json"
        cmp_.write_text(cm.model_dump_json(), encoding="utf-8")
        out["content_change"] = {
            "byte_identical_copy_cached": estimate(cm, cmp_, vx)["n_cached"] == 1
            and vx.cache.count_uncached([same])[0] == 1,
            "one_pixel_edit_uncached": vx.cache.count_uncached([edited])[1] == 1,
        }
        out["index_dir_names"] = {
            "vertex": backend_slug(vx.key),
            "gemini": backend_slug("gemini:gemini-embedding-2:d3072:max1024:jpg90"),
        }
        out["hardware"] = hardware()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    path = write_json("cache.json", out)
    print(json.dumps(out, indent=2, default=str)[:4000])
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
