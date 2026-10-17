"""Union MegaLoc index built from SnapWay revision index zips (visitor global search)."""

from __future__ import annotations

import io
import json
import threading
import zipfile
from dataclasses import dataclass, field

import numpy as np

from placematch.backends.base import EmbeddingIndex, l2_normalize


@dataclass
class CatalogSetInfo:
    set_key: str
    content_hash: str
    revision_id: str
    target_id: str
    n_vectors: int


@dataclass
class CatalogRow:
    """One reference vector's SnapWay metadata (aligned with EmbeddingIndex.image_ids)."""

    set_key: str
    content_hash: str
    revision_id: str
    target_id: str
    reference_id: str
    node_id: str


@dataclass
class _LoadedSet:
    info: CatalogSetInfo
    index: EmbeddingIndex
    rows: list[CatalogRow]


@dataclass
class GlobalCatalog:
    """In-memory union of per-revision MegaLoc indexes."""

    loaded: dict[str, _LoadedSet] = field(default_factory=dict)
    index: EmbeddingIndex | None = None
    rows: list[CatalogRow] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "sets": [
                    {
                        "set_key": s.info.set_key,
                        "content_hash": s.info.content_hash,
                        "revision_id": s.info.revision_id,
                        "target_id": s.info.target_id,
                        "n_vectors": s.info.n_vectors,
                    }
                    for s in sorted(self.loaded.values(), key=lambda x: x.info.set_key)
                ],
                "n_vectors": len(self.rows),
            }

    def sync(self, desired: list[dict], zips: dict[str, bytes]) -> dict:
        """Replace catalog to match ``desired``; ``zips`` keyed by set_key for new/changed sets."""
        with self.lock:
            desired_by_key = {d["set_key"]: d for d in desired}
            next_loaded: dict[str, _LoadedSet] = {}

            for set_key, spec in desired_by_key.items():
                content_hash = spec["content_hash"]
                prev = self.loaded.get(set_key)
                if prev and prev.info.content_hash == content_hash:
                    # Refresh identity fields if Django resent them with same hash.
                    prev.info.revision_id = spec["revision_id"]
                    prev.info.target_id = spec["target_id"]
                    for row in prev.rows:
                        row.revision_id = spec["revision_id"]
                        row.target_id = spec["target_id"]
                    next_loaded[set_key] = prev
                    continue
                raw = zips.get(set_key)
                if raw is None:
                    raise ValueError(f"missing zip bytes for set_key {set_key!r}")
                index, rows = load_index_zip(
                    raw,
                    set_key=set_key,
                    content_hash=content_hash,
                    revision_id=spec["revision_id"],
                    target_id=spec["target_id"],
                )
                info = CatalogSetInfo(
                    set_key=set_key,
                    content_hash=content_hash,
                    revision_id=spec["revision_id"],
                    target_id=spec["target_id"],
                    n_vectors=len(rows),
                )
                next_loaded[set_key] = _LoadedSet(info, index, rows)

            self.loaded = next_loaded
            self._rebuild_union()
            return self.snapshot()

    def _rebuild_union(self) -> None:
        if not self.loaded:
            self.index = None
            self.rows = []
            return
        keys = {item.index.backend_key for item in self.loaded.values()}
        if len(keys) != 1:
            raise ValueError(f"refusing to merge indexes with different backend keys: {keys}")
        backend_key = next(iter(keys))
        all_ids: list[str] = []
        all_rows: list[CatalogRow] = []
        mats: list[np.ndarray] = []
        for item in sorted(self.loaded.values(), key=lambda x: x.info.set_key):
            for rid, row in zip(item.index.image_ids, item.rows, strict=True):
                all_ids.append(f"{row.set_key}::{rid}")
                all_rows.append(row)
            mats.append(np.asarray(item.index.vectors, dtype=np.float32))
        self.index = EmbeddingIndex(backend_key, all_ids, l2_normalize(np.vstack(mats)))
        self.rows = all_rows

    def rows_by_union_id(self) -> dict[str, CatalogRow]:
        if self.index is None:
            return {}
        return dict(zip(self.index.image_ids, self.rows, strict=True))


def load_index_zip(
    raw: bytes,
    *,
    set_key: str,
    content_hash: str,
    revision_id: str,
    target_id: str,
) -> tuple[EmbeddingIndex, list[CatalogRow]]:
    """Parse a SnapWay revision index zip into an EmbeddingIndex + row metadata."""
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = set(zf.namelist())
        for required in ("vectors.npy", "index.txt"):
            if required not in names:
                raise ValueError(f"index zip missing {required}")
        vectors = np.load(io.BytesIO(zf.read("vectors.npy")))
        lines = zf.read("index.txt").decode("utf-8").splitlines()
        if not lines:
            raise ValueError("index.txt empty")
        zip_backend = lines[0].strip()
        image_ids = [ln.strip() for ln in lines[1:] if ln.strip()]
        locations: dict[str, str] = {}
        if "locations.json" in names:
            locations = json.loads(zf.read("locations.json").decode("utf-8"))

    if not zip_backend:
        raise ValueError("index.txt missing backend_key")
    if len(image_ids) != int(np.asarray(vectors).shape[0]):
        raise ValueError(
            f"index size mismatch: {len(image_ids)} ids vs {np.asarray(vectors).shape[0]} vectors"
        )
    vectors = l2_normalize(np.asarray(vectors, dtype=np.float32))
    rows: list[CatalogRow] = []
    for image_id in image_ids:
        node_id = locations.get(image_id) or _node_from_image_id(image_id)
        if not node_id:
            raise ValueError(f"no node_id for reference {image_id!r}")
        rows.append(
            CatalogRow(
                set_key=set_key,
                content_hash=content_hash,
                revision_id=revision_id,
                target_id=target_id,
                reference_id=image_id,
                node_id=str(node_id),
            )
        )
    return EmbeddingIndex(zip_backend, image_ids, vectors), rows


def _node_from_image_id(image_id: str) -> str | None:
    """Fallback: ``reference:<node_id>/<ref>.ext`` → node_id."""
    rel = image_id.split(":", 1)[-1]
    if "/" in rel:
        return rel.split("/", 1)[0]
    return None


def cross_target_uncertain(
    candidates: list,
    rows_by_union_id: dict[str, CatalogRow],
    *,
    min_margin: float,
) -> bool:
    """True when top-1/top-2 are different floors/targets and cosine margin is thin."""
    if len(candidates) < 2:
        return False
    r0 = rows_by_union_id.get(candidates[0].reference_id)
    r1 = rows_by_union_id.get(candidates[1].reference_id)
    if r0 is None or r1 is None:
        return False
    if r0.target_id == r1.target_id:
        return False
    return float(candidates[0].cosine) - float(candidates[1].cosine) < min_margin
