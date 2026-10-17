"""Create or resume an editable draft contribution + unfrozen head revision."""

from __future__ import annotations

import uuid

from django.db import transaction

from maps.models import Building, Contribution, Floor, MapTarget, Membership, Revision
from maps.services.membership import get_active_membership, grant_membership

DEFAULT_FRAME = {"origin": "top_left", "width": 1000, "height": 640, "units": "plan"}


@transaction.atomic
def ensure_demo_draft(user, target_id=None, *, force_new: bool = False) -> dict:
    """Return target/contribution/revision ids for graph editing.

    Without target_id, resume the caller's most recent open draft target instead
    of creating a new Building/Floor/MapTarget on every page load.
    Pass force_new=True to always create a fresh target.
    """
    if not user or not user.is_authenticated:
        raise PermissionError("Authentication required.")

    if target_id and not force_new:
        target = MapTarget.objects.select_related("floor").get(pk=target_id)
        if target.status == MapTarget.Status.ARCHIVED:
            raise ValueError("Archived targets cannot be edited.")
        membership = get_active_membership(user, target)
        if membership is None:
            if user.is_staff or user.is_superuser:
                grant_membership(
                    target=target,
                    user=user,
                    role=Membership.Role.ADMIN,
                    granted_by=user,
                )
            else:
                raise PermissionError("Map membership is required.")
    else:
        target = None if force_new else _latest_open_draft_target(user)
        if target is None:
            building = Building.objects.create(
                name="Demo Building",
                slug=f"demo-{uuid.uuid4().hex[:10]}",
                created_by=user,
            )
            floor = Floor.objects.create(building=building, code="1", name="Floor 1")
            target = MapTarget.objects.create(floor=floor, title="Demo map target", created_by=user)
            Membership.objects.create(
                target=target,
                user=user,
                role=Membership.Role.ADMIN,
                granted_by=user,
            )

    contribution = (
        Contribution.objects.filter(
            target=target,
            author=user,
            status=Contribution.Status.DRAFT,
        )
        .order_by("-created_at")
        .first()
    )
    if contribution is None:
        contribution = Contribution.objects.create(
            target=target,
            author=user,
            title="Graph draft",
            status=Contribution.Status.DRAFT,
        )

    revision = contribution.head_revision
    if revision is None or revision.frozen_at is not None:
        revision = Revision.objects.create(
            target=target,
            contribution=contribution,
            created_by=user,
            geometry={},
            coordinate_frame=dict(DEFAULT_FRAME),
        )
        contribution.head_revision = revision
        contribution.save(update_fields=["head_revision"])

    return {
        "target_id": target.id,
        "contribution_id": contribution.id,
        "revision_id": revision.id,
        "coordinate_frame": revision.coordinate_frame,
        "underlay_url": _underlay_url(revision),
    }


def _latest_open_draft_target(user) -> MapTarget | None:
    """Prefer a target where this user already has an unfrozen draft head."""
    draft = (
        Contribution.objects.filter(
            author=user,
            status=Contribution.Status.DRAFT,
            target__status=MapTarget.Status.OPEN,
            head_revision__isnull=False,
            head_revision__frozen_at__isnull=True,
        )
        .select_related("target", "head_revision")
        .order_by("-created_at")
        .first()
    )
    if draft is not None:
        return draft.target
    membership = (
        Membership.objects.filter(
            user=user,
            revoked_at__isnull=True,
            target__status=MapTarget.Status.OPEN,
        )
        .select_related("target")
        .order_by("-created_at")
        .first()
    )
    return membership.target if membership else None


def _underlay_url(revision: Revision) -> str | None:
    asset = revision.source_asset
    if asset is None:
        return None
    from maps.services.media_store import signed_url

    return signed_url(asset.storage_key)
