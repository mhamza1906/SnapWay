"""Discover ready MegaLoc revision indexes for visitor global localization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db.models import QuerySet

from maps.models import Publication, Revision, RevisionArtifact


@dataclass(frozen=True)
class CatalogEntry:
    set_key: str
    content_hash: str
    revision_id: str
    target_id: str
    storage_key: str
    asset_sha256: str


def set_key_for_revision(revision_id) -> str:
    compact = str(revision_id).replace("-", "")
    return f"rev_{compact[:20]}"


def _ready_artifacts() -> QuerySet[RevisionArtifact]:
    return (
        RevisionArtifact.objects.filter(kind="index", state=RevisionArtifact.State.READY)
        .exclude(asset__isnull=True)
        .select_related("asset", "revision", "revision__target")
    )


def eligible_index_entries(
    *,
    revision_id: UUID | str | None = None,
    target_id: UUID | str | None = None,
) -> list[CatalogEntry]:
    """Return catalog rows for published (and DEBUG draft) ready indexes."""
    qs = _ready_artifacts()
    if revision_id:
        qs = qs.filter(revision_id=revision_id)
    elif target_id:
        qs = qs.filter(revision__target_id=target_id)

    published_ids = set(
        Publication.objects.filter(is_current=True, invalidated_at__isnull=True).values_list(
            "revision_id", flat=True
        )
    )

    include_drafts = bool(getattr(settings, "DEBUG", False))
    entries: list[CatalogEntry] = []
    for art in qs.order_by("revision__target_id", "revision_id"):
        rev: Revision = art.revision
        if rev.id not in published_ids:
            if not include_drafts or rev.frozen_at is not None:
                continue
        entries.append(
            CatalogEntry(
                set_key=set_key_for_revision(rev.id),
                content_hash=art.input_content_hash or art.asset.sha256,
                revision_id=str(rev.id),
                target_id=str(rev.target_id),
                storage_key=art.asset.storage_key,
                asset_sha256=art.asset.sha256,
            )
        )
    return entries


def enrich_target_context(target_id: str | None) -> dict[str, Any]:
    """Map target → floor/building ids and names for localize responses."""
    if not target_id:
        return {
            "target_id": None,
            "floor_id": None,
            "building_id": None,
            "floor_code": None,
            "floor_name": None,
            "building_name": None,
            "building_slug": None,
        }
    from maps.models import MapTarget

    try:
        target = MapTarget.objects.select_related("floor", "floor__building").get(pk=target_id)
    except MapTarget.DoesNotExist:
        return {
            "target_id": target_id,
            "floor_id": None,
            "building_id": None,
            "floor_code": None,
            "floor_name": None,
            "building_name": None,
            "building_slug": None,
        }
    floor = target.floor
    building = floor.building
    return {
        "target_id": str(target.id),
        "floor_id": str(floor.id),
        "building_id": str(building.id),
        "floor_code": floor.code,
        "floor_name": floor.name,
        "building_name": building.name,
        "building_slug": building.slug,
    }
