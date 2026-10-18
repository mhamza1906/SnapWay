"""Node reference photo attach/list/remove (Asset + ReferencePhoto; bytes via media_store)."""

from __future__ import annotations

import hashlib
import uuid

from django.db import transaction

from maps.models import Asset, Node, ReferencePhoto, Revision
from maps.services import graph as graph_svc
from maps.services.graph import GraphError
from maps.services.media_store import point_photo_storage_ready, put_bytes, signed_url

MAX_BYTES = 5 * 1024 * 1024
ALLOWED = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
# The four reference views taken at each photo point, relative to the walking
# direction. One photo per direction per node; a new one replaces the old.
DIRECTIONS = ("front", "right", "back", "left")


class PhotoStorageUnavailable(RuntimeError):
    """Directional photos are stored in Cloudflare R2 only; it is not configured."""


def _direction(ref) -> str | None:
    value = (ref.capture_context or {}).get("direction")
    return value if value in DIRECTIONS else None


def list_node_photos(revision: Revision, *, node_id, actor) -> list[dict]:
    graph_svc._require_writable(actor, revision)
    try:
        node = revision.nodes.get(pk=node_id)
    except Node.DoesNotExist as exc:
        raise GraphError("Node not found on this revision.") from exc
    rows = (
        ReferencePhoto.objects.filter(revision=revision, node=node)
        .select_related("asset")
        .order_by("created_at")
    )
    return [
        {
            "id": str(ref.id),
            "asset_id": str(ref.asset_id),
            "url": signed_url(ref.asset.storage_key),
            "content_type": ref.asset.content_type,
            "byte_size": ref.asset.byte_size,
            "status": ref.status,
            "direction": _direction(ref),
        }
        for ref in rows
    ]


@transaction.atomic
def attach_node_photo(
    revision: Revision,
    *,
    node_id,
    uploaded_file,
    actor,
    content_type: str | None = None,
    direction: str | None = None,
) -> dict:
    graph_svc._require_writable(actor, revision)
    try:
        # Serialize replacements on this point, including simultaneous uploads
        # from two clients, so a direction never gains two active references.
        node = revision.nodes.select_for_update().get(pk=node_id)
    except Node.DoesNotExist as exc:
        raise GraphError("Node not found on this revision.") from exc
    if direction is not None and not isinstance(direction, str):
        raise GraphError("direction must be front, right, back or left.")
    direction = (direction or "").strip().lower() or None
    if direction is not None and direction not in DIRECTIONS:
        raise GraphError("direction must be front, right, back or left.")
    if direction is not None and not point_photo_storage_ready():
        raise PhotoStorageUnavailable(
            "Point photos are stored in Cloudflare R2 only. Set the R2 bucket settings "
            "(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME or S3_*) "
            "in the API's server env."
        )

    ctype = (content_type or getattr(uploaded_file, "content_type", "") or "").lower()
    if ctype not in ALLOWED:
        raise GraphError("Node photo must be PNG, JPEG, or WebP.")
    raw = uploaded_file.read()
    if not raw:
        raise GraphError("Empty upload.")
    if len(raw) > MAX_BYTES:
        raise GraphError(f"Photo exceeds {MAX_BYTES // (1024 * 1024)} MiB limit.")

    ext = ALLOWED[ctype]
    digest = hashlib.sha256(raw).hexdigest()
    storage_key = f"photos/{revision.target_id}/{node.id}/{uuid.uuid4().hex}{ext}"
    width = height = None
    try:
        import io

        from PIL import Image

        with Image.open(io.BytesIO(raw)) as img:
            width, height = img.size
            if direction is not None:
                if Image.MIME.get(img.format) != ctype:
                    raise ValueError("Image format does not match its content type.")
                img.verify()
    except Exception:  # noqa: BLE001
        if direction is not None:
            raise GraphError("Upload a valid PNG, JPEG, or WebP image.") from None
        width = height = None

    try:
        storage_key = put_bytes(storage_key, raw, ctype)
        url = signed_url(storage_key)
    except Exception:
        if direction is not None:
            raise PhotoStorageUnavailable(
                "Could not save the photo to Cloudflare R2. Try again."
            ) from None
        raise

    asset = Asset.objects.create(
        target=revision.target,
        uploaded_by=actor,
        kind=Asset.Kind.PHOTO,
        storage_key=storage_key,
        content_type=ctype,
        sha256=digest,
        byte_size=len(raw),
        width=width,
        height=height,
        provenance={"role": "node_reference_photo", "node_id": str(node.id)},
    )
    if direction is not None:
        # Replace this node's earlier photo for the same direction (assets stay).
        for old in ReferencePhoto.objects.filter(revision=revision, node=node):
            if _direction(old) == direction:
                old.delete()
    ref = ReferencePhoto.objects.create(
        revision=revision,
        asset=asset,
        node=node,
        status=ReferencePhoto.Status.PROPOSED,
        capture_context={"direction": direction} if direction else {},
    )
    return {
        "id": str(ref.id),
        "asset_id": str(asset.id),
        "url": url,
        "content_type": ctype,
        "byte_size": len(raw),
        "status": ref.status,
        "direction": direction,
    }


@transaction.atomic
def remove_node_photo(revision: Revision, *, reference_id, actor) -> None:
    """Detach a ReferencePhoto. Asset rows are append-only — leave bytes + Asset intact."""
    graph_svc._require_writable(actor, revision)
    try:
        ref = ReferencePhoto.objects.get(pk=reference_id, revision=revision)
    except ReferencePhoto.DoesNotExist as exc:
        raise GraphError("Reference photo not found on this revision.") from exc
    ref.delete()
