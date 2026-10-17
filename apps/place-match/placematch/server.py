"""Local web interface (loopback only): ``uv run placematch serve``.

Uploads are copied into ``runs/ui-<time>/inputs``; images are only served by
looking up ids in a run's own manifest, never by arbitrary path.
"""

from __future__ import annotations

import re
import threading
import time
import traceback
from pathlib import Path, PurePosixPath
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

from placematch.app import BACKENDS, DEFAULT_BACKEND
from placematch.env import RUNS_DIR
from placematch.export import read_manifest, read_run

UI = Path(__file__).parent / "ui" / "index.html"
app = FastAPI(title="place-match")
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()


def _safe_rel(name: str) -> PurePosixPath:
    parts = [p for p in PurePosixPath(name.replace("\\", "/")).parts if p not in ("", ".", "..")]
    parts = [re.sub(r"[^\w.\- ]", "_", p) for p in parts if not p.startswith("/")]
    if not parts:
        raise HTTPException(400, f"bad file name {name!r}")
    return PurePosixPath(*parts)


async def _save(files: list[UploadFile], target: Path, strip_root: bool) -> int:
    n = 0
    for f in files:
        rel = _safe_rel(f.filename or "")
        if strip_root and len(rel.parts) > 1:  # folder picker prefixes the chosen folder name
            rel = PurePosixPath(*rel.parts[1:])
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(await f.read())
        n += 1
    return n


def _run_dir(rel: str) -> Path:
    path = (RUNS_DIR / rel).resolve()
    if RUNS_DIR.resolve() not in path.parents or not (path / "results.json").is_file():
        raise HTTPException(404, "unknown run")
    return path


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return UI.read_text(encoding="utf-8")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/runs")
def runs() -> list[dict]:
    items = []
    for path in sorted(RUNS_DIR.glob("**/results.json"), key=lambda p: -p.stat().st_mtime):
        try:
            run = read_run(path)
        except Exception:  # noqa: BLE001 - skip partial or foreign files
            continue
        items.append(
            {
                "id": path.parent.relative_to(RUNS_DIR).as_posix(),
                "backend": run.backend,
                "provider": run.backend_config.get("provider")
                or {"gemini": "gemini-developer-api", "megaloc": "local"}.get(
                    run.backend.split(":", 1)[0], ""
                ),
                "created_utc": run.created_utc,
                "n_queries": len(run.queries),
                "n_references": run.stats.n_references,
                "verified": bool(run.settings.get("verify_enabled")),
            }
        )
    return items


@app.get("/api/run")
def run_detail(id: str) -> dict:
    directory = _run_dir(id)
    run = read_run(directory / "results.json")
    manifest = read_manifest(Path(run.manifest))
    images = {
        e.image_id: {
            "role": e.role,
            "location_id": e.location_id,
            "timestamp_s": e.timestamp_s,
            "frame_id": e.frame_id,
            "conditions": e.conditions,
        }
        for e in manifest.entries
    }
    exports = {k: f"/api/export?id={id}&kind={k}" for k in ("json", "csv", "reverse_csv")}
    return {"run": run.model_dump(), "images": images, "exports": exports}


@app.get("/api/image")
def image(id: str, image_id: str) -> FileResponse:
    run = read_run(_run_dir(id) / "results.json")
    manifest_path = Path(run.manifest)
    manifest = read_manifest(manifest_path)
    for e in manifest.entries:
        if e.image_id == image_id:
            return FileResponse(manifest.resolve(e, manifest_path))
    raise HTTPException(404, "unknown image")


@app.get("/api/overlay")
def overlay(id: str, query_id: str, reference_id: str) -> FileResponse:
    directory = _run_dir(id)
    run = read_run(directory / "results.json")
    for q in run.queries:
        if q.query_id != query_id:
            continue
        for c in q.candidates:
            v = c.verification
            if c.reference_id == reference_id and v and v.overlay_path:
                path = Path(v.overlay_path)
                path = path if path.is_absolute() else directory / path
                if path.is_file():
                    return FileResponse(path)
    raise HTTPException(404, "no overlay")


@app.get("/api/export")
def export(id: str, kind: str) -> FileResponse:
    names = {"json": "results.json", "csv": "results.csv", "reverse_csv": "reverse.csv"}
    if kind not in names:
        raise HTTPException(400, "unknown export")
    path = _run_dir(id) / names[kind]
    return FileResponse(path, filename=f"{id.replace('/', '_')}_{names[kind]}")


@app.post("/api/jobs")
async def create_job(
    references: Annotated[list[UploadFile], File()],
    queries: Annotated[list[UploadFile] | None, File()] = None,
    video: Annotated[UploadFile | None, File()] = None,
    fps: Annotated[float, Form()] = 1.0,
    backends: Annotated[str, Form()] = DEFAULT_BACKEND,
) -> dict:
    """Store uploads, build the manifest and report expected API requests (sends nothing)."""
    from placematch.app import build_manifest, estimate

    job_id = time.strftime("ui-%Y%m%d-%H%M%S")
    root = RUNS_DIR / job_id
    inputs = root / "inputs"
    n_refs = await _save(references, inputs / "references", strip_root=True)
    if video is not None and video.filename:
        video_path = inputs / _safe_rel(video.filename).name
        video_path.parent.mkdir(parents=True, exist_ok=True)
        video_path.write_bytes(await video.read())
        kwargs = {"video": video_path, "fps": fps}
    elif queries:
        await _save(queries, inputs / "queries", strip_root=True)
        kwargs = {"queries": inputs / "queries"}
    else:
        raise HTTPException(400, "upload a video or query images")
    log: list[str] = [f"saved {n_refs} reference files"]
    try:
        manifest = build_manifest(inputs / "references", root, log=log.append, **kwargs)
        names = [b for b in backends.split(",") if b in BACKENDS] or [DEFAULT_BACKEND]
        estimates = {b: estimate(manifest, b) for b in names}
    except Exception as exc:  # noqa: BLE001 - report to the UI
        raise HTTPException(400, f"{type(exc).__name__}: {exc}") from exc
    with LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "manifest": str(manifest),
            "backends": names,
            "estimates": estimates,
            "status": "ready",
            "log": log,
            "runs": [],
        }
    return JOBS[job_id]


def _worker(job: dict, limit: int | None, verify: bool, verify_top: int) -> None:
    from placematch.app import run_pipeline

    job["status"] = "running"
    try:
        root = Path(job["manifest"]).parent
        for backend in job["backends"]:
            run_pipeline(
                Path(job["manifest"]),
                backend,
                root / backend,
                limit=limit,
                verify=verify,
                verify_top=verify_top,
                log=job["log"].append,
            )
            job["runs"].append((root / backend).relative_to(RUNS_DIR).as_posix())
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001 - surfaced in the UI log
        job["log"].append(f"ERROR {type(exc).__name__}: {exc}")
        job["log"].append(traceback.format_exc(limit=3))
        job["status"] = "failed"


@app.post("/api/jobs/{job_id}/start")
def start_job(
    job_id: str,
    limit: Annotated[int | None, Form()] = None,
    verify: Annotated[bool, Form()] = False,
    verify_top: Annotated[int, Form()] = 3,
) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")
    if job["status"] == "running":
        raise HTTPException(409, "already running")
    threading.Thread(target=_worker, args=(job, limit, verify, verify_top), daemon=True).start()
    return {"id": job_id, "status": "running"}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")
    return job
