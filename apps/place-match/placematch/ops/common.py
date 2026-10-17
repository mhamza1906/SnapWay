"""Helpers shared by the ops checks: output files, the request ledger, bench-v1 subsets."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from placematch.env import APP_DIR, DATA_DIR, RUNS_DIR
from placematch.schemas import Manifest

OPS_DIR = RUNS_DIR / "ops"
LEDGER = OPS_DIR / "vertex_ledger.json"
BENCH_V1 = DATA_DIR / "bench" / "placematch-v1" / "manifest.json"
#: bench-v1 Developer API cache (read-only access; never written by the ops checks).
DEVAPI_CACHE = (
    DATA_DIR / "cache" / "gemini_gemini-embedding-2_d3072_max1024_jpg90-bc4700b7cd1d"
) / "embeddings.sqlite"
SUBAGENT_LIMIT = 300  # Vertex logical requests allowed for Subagent 1 smoke/ops tests


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def write_json(name: str, data: dict) -> Path:
    OPS_DIR.mkdir(parents=True, exist_ok=True)
    path = OPS_DIR / name
    path.write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")
    return path


def rel(path: Path | str) -> str:
    try:
        return Path(path).resolve().relative_to(APP_DIR).as_posix()
    except ValueError:
        return str(path)


def ledger() -> dict:
    if LEDGER.is_file():
        return json.loads(LEDGER.read_text(encoding="utf-8"))
    return {"limit": SUBAGENT_LIMIT, "entries": []}


def ledger_used() -> int:
    return sum(e["logical_requests"] for e in ledger()["entries"])


def ledger_add(step: str, logical: int, http_attempts: int, note: str = "") -> int:
    data = ledger()
    data["entries"].append(
        {
            "utc": now(),
            "step": step,
            "logical_requests": int(logical),
            "http_attempts": int(http_attempts),
            "note": note,
        }
    )
    data["total_logical_requests"] = sum(e["logical_requests"] for e in data["entries"])
    data["total_http_attempts"] = sum(e["http_attempts"] for e in data["entries"])
    OPS_DIR.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return data["total_logical_requests"]


def remaining_allowance() -> int:
    return max(0, SUBAGENT_LIMIT - ledger_used())


def load_bench_v1() -> Manifest:
    return Manifest.model_validate_json(BENCH_V1.read_text(encoding="utf-8"))


def devapi_vectors(shas: list[str]) -> dict[str, np.ndarray]:
    """bench-v1 Developer API vectors by content sha256 (SQLite opened read-only)."""
    uri = f"file:{DEVAPI_CACHE}?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    try:
        out = {}
        for i in range(0, len(shas), 500):
            chunk = shas[i : i + 500]
            q = f"SELECT sha, vec FROM emb WHERE sha IN ({','.join('?' * len(chunk))})"
            for sha, blob in db.execute(q, chunk):
                out[sha] = np.frombuffer(blob, dtype=np.float32).copy()
        return out
    finally:
        db.close()


def stratified_subset(manifest: Manifest, refs_per_scene: int, queries_per_scene: int) -> Manifest:
    """Evenly spaced references and queries from every scene (deterministic, manifest order)."""
    picked = []
    scenes = sorted({e.scene_id for e in manifest.entries})
    for scene in scenes:
        for role, k in (("reference", refs_per_scene), ("query", queries_per_scene)):
            pool = [e for e in manifest.entries if e.scene_id == scene and e.role == role]
            if not pool:
                continue
            idx = np.unique(np.linspace(0, len(pool) - 1, min(k, len(pool))).round().astype(int))
            for i in idx:  # absolute paths so the subset manifest can live anywhere
                e = pool[i].model_copy()
                e.path = str(manifest.resolve(pool[i], BENCH_V1))
                if e.depth_path:
                    e.depth_path = str((BENCH_V1.parent / e.depth_path).resolve())
                picked.append(e)
    return Manifest(
        name=f"{manifest.name}-ops-subset",
        description=f"{refs_per_scene} refs + {queries_per_scene} queries per scene (ops check)",
        entries=picked,
        notes={"source_manifest": rel(BENCH_V1), "selection": "np.linspace per scene/role"},
    )
