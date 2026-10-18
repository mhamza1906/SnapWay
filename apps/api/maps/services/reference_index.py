"""Build and store MegaLoc embedding indexes for revision reference photos."""

from __future__ import annotations

import hashlib
import io
import json
import re
import subprocess
import tempfile
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from django.conf import settings
from django.db import transaction

from maps.models import Asset, ReferencePhoto, Revision, RevisionArtifact
from maps.services import graph as graph_svc
from maps.services.graph import GraphError
from maps.services.media_store import put_bytes, read_bytes

BACKEND_NAME = "megaloc"
SET_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
INDEX_ZIP_NAMES = ("vectors.npy", "index.txt", "meta.json", "locations.json")

RunBuild = Callable[..., dict[str, Any]]


def place_match_root() -> Path:
    configured = getattr(settings, "PLACEMATCH_ROOT", "") or ""
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(settings.BASE_DIR).resolve().parent.parent / "apps" / "place-match"


def compute_input_hash(
    rows: list[tuple[str, str, str]], *, backend_name: str = BACKEND_NAME
) -> str:
    """SHA-256 over sorted (reference_id, asset.sha256, node_id) plus backend name."""
    lines = [f"{backend_name}\n"]
    for reference_id, sha256, node_id in sorted(rows, key=lambda r: (r[0], r[2], r[1])):
        lines.append(f"{reference_id}\t{sha256}\t{node_id}\n")
    return hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()


def _eligible_photos(revision: Revision) -> list[ReferencePhoto]:
    return list(
        ReferencePhoto.objects.filter(revision=revision, node__isnull=False)
        .exclude(status=ReferencePhoto.Status.REJECTED)
        .select_related("asset", "node")
        .order_by("created_at")
    )


def _artifact_payload(artifact: RevisionArtifact, *, skipped: bool = False) -> dict[str, Any]:
    return {
        "revision_id": str(artifact.revision_id),
        "kind": artifact.kind,
        "state": artifact.state,
        "input_content_hash": artifact.input_content_hash,
        "profile": artifact.profile,
        "error_code": artifact.error_code,
        "asset_id": str(artifact.asset_id) if artifact.asset_id else None,
        "skipped": skipped,
    }


def get_index_status(revision: Revision, *, actor) -> dict[str, Any]:
    graph_svc.require_draft_read_access(actor, revision)
    try:
        artifact = RevisionArtifact.objects.select_related("asset").get(
            revision=revision, kind="index"
        )
    except RevisionArtifact.DoesNotExist:
        return {
            "revision_id": str(revision.id),
            "kind": "index",
            "state": None,
            "input_content_hash": "",
            "profile": {},
            "error_code": "",
            "asset_id": None,
            "skipped": False,
        }
    return _artifact_payload(artifact)


def run_megaloc_build(*, references_dir: Path, work_root: Path, set_name: str) -> dict[str, Any]:
    """Subprocess into place-match; returns summary including ``index`` path."""
    if not SET_NAME_RE.match(set_name):
        raise GraphError("Invalid reference set name for MegaLoc build.")
    root = place_match_root()
    if not root.is_dir():
        raise GraphError(f"place-match root not found: {root}")
    cmd = [
        "uv",
        "run",
        "python",
        "-m",
        "placematch.ops.revision_embed",
        "--references",
        str(references_dir),
        "--root",
        str(work_root),
        "--name",
        set_name,
    ]
    try:
        completed = subprocess.run(  # noqa: S603 — fixed argv; cwd is place-match
            cmd,
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
            timeout=600,
        )
    except FileNotFoundError as exc:
        raise GraphError("uv is required to run MegaLoc embeddings (place-match).") from exc
    except subprocess.TimeoutExpired as exc:
        raise GraphError("MegaLoc embed timed out.") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[-800:]
        raise GraphError(f"MegaLoc embed failed: {detail or completed.returncode}")
    try:
        summary = json.loads(completed.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        raise GraphError("MegaLoc embed returned unreadable summary.") from exc
    if not summary.get("built"):
        raise GraphError("MegaLoc embed did not build an index.")
    if not summary.get("index"):
        raise GraphError("MegaLoc embed summary missing index path.")
    return summary


def _write_locations_json(index_dir: Path) -> None:
    index_txt = index_dir / "index.txt"
    if not index_txt.is_file():
        raise GraphError("MegaLoc index missing index.txt.")
    lines = index_txt.read_text(encoding="utf-8").splitlines()
    locations: dict[str, str] = {}
    for image_id in lines[1:]:
        if not image_id:
            continue
        rel = image_id.split(":", 1)[-1]
        locations[image_id] = rel.split("/", 1)[0]
    (index_dir / "locations.json").write_text(
        json.dumps(locations, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _zip_index_dir(index_dir: Path) -> bytes:
    _write_locations_json(index_dir)
    missing = [name for name in ("vectors.npy", "index.txt") if not (index_dir / name).is_file()]
    if missing:
        raise GraphError(f"MegaLoc index incomplete: missing {', '.join(missing)}")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in INDEX_ZIP_NAMES:
            path = index_dir / name
            if path.is_file():
                zf.write(path, arcname=name)
    return buffer.getvalue()


def _materialize_photos(photos: list[ReferencePhoto], dest: Path) -> None:
    for ref in photos:
        assert ref.node_id is not None
        ext = Path(ref.asset.storage_key).suffix.lower() or ".jpg"
        if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
            ext = ".jpg"
        folder = dest / str(ref.node_id)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{ref.id}{ext}").write_bytes(read_bytes(ref.asset.storage_key))


def _profile_from_summary(
    summary: dict[str, Any], index_dir: Path, n_photos: int
) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    meta_path = index_dir / "meta.json"
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            meta = {}
    backend_key = summary.get("backend_key") or meta.get("backend_key") or summary.get("backend")
    return {
        "backend_name": BACKEND_NAME,
        "backend_key": backend_key,
        "n_references": summary.get("n_references") or meta.get("n_references") or n_photos,
        "n_locations": summary.get("n_locations") or meta.get("n_locations"),
        "dim": meta.get("dim"),
        "config": summary.get("config") or meta.get("config"),
        "built_at": summary.get("built_at") or meta.get("built_at"),
    }


@transaction.atomic
def build_reference_index(
    revision: Revision,
    *,
    actor,
    run_build: RunBuild | None = None,
) -> dict[str, Any]:
    """Embed eligible reference photos and store RevisionArtifact(kind=index)."""
    graph_svc._require_writable(actor, revision)
    photos = _eligible_photos(revision)
    if not photos:
        raise GraphError("No node-linked reference photos to embed.")

    rows = [(str(p.id), p.asset.sha256, str(p.node_id)) for p in photos]
    content_hash = compute_input_hash(rows)

    artifact, _created = RevisionArtifact.objects.select_for_update().get_or_create(
        revision=revision,
        kind="index",
        defaults={
            "state": RevisionArtifact.State.PENDING,
            "required": True,
            "input_content_hash": content_hash,
            "profile": {},
        },
    )
    if (
        artifact.state == RevisionArtifact.State.READY
        and artifact.asset_id
        and artifact.input_content_hash == content_hash
        and (artifact.profile or {}).get("backend_name") == BACKEND_NAME
    ):
        return _artifact_payload(artifact, skipped=True)

    artifact.state = RevisionArtifact.State.PENDING
    artifact.input_content_hash = content_hash
    artifact.error_code = ""
    artifact.save(update_fields=["state", "input_content_hash", "error_code"])

    runner = run_build or run_megaloc_build
    try:
        with tempfile.TemporaryDirectory(prefix="snapway-ref-index-") as tmp:
            tmp_path = Path(tmp)
            photos_dir = tmp_path / "photos"
            work_root = tmp_path / "sets"
            photos_dir.mkdir()
            work_root.mkdir()
            _materialize_photos(photos, photos_dir)
            set_name = f"r{str(revision.id).replace('-', '')[:16]}"
            summary = runner(
                references_dir=photos_dir,
                work_root=work_root,
                set_name=set_name,
            )
            index_dir = Path(summary["index"])
            raw_zip = _zip_index_dir(index_dir)
            digest = hashlib.sha256(raw_zip).hexdigest()
            storage_key = f"indexes/{revision.target_id}/{revision.id}/{digest[:16]}.zip"
            put_bytes(storage_key, raw_zip, "application/zip")
            profile = _profile_from_summary(summary, index_dir, len(photos))
            asset = Asset.objects.create(
                target=revision.target,
                uploaded_by=actor if getattr(actor, "is_authenticated", False) else None,
                kind=Asset.Kind.INDEX,
                storage_key=storage_key,
                content_type="application/zip",
                sha256=digest,
                byte_size=len(raw_zip),
                provenance={
                    "role": "megaloc_reference_index",
                    "revision_id": str(revision.id),
                    "input_content_hash": content_hash,
                },
            )
            artifact.asset = asset
            artifact.state = RevisionArtifact.State.READY
            artifact.profile = profile
            artifact.error_code = ""
            artifact.save(
                update_fields=["asset", "state", "profile", "error_code", "input_content_hash"]
            )
    except Exception as exc:
        artifact.state = RevisionArtifact.State.FAILED
        artifact.error_code = type(exc).__name__[:80]
        artifact.save(update_fields=["state", "error_code"])
        if isinstance(exc, GraphError):
            raise
        raise GraphError(f"Reference index build failed: {exc}") from exc

    return _artifact_payload(artifact, skipped=False)
