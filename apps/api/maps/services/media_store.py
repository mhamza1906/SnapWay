"""Adapter-relative blob put/signed-url/delete via Django default storage."""

from __future__ import annotations

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage


def put_bytes(storage_key: str, raw: bytes, content_type: str) -> str:
    """Write bytes to the configured backend; return the saved storage key."""
    if default_storage.exists(storage_key):
        default_storage.delete(storage_key)
    content = ContentFile(raw)
    content.content_type = content_type
    return default_storage.save(storage_key, content)


def signed_url(storage_key: str, ttl: int | None = None) -> str:
    """Return a fetchable URL (signed when using S3/R2; MEDIA_URL locally)."""
    if not storage_key:
        raise ValueError("storage_key is required")
    expire = ttl if ttl is not None else int(getattr(settings, "S3_SIGNED_URL_TTL_SECONDS", 300))
    # S3Boto3Storage.url accepts expire=; FileSystemStorage ignores kwargs via TypeError path.
    try:
        return default_storage.url(storage_key, expire=expire)
    except TypeError:
        return default_storage.url(storage_key)


def delete_bytes(storage_key: str) -> None:
    """Best-effort delete; missing keys are ignored."""
    if not storage_key:
        return
    try:
        if default_storage.exists(storage_key):
            default_storage.delete(storage_key)
    except Exception:  # noqa: BLE001 — best-effort cleanup
        return
