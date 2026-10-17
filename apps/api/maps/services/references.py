"""Node reference photo attach/list/remove (Asset + ReferencePhoto; bytes via media_store)."""

from __future__ import annotations

import hashlib
import uuid

from django.db import transaction

from maps.models import Asset, Node, ReferencePhoto, Revision
from maps.services import graph as graph_svc
from maps.services.graph import GraphError
from maps.services.media_store import delete_bytes, put_bytes, signed_url

MAX_BYTES = 5 * 1024 * 1024
ALLOWED = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


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
) -> dict:
    graph_svc._require_writable(actor, revision)
    try:
        node = revision.nodes.get(pk=node_id)
    except Node.DoesNotExist as exc:
        raise GraphError("Node not found on this revision.") from exc

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
    put_bytes(storage_key, raw, ctype)

    width = height = None
    try:
        import io

        from PIL import Image

        with Image.open(io.BytesIO(raw)) as img:
            width, height = img.size
    except Exception:  # noqa: BLE001
        width = height = None

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
    ref = ReferencePhoto.objects.create(
        revision=revision,
        asset=asset,
        node=node,
        status=ReferencePhoto.Status.PROPOSED,
    )
    return {
        "id": str(ref.id),
        "asset_id": str(asset.id),
        "url": signed_url(storage_key),
        "content_type": ctype,
        "byte_size": len(raw),
        "status": ref.status,
    }


@transaction.atomic
def remove_node_photo(revision: Revision, *, reference_id, actor) -> None:
    graph_svc._require_writable(actor, revision)
    try:
        ref = ReferencePhoto.objects.select_related("asset").get(pk=reference_id, revision=revision)
    except ReferencePhoto.DoesNotExist as exc:
        raise GraphError("Reference photo not found on this revision.") from exc
    asset = ref.asset
    storage_key = asset.storage_key
    ref.delete()
    # Asset may still be referenced elsewhere; only delete orphan photo assets.
    if (
        not asset.source_revisions.exists()
        and not ReferencePhoto.objects.filter(asset=asset).exists()
    ):
        asset.delete()
        delete_bytes(storage_key)
