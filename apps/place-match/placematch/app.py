"""Orchestration shared by the CLI and the local web interface."""

from __future__ import annotations

import csv
import time
from collections.abc import Callable
from pathlib import Path

from placematch.backends.base import RequestBudget
from placematch.env import DATA_DIR
from placematch.export import export_all, read_manifest, write_json
from placematch.schemas import Manifest, RunResult, ThresholdSet

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic"}
BACKENDS = ("megaloc", "vertex", "gemini")  # gemini = Gemini Developer API (bench-v1 only)
# MegaLoc without verification: best measured recall on placematch-v2 and ~0.3 s/frame locally
# (REPORT-v2.md). Vertex AI and geometric verification are opt-in.
DEFAULT_BACKEND = "megaloc"
V1_THRESHOLDS = DATA_DIR / "calibration" / "thresholds.json"  # frozen bench-v1
DEFAULT_THRESHOLDS = DATA_DIR / "calibration" / "current.json"  # copy of the active set

Log = Callable[[str], None]


def _read_csv_map(path: Path | None, value_column: str, cast=str) -> dict | None:
    """Read ``path,<value_column>`` rows (paths relative to the image directory)."""
    if path is None:
        return None
    with path.open(newline="", encoding="utf-8") as stream:
        return {row["path"]: cast(row[value_column]) for row in csv.DictReader(stream)}


def folder_locations(directory: Path) -> dict[str, str] | None:
    """Use first-level subfolder names as location ids when references are grouped that way."""
    mapping = {}
    for p in sorted(directory.rglob("*")):
        if p.suffix.lower() in IMAGE_SUFFIXES and p.parent != directory:
            rel = p.relative_to(directory).as_posix()
            mapping[rel] = rel.split("/", 1)[0]
    return mapping or None


def build_manifest(
    references: Path,
    out_dir: Path,
    *,
    video: Path | None = None,
    queries: Path | None = None,
    fps: float = 1.0,
    locations_csv: Path | None = None,
    timestamps_csv: Path | None = None,
    name: str | None = None,
    log: Log = print,
) -> Path:
    """Create ``out_dir/manifest.json`` from a reference folder and a video or frame folder."""
    from placematch import frames

    if (video is None) == (queries is None):
        raise ValueError("give exactly one of a video or a query image directory")
    out_dir.mkdir(parents=True, exist_ok=True)
    locations = _read_csv_map(locations_csv, "location_id") or folder_locations(references)
    entries = frames.ingest_images(references, "reference", location_map=locations)
    log(f"references: {len(entries)} images from {references}")
    if video is not None:
        q = frames.extract_video(video, out_dir / "frames", fps=fps)
        log(f"queries: {len(q)} frames from {video.name} at {fps} fps")
        source = {"video": str(video), "fps": fps}
    else:
        stamps = _read_csv_map(timestamps_csv, "timestamp_s", float)
        q = frames.ingest_images(queries, "query", timestamps=stamps)
        log(f"queries: {len(q)} images from {queries}")
        source = {"query_dir": str(queries), "timestamps": str(timestamps_csv or "")}
    manifest = Manifest(
        name=name or out_dir.name,
        description="user-supplied references and queries",
        entries=entries + q,
        notes={"references": str(references), **source},
    )
    return write_json(manifest, out_dir / "manifest.json")


def load_thresholds(path: Path | None) -> ThresholdSet | None:
    if path is None:
        path = next((p for p in (DEFAULT_THRESHOLDS, V1_THRESHOLDS) if p.is_file()), None)
    if path is None:
        return None
    return ThresholdSet.model_validate_json(path.read_text(encoding="utf-8"))


def estimate(manifest_path: Path, backend_name: str) -> dict:
    from placematch import retrieval
    from placematch.backends import get_backend

    backend = get_backend(backend_name)
    result = retrieval.estimate(read_manifest(manifest_path), manifest_path, backend)
    return {"backend": backend.key, "remote": backend.remote, **result}


def run_pipeline(
    manifest_path: Path,
    backend_name: str,
    out_dir: Path,
    *,
    top_k: int = 5,
    limit: int | None = None,
    verify: bool = False,
    verify_top: int = 3,
    overlays: bool = True,
    thresholds_path: Path | None = None,
    log: Log = print,
) -> RunResult:
    """Retrieve, optionally verify, decide and export. One backend per call."""
    from placematch import decide, retrieval
    from placematch import verify as verification
    from placematch.backends import get_backend

    manifest = read_manifest(manifest_path)
    backend = get_backend(backend_name)
    est = retrieval.estimate(manifest, manifest_path, backend)
    log(
        f"{backend.key}: {est['n_images']} images, {est['n_cached']} cached, "
        f"expected uncached API requests: {est['expected_requests']}"
        + (f" (limit {limit})" if limit is not None else "")
    )
    budget = RequestBudget(limit=limit)
    started = time.perf_counter()
    run = retrieval.run_retrieval(
        manifest, manifest_path, backend, top_k=top_k, budget=budget, out_dir=out_dir
    )
    run.manifest = str(manifest_path.resolve())
    log(
        f"retrieval done in {time.perf_counter() - started:.1f}s: "
        f"{run.stats.api_requests} API requests, {run.stats.cache_hits} cache hits"
    )
    if verify:
        backend.release()  # free embedding-model memory before loading SuperPoint/LightGlue
        t = time.perf_counter()
        run = verification.verify_run(
            run,
            manifest,
            manifest_path,
            top_n=verify_top,
            overlay_dir=(out_dir / "overlays") if overlays else None,
        )
        run.stats.timings_s["verify"] = round(time.perf_counter() - t, 3)
        log(f"verification of top {verify_top} done in {time.perf_counter() - t:.1f}s")
    thresholds = load_thresholds(thresholds_path)
    if thresholds is not None and backend.key not in thresholds.backends:
        log(f"no calibrated thresholds for {backend.key}; decisions are uncalibrated")
        thresholds = None
    run = decide.apply_decisions(run, thresholds, use_verification=verify)
    run.settings.update({"top_k": top_k, "verify_enabled": verify, "verify_top": verify_top})
    files = export_all(run, out_dir)
    log(f"wrote {files['json']} and {files['csv']}")
    return run
