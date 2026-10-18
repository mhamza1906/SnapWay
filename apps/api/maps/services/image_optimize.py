"""GPT Image 2.5 floor-plan raster optimization for the authoring upload chain.

Stores the original as Asset(kind=source) and the model result as
Asset(kind=standardized) on the draft revision. Does not call Vectorizer.AI.
"""

from __future__ import annotations

import base64
import hashlib
import io
import uuid
from pathlib import Path

from django.conf import settings
from django.core.files.storage import default_storage
from django.db import transaction

from maps.models import Asset, Revision
from maps.services.graph import GraphError, _require_writable
from maps.services.media_store import put_bytes, signed_url

ROOT = Path(settings.BASE_DIR).resolve().parents[1]
PROMPT_FILE = ROOT / "docs/audits/assets/2026-10-17-gpt-fullchain/raster-prompt.txt"
STAGE = "image_optimize"
MAX_BYTES = 5 * 1024 * 1024
ALLOWED = {"image/png", "image/jpeg", "image/webp"}


class ImageOptimizeError(GraphError):
    """User-facing optimize failure."""


def default_prompt() -> str:
    if PROMPT_FILE.is_file():
        return PROMPT_FILE.read_text(encoding="utf-8").strip()
    return (
        "Reconstruct this indoor floor plan as a clean orthographic drawing on white. "
        "Preserve walls, doors, stairs and proportions. Remove all text and labels."
    )


def _model() -> str:
    return getattr(settings, "OPENAI_IMAGE_MODEL", None) or "gpt-image-2.5-sunburst"


def _api_key() -> str:
    key = (getattr(settings, "OPENAI_API_KEY", None) or "").strip()
    if not key:
        raise ImageOptimizeError(
            "OPENAI_API_KEY is not configured. Obtain the private key through the "
            "external channel into local/.env before running image optimization."
        )
    return key


def _read_upload(uploaded_file) -> tuple[bytes, str]:
    ctype = (getattr(uploaded_file, "content_type", "") or "").lower()
    if ctype not in ALLOWED:
        raise ImageOptimizeError("Upload a PNG, JPEG, or WebP floor plan for optimization.")
    raw = uploaded_file.read()
    if not raw:
        raise ImageOptimizeError("Empty upload.")
    if len(raw) > MAX_BYTES:
        raise ImageOptimizeError(f"Image exceeds {MAX_BYTES // (1024 * 1024)} MiB limit.")
    try:
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as img:
            img.verify()
    except Exception as exc:  # noqa: BLE001
        raise ImageOptimizeError("Upload a valid PNG, JPEG or WebP image.") from exc
    return raw, ctype


def _read_storage(storage_key: str) -> bytes:
    with default_storage.open(storage_key, "rb") as handle:
        return handle.read()


def _image_size(raw: bytes) -> tuple[int, int]:
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as img:
        return img.size


def edit_floor_image(*, image_bytes: bytes, content_type: str, prompt: str) -> bytes:
    """Call OpenAI Images Edit (gpt-image-2.5-sunburst). Overridable in tests."""
    from openai import OpenAI

    client = OpenAI(api_key=_api_key(), timeout=600.0)
    ext = {".png": "png", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(
        content_type, "png"
    )
    name = f"floor.{ext if ext != 'jpg' else 'jpg'}"
    result = client.images.edit(
        model=_model(),
        image=(name, image_bytes, content_type if content_type in ALLOWED else "image/png"),
        prompt=prompt,
        size="1536x1024",
        quality="high",
        background="opaque",
        output_format="png",
        n=1,
    )
    data = result.data[0] if result.data else None
    if data is None:
        raise ImageOptimizeError("The image model returned no image data.")
    if getattr(data, "b64_json", None):
        return base64.b64decode(data.b64_json)
    url = getattr(data, "url", None)
    if not url:
        raise ImageOptimizeError("The image model returned neither b64_json nor a URL.")
    import urllib.request

    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 — OpenAI CDN URL
        return response.read()


def _store_asset(
    revision: Revision,
    *,
    raw: bytes,
    content_type: str,
    kind: str,
    actor,
    role: str,
    source: Asset | None = None,
) -> Asset:
    ext = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
    }.get(content_type, ".bin")
    width = height = None
    if content_type != "image/svg+xml":
        width, height = _image_size(raw)
    key = f"optimize/{revision.target_id}/{uuid.uuid4().hex}{ext}"
    put_bytes(key, raw, content_type)
    return Asset.objects.create(
        target=revision.target,
        uploaded_by=actor,
        kind=kind,
        storage_key=key,
        content_type=content_type,
        sha256=hashlib.sha256(raw).hexdigest(),
        byte_size=len(raw),
        width=width,
        height=height,
        source_asset=source,
        provenance={"role": role, "model": _model() if kind == Asset.Kind.STANDARDIZED else None},
    )


def optimize_status(revision: Revision) -> dict:
    """Status for the review page. After the first Image 2.5 success, SoT is optimized."""
    sot = revision.standardized_asset or revision.source_asset
    geometry = dict(revision.geometry or {})
    authoring = dict(geometry.get("authoring") or {})
    url = signed_url(sot.storage_key) if sot else None
    return {
        "revision_id": str(revision.id),
        "target_id": str(revision.target_id),
        "stage": authoring.get("stage") or ("image_optimize" if optimized_id(revision) else "empty"),
        "model": authoring.get("model") or _model(),
        # User upload is discarded after first optimize; both URLs point at the SoT raster.
        "source_url": url,
        "optimized_url": url,
        "coordinate_frame": revision.coordinate_frame,
        "disclosure": authoring.get("disclosure"),
        "vector_url": authoring.get("vector_url"),
        "vector_mock": bool(authoring.get("vector_mock")),
    }


def optimized_id(revision: Revision):
    return revision.standardized_asset_id


def _install_optimized_sot(
    revision: Revision,
    *,
    optimized: Asset,
    discard: Asset | None,
    frame: dict,
    authoring: dict,
) -> None:
    """Point the revision at the Image 2.5 raster as SoT.

    ``maps_asset`` is append-only on PostgreSQL (no UPDATE/DELETE outside retention
    purge). The user upload / previous SoT Asset row may remain as an unused
    orphan; display and regenerate only follow the revision FKs.
    """
    del discard  # Logical discard only — Asset rows stay for append-only integrity.
    revision.source_asset = optimized
    revision.standardized_asset = optimized
    revision.coordinate_frame = frame
    revision.geometry = {**(revision.geometry or {}), "authoring": authoring}
    revision.save(
        update_fields=["source_asset", "standardized_asset", "coordinate_frame", "geometry"]
    )


@transaction.atomic
def start_optimize(revision: Revision, *, uploaded_file, actor, prompt: str | None = None) -> dict:
    """Run Image 2.5 on the upload, then discard the upload — optimized raster is SoT."""
    _require_writable(actor, revision)
    raw, ctype = _read_upload(uploaded_file)
    upload = _store_asset(
        revision,
        raw=raw,
        content_type=ctype,
        kind=Asset.Kind.SOURCE,
        actor=actor,
        role="optimize_upload_ephemeral",
    )
    text = (prompt or default_prompt()).strip() or default_prompt()
    try:
        optimized_bytes = edit_floor_image(image_bytes=raw, content_type=ctype, prompt=text)
    except ImageOptimizeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ImageOptimizeError(f"Image optimization failed: {exc}") from exc
    optimized = _store_asset(
        revision,
        raw=optimized_bytes,
        content_type="image/png",
        kind=Asset.Kind.STANDARDIZED,
        actor=actor,
        role="gpt_image_2_5_optimized",
        source=None,
    )
    frame = dict(revision.coordinate_frame or {})
    if optimized.width and optimized.height:
        frame.update(
            {
                "origin": "top_left",
                "width": optimized.width,
                "height": optimized.height,
                "units": "plan",
            }
        )
    authoring = {
        "stage": STAGE,
        "model": _model(),
        "prompt_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "source_of_truth": "standardized",
    }
    _install_optimized_sot(
        revision,
        optimized=optimized,
        discard=upload,
        frame=frame,
        authoring=authoring,
    )
    return optimize_status(revision)


@transaction.atomic
def regenerate_optimize(
    revision: Revision, *, actor, prompt: str | None = None
) -> dict:
    """Re-run Image 2.5 using the current SoT raster as the template."""
    _require_writable(actor, revision)
    template = revision.standardized_asset or revision.source_asset
    if not template:
        raise ImageOptimizeError("Optimize a floor plan before regenerating.")
    raw = _read_storage(template.storage_key)
    ctype = template.content_type or "image/png"
    text = (prompt or default_prompt()).strip() or default_prompt()
    try:
        optimized_bytes = edit_floor_image(image_bytes=raw, content_type=ctype, prompt=text)
    except ImageOptimizeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ImageOptimizeError(f"Image regeneration failed: {exc}") from exc
    optimized = _store_asset(
        revision,
        raw=optimized_bytes,
        content_type="image/png",
        kind=Asset.Kind.STANDARDIZED,
        actor=actor,
        role="gpt_image_2_5_regenerated",
        source=None,
    )
    frame = dict(revision.coordinate_frame or {})
    if optimized.width and optimized.height:
        frame.update(
            {
                "origin": "top_left",
                "width": optimized.width,
                "height": optimized.height,
                "units": "plan",
            }
        )
    authoring = dict((revision.geometry or {}).get("authoring") or {})
    authoring.update(
        {
            "stage": STAGE,
            "model": _model(),
            "prompt_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "regenerated": True,
            "source_of_truth": "standardized",
        }
    )
    authoring.pop("vector_url", None)
    authoring.pop("vector_mock", None)
    authoring.pop("disclosure", None)
    previous = template
    _install_optimized_sot(
        revision,
        optimized=optimized,
        discard=previous,
        frame=frame,
        authoring=authoring,
    )
    return optimize_status(revision)
