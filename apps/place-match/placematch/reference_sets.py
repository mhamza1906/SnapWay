"""Named reference sets for the mobile API.

A set is a folder of reference photos (first-level subfolders = ``location_id``) copied into
``data/references/<name>/images/`` with a manifest and one embedding index per backend key.
Indexes from different backends are never mixed; each lives in its own directory.
"""

from __future__ import annotations

import json
import re
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from placematch.backends.base import EmbeddingBackend, EmbeddingIndex, EmbedStats, RequestBudget
from placematch.cache import backend_slug
from placematch.env import DATA_DIR
from placematch.schemas import Manifest, ManifestEntry

REFERENCE_ROOT = DATA_DIR / "references"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

Log = Callable[[str], None]


def validate_name(name: str) -> str:
    if not NAME_RE.match(name or ""):
        raise ValueError(
            "reference set names use letters, digits, '.', '_' or '-' (max 64 characters)"
        )
    return name


@dataclass
class ReferenceSet:
    name: str
    directory: Path
    manifest: Manifest
    by_id: dict[str, ManifestEntry] = field(default_factory=dict)

    @classmethod
    def load(cls, name: str, root: Path = REFERENCE_ROOT) -> ReferenceSet:
        directory = Path(root) / validate_name(name)
        manifest_path = directory / "manifest.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(f"reference set {name!r} not found at {directory}")
        manifest = Manifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
        return cls(name, directory, manifest, {e.image_id: e for e in manifest.entries})

    def image_path(self, reference_id: str) -> Path:
        entry = self.by_id[reference_id]
        return self.manifest.resolve(entry, self.directory / "manifest.json")

    def location_of(self, reference_id: str) -> str | None:
        entry = self.by_id.get(reference_id)
        return entry.location_id if entry else None

    def index_dir(self, backend_key: str) -> Path:
        return self.directory / "index" / backend_slug(backend_key)

    def load_index(self, backend_key: str) -> EmbeddingIndex | None:
        directory = self.index_dir(backend_key)
        if not (directory / "index.txt").is_file():
            return None
        index = EmbeddingIndex.load(directory)
        if index.backend_key != backend_key:
            raise ValueError(
                f"index in {directory} is for {index.backend_key!r}, not {backend_key!r}"
            )
        unknown = [i for i in index.image_ids if i not in self.by_id]
        if unknown:
            raise ValueError(f"index has ids missing from the manifest: {unknown[:3]}")
        return index


def _copy_references(source: Path, images_dir: Path) -> None:
    if images_dir.exists():
        shutil.rmtree(images_dir)
    shutil.copytree(source, images_dir, ignore=shutil.ignore_patterns(".*"))


def build_reference_set(
    references: Path,
    name: str,
    backend: EmbeddingBackend,
    *,
    limit: int | None = None,
    dry_run: bool = False,
    root: Path = REFERENCE_ROOT,
    log: Log = print,
) -> dict:
    """Copy ``references`` into a named set and embed it with one backend.

    Shows the expected uncached remote requests first (as ``embed`` does). Remote backends
    refuse to send anything when that exceeds ``limit``. Returns a JSON-safe summary.
    """
    from placematch import frames, retrieval
    from placematch.app import folder_locations

    validate_name(name)
    references = Path(references).expanduser().resolve()
    if not references.is_dir():
        raise FileNotFoundError(f"reference folder not found: {references}")
    directory = Path(root) / name
    images_dir = directory / "images"
    manifest_path = directory / "manifest.json"
    directory.mkdir(parents=True, exist_ok=True)
    if not dry_run or not manifest_path.is_file():
        _copy_references(references, images_dir)
        entries = frames.ingest_images(
            images_dir,
            "reference",
            dataset="user",
            location_map=folder_locations(images_dir),
        )
        if not entries:
            raise ValueError(f"no supported reference images under {references}")
        missing = [e.image_id for e in entries if e.location_id is None]
        if missing:
            log(
                f"warning: {len(missing)} image(s) are not in a location subfolder and have no "
                f"location_id (e.g. {missing[0]}); margins and second opinions need location ids"
            )
        manifest = Manifest(
            name=f"references:{name}",
            description="Mobile API reference set",
            entries=entries,
            notes={"source_folder_name": references.name},
        )
        manifest_path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    ref_set = ReferenceSet.load(name, root)
    estimate = retrieval.estimate(ref_set.manifest, manifest_path, backend)
    log(json.dumps({"backend": backend.key, **estimate}, indent=2, default=str))
    summary = {"name": name, "backend": backend.key, "estimate": estimate, "built": False}
    if dry_run:
        return summary
    budget = RequestBudget(limit=limit)
    expected = int(estimate.get("expected_requests", 0) or 0)
    if backend.remote and limit is not None and expected > limit:
        raise RuntimeError(
            f"{expected} uncached request(s) needed but --limit is {limit}; nothing was sent"
        )
    ids = [e.image_id for e in ref_set.manifest.entries]
    paths = [ref_set.image_path(i) for i in ids]
    stats = EmbedStats()
    t0 = time.perf_counter()
    vectors = backend.embed_paths(paths, budget=budget, stats=stats)
    if stats.failed:
        raise RuntimeError(f"{len(stats.failed)} reference(s) failed: {stats.failed[:3]}")
    index = EmbeddingIndex(backend.key, ids, vectors)
    out = ref_set.index_dir(backend.key)
    index.save(out)
    meta = {
        "backend_key": backend.key,
        "config": backend.config(),
        "n_references": len(ids),
        "n_locations": len({e.location_id for e in ref_set.manifest.entries if e.location_id}),
        "api_requests": stats.api_requests,
        "cache_hits": stats.cache_hits,
        "elapsed_s": round(time.perf_counter() - t0, 3),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2, default=str), encoding="utf-8")
    log(f"index written to {out} ({len(ids)} references, {stats.api_requests} API requests)")
    return {**summary, "built": True, "index": str(out), **meta}
