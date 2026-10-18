"""Underlay upload for draft revisions (display asset only; bytes via media_store)."""

from __future__ import annotations

import hashlib
import re
import uuid

from django.db import transaction

from maps.models import Asset, Revision
from maps.services.graph import GraphError, set_underlay
from maps.services.media_store import put_bytes, signed_url

MAX_BYTES = 5 * 1024 * 1024
ALLOWED = {
    "image/png": (".png", Asset.Kind.SOURCE),
    "image/jpeg": (".jpg", Asset.Kind.SOURCE),
    "image/webp": (".webp", Asset.Kind.SOURCE),
    "image/svg+xml": (".svg", Asset.Kind.SVG),
}

_SCRIPTISH = re.compile(
    r"<\s*script|javascript:|on\w+\s*=",
    re.IGNORECASE,
)


def _reject_active_svg(raw: bytes) -> None:
    text = raw.decode("utf-8", errors="ignore")
    if _SCRIPTISH.search(text):
        raise GraphError("SVG underlay must not contain script or event handlers.")
    try:
        import defusedxml.ElementTree as etree

        etree.fromstring(raw)
    except Exception as exc:  # noqa: BLE001 — surface as validation
        raise GraphError(f"Invalid SVG: {exc}") from exc


@transaction.atomic
def store_underlay_file(
    revision: Revision,
    *,
    uploaded_file,
    actor,
    content_type: str | None = None,
) -> dict:
    """Persist upload via media_store, create Asset, attach as revision.source_asset."""
    from maps.services.graph import _require_writable

    _require_writable(actor, revision)
    ctype = (content_type or getattr(uploaded_file, "content_type", "") or "").lower()
    if ctype not in ALLOWED:
        raise GraphError("Underlay must be PNG, JPEG, WebP, or SVG.")
    raw = uploaded_file.read()
    if not raw:
        raise GraphError("Empty upload.")
    if len(raw) > MAX_BYTES:
        raise GraphError(f"Underlay exceeds {MAX_BYTES // (1024 * 1024)} MiB limit.")
    if ctype == "image/svg+xml":
        _reject_active_svg(raw)

    ext, kind = ALLOWED[ctype]
    digest = hashlib.sha256(raw).hexdigest()
    storage_key = f"underlays/{revision.target_id}/{uuid.uuid4().hex}{ext}"

    width = height = None
    if ctype != "image/svg+xml":
        try:
            import io

            from PIL import Image

            with Image.open(io.BytesIO(raw)) as img:
                width, height = img.size
        except Exception as exc:  # noqa: BLE001
            raise GraphError("Upload a valid PNG, JPEG or WebP image.") from exc

    if ctype == "image/svg+xml":
        import defusedxml.ElementTree as etree

        root = etree.fromstring(raw)
        viewbox = root.attrib.get("viewBox", "").replace(",", " ").split()
        if len(viewbox) == 4:
            import math

            values = [float(value) for value in viewbox]
            if (
                not all(math.isfinite(value) for value in values)
                or values[2] <= 0
                or values[3] <= 0
            ):
                raise GraphError("SVG must have a finite, positive viewBox.")
            width, height = max(1, round(values[2])), max(1, round(values[3]))

    frame = dict(revision.coordinate_frame or {})
    if width and height:
        frame.update({"origin": "top_left", "width": width, "height": height, "units": "plan"})
    elif "width" not in frame:
        frame.update({"origin": "top_left", "width": 1000, "height": 640, "units": "plan"})

    put_bytes(storage_key, raw, ctype)
    asset = Asset.objects.create(
        target=revision.target,
        uploaded_by=actor,
        kind=kind,
        storage_key=storage_key,
        content_type=ctype,
        sha256=digest,
        byte_size=len(raw),
        width=width,
        height=height,
        provenance={"role": "graph_underlay"},
    )
    set_underlay(revision, asset=asset, actor=actor, frame=frame)
    return {
        "asset_id": str(asset.id),
        "underlay_url": signed_url(storage_key),
        "coordinate_frame": frame,
    }
