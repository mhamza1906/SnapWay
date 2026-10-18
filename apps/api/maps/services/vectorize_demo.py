"""Demo-only vectorization stub.

No Vectorizer.AI subscription is active. This route always returns the prepared
IA floor-4 demonstration SVG (temporarily served from the committed Figma floor-1
export until real floor-4 assets are placed under local/prebuilt/ia-4/).
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from django.conf import settings
from django.db import transaction

from maps.models import Asset, Revision, RevisionArtifact
from maps.services.graph import GraphError, _require_writable
from maps.services.media_store import put_bytes, signed_url

ROOT = Path(settings.BASE_DIR).resolve().parents[1]
# Prefer a real floor-4 prep path when present; otherwise the committed Figma SVG.
PREFERRED = ROOT / "local/prebuilt/ia-4/floor.svg"
FALLBACK = ROOT / "docs/audits/assets/2026-10-17-figma-vectorization/figma-vector.svg"
MOCK_FLOOR_ID = "ia-4"
DISCLOSURE = (
    "A commercial automated API service is available, but we have not paid for it; "
    "this demonstration shows the resulting experience only. The current result is a "
    "manually prebuilt Figma vector of IA floor 4, not a live API generation."
)


class VectorizeDemoError(GraphError):
    """User-facing demo vectorize failure."""


def demo_svg_path() -> Path:
    if PREFERRED.is_file():
        return PREFERRED
    if FALLBACK.is_file():
        return FALLBACK
    raise VectorizeDemoError(
        "Demo vector asset is missing. Place IA floor 4 SVG at "
        "local/prebuilt/ia-4/floor.svg or restore the committed Figma export."
    )


@transaction.atomic
def apply_demo_vector(revision: Revision, *, actor) -> dict:
    """Attach the fixed floor-4 demo SVG and mark authoring as vectorized_demo."""
    _require_writable(actor, revision)
    if not revision.standardized_asset_id and not revision.source_asset_id:
        raise VectorizeDemoError("Optimize a floor plan image before vectorizing.")
    path = demo_svg_path()
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    key = f"vectorize-demo/{revision.target_id}/{uuid.uuid4().hex}.svg"
    put_bytes(key, raw, "image/svg+xml")
    asset = Asset.objects.create(
        target=revision.target,
        uploaded_by=actor,
        kind=Asset.Kind.SVG,
        storage_key=key,
        content_type="image/svg+xml",
        sha256=digest,
        byte_size=len(raw),
        provenance={
            "role": "vectorize_demo",
            "mock": True,
            "floorId": MOCK_FLOOR_ID,
            "provider": "prebuilt-figma",
            "source_path": str(path.relative_to(ROOT)).replace("\\", "/"),
        },
    )
    content_hash = revision.content_hash or ("0" * 64)
    existing = revision.artifacts.filter(kind="svg").first()
    if existing:
        existing.state = RevisionArtifact.State.READY
        existing.asset = asset
        existing.input_content_hash = content_hash
        existing.profile = {
            "mock": True,
            "floorId": MOCK_FLOOR_ID,
            "provider": "prebuilt-figma",
        }
        existing.error_code = ""
        existing.save()
    else:
        RevisionArtifact.objects.create(
            revision=revision,
            kind="svg",
            state=RevisionArtifact.State.READY,
            asset=asset,
            input_content_hash=content_hash,
            required=False,
            profile={"mock": True, "floorId": MOCK_FLOOR_ID, "provider": "prebuilt-figma"},
        )
    geometry = dict(revision.geometry or {})
    authoring = dict(geometry.get("authoring") or {})
    vector_url = signed_url(key)
    authoring.update(
        {
            "stage": "vectorized_demo",
            "vector_mock": True,
            "vector_floor_id": MOCK_FLOOR_ID,
            "vector_url": vector_url,
            "disclosure": DISCLOSURE,
        }
    )
    geometry["authoring"] = authoring
    revision.geometry = geometry
    revision.save(update_fields=["geometry"])
    return {
        "floorId": MOCK_FLOOR_ID,
        "mock": True,
        "provider": "prebuilt-figma",
        "navigationReady": False,
        "disclosure": DISCLOSURE,
        "svg_url": vector_url,
        "sha256": digest,
        "stage": "vectorized_demo",
    }
