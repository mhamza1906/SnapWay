"""Node reference photo attach/list/remove (Asset + ReferencePhoto; bytes via media_store)."""

from __future__ import annotations

import hashlib
import io
import uuid

from django.db import transaction

from maps.models import Asset, Node, ReferencePhoto, Revision, SceneRelationship
from maps.services import graph as graph_svc
from maps.services.graph import GraphError
from maps.services.media_store import point_photo_storage_ready, put_bytes, signed_url

MAX_BYTES = 5 * 1024 * 1024
ALLOWED = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
DIRECTIONS = {"front": 0, "right": 90, "back": 180, "left": 270}


class PhotoStorageUnavailable(RuntimeError):
    """Directional photos require configured Cloudflare R2 storage."""


def photo_payload(ref):
    return {
        "id": str(ref.id),
        "asset_id": str(ref.asset_id),
        "url": signed_url(ref.asset.storage_key),
        "content_type": ref.asset.content_type,
        "byte_size": ref.asset.byte_size,
        "status": ref.status,
        "direction": ref.capture_context.get("direction"),
        "heading_degrees": float(ref.heading_degrees) if ref.heading_degrees is not None else None,
        "capture_context": ref.capture_context,
        "embedding_status": "not_connected",
    }


def list_node_photos(revision: Revision, *, node_id, actor) -> list[dict]:
    # Reading photos does not mutate edit timestamps or require a write lock.
    from maps.services.membership import get_active_membership

    if get_active_membership(actor, revision.target) is None:
        raise PermissionError("Map membership is required.")
    try:
        node = revision.nodes.get(pk=node_id)
    except Node.DoesNotExist as exc:
        raise GraphError("Node not found on this revision.") from exc
    rows = (
        ReferencePhoto.objects.filter(revision=revision, node=node)
        .select_related("asset")
        .order_by("created_at")
    )
    return [photo_payload(ref) for ref in rows]


@transaction.atomic
def attach_node_photo(
    revision: Revision,
    *,
    node_id,
    uploaded_file,
    actor,
    content_type: str | None = None,
    direction: str | None = None,
    direction_frame: str | None = None,
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
    if direction_frame is not None and (
        not isinstance(direction_frame, str) or direction_frame not in {"walking_relative", "plan"}
    ):
        raise GraphError("direction_frame must be walking_relative or plan.")
    if direction_frame is not None and direction is None:
        raise GraphError("direction_frame requires a photo direction.")
    source_walk = bool((revision.geometry or {}).get("photo_walk_source"))
    if source_walk and direction_frame == "plan":
        raise GraphError("Imported capture walks use walking-relative photo directions.")
    walking_relative = source_walk or direction_frame == "walking_relative"
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

    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(raw)) as img:
            width, height = img.size
            if img.format not in {"PNG", "JPEG", "WEBP"} or Image.MIME[img.format] != ctype:
                raise GraphError("The photo type must match its image bytes.")
            img.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise GraphError("Upload a valid PNG, JPEG, or WebP photo.") from exc
    ext = ALLOWED[ctype]
    digest = hashlib.sha256(raw).hexdigest()
    storage_key = f"photos/{revision.target_id}/{node.id}/{uuid.uuid4().hex}{ext}"
    try:
        storage_key = put_bytes(storage_key, raw, ctype)
        # Resolve before replacing the association so failed storage/signing keeps the old slot.
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
    # The revision lock serializes slot replacement, including concurrent uploads.
    # Existing undirected photos remain readable; immutable published photos are never changed.
    if direction:
        for old in ReferencePhoto.objects.filter(
            revision=revision, node=node, capture_context__direction=direction
        ):
            SceneRelationship.objects.filter(reference=old).delete()
            old.delete()
    # Photo-walk clients declare directions relative to walking, not plan north.
    # Existing imported walks retain that rule even when an older client omits it.
    context = {"direction": direction, "embedding_status": "not_connected"} if direction else {}
    if direction:
        context["heading_frame"] = "walking_relative" if walking_relative else "plan_up_clockwise"
    ref = ReferencePhoto.objects.create(
        revision=revision,
        asset=asset,
        node=node,
        status=ReferencePhoto.Status.PROPOSED,
        heading_degrees=DIRECTIONS[direction] if direction and not walking_relative else None,
        capture_context=context,
    )
    payload = photo_payload(ref)
    payload["url"] = url
    return payload


@transaction.atomic
def remove_node_photo(revision: Revision, *, reference_id, actor) -> None:
    """Detach a ReferencePhoto. Asset rows are append-only — leave bytes + Asset intact."""
    graph_svc._require_writable(actor, revision)
    try:
        ref = ReferencePhoto.objects.get(pk=reference_id, revision=revision)
    except ReferencePhoto.DoesNotExist as exc:
        raise GraphError("Reference photo not found on this revision.") from exc
    SceneRelationship.objects.filter(reference=ref).delete()
    ref.delete()
