"""Authorized in-place Node/Edge mutations on an unfrozen Revision."""

from __future__ import annotations

import math
import uuid
from typing import Any

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from maps.models import Contribution, Edge, MapTarget, Membership, Node, Revision
from maps.services.media_store import point_photo_storage_ready, signed_url
from maps.services.membership import get_active_membership

WRITABLE_ROLES = frozenset({Membership.Role.ADMIN, Membership.Role.VOLUNTEER})
NODE_KINDS = frozenset(
    {
        Node.Kind.CHECKPOINT,
        Node.Kind.JUNCTION,
        Node.Kind.DOOR,
        Node.Kind.ENTRANCE,
        Node.Kind.STAIRS,
        Node.Kind.LIFT,
    }
)


class GraphError(ValueError):
    """Validation or state error for graph commands."""


class GraphPermissionError(PermissionError):
    """Caller lacks membership to mutate this graph."""


def _active_draft_membership(user, fresh, target, contribution) -> Membership:
    if target.status == MapTarget.Status.ARCHIVED:
        raise GraphError("Archived targets cannot be edited.")
    if fresh.frozen_at is not None or contribution.status != "draft":
        raise GraphError("Frozen revisions cannot be edited.")
    if contribution.author_id != user.pk or contribution.head_revision_id != fresh.pk:
        raise GraphPermissionError("Only the author may edit their active snapshot.")
    membership = get_active_membership(user, target)
    if membership is None or membership.role not in WRITABLE_ROLES:
        raise GraphPermissionError("Volunteer or admin membership is required.")
    return membership


def require_draft_read_access(user, revision: Revision) -> Membership:
    """Apply the same draft authority checks without locks or edit side effects."""
    if not user or not user.is_authenticated:
        raise GraphPermissionError("Authentication required.")
    fresh = Revision.objects.select_related("target", "contribution").get(pk=revision.pk)
    return _active_draft_membership(user, fresh, fresh.target, fresh.contribution)


def _require_writable(user, revision: Revision) -> Membership:
    if not user or not user.is_authenticated:
        raise GraphPermissionError("Authentication required.")
    # Every mutation shares the lifecycle lock order: target, contribution, revision.
    target = MapTarget.objects.select_for_update().get(pk=revision.target_id)
    contribution = Contribution.objects.select_for_update().get(pk=revision.contribution_id)
    fresh = Revision.objects.select_for_update().get(pk=revision.pk)
    membership = _active_draft_membership(user, fresh, target, contribution)
    now = timezone.now()
    Contribution.objects.filter(pk=contribution.pk).update(
        updated_at=now, lock_version=F("lock_version") + 1
    )
    MapTarget.objects.filter(pk=target.pk).update(updated_at=now)
    return membership


def list_graph(revision: Revision) -> dict[str, Any]:
    directions = {}
    for node_id, direction in revision.references.filter(node__isnull=False).values_list(
        "node_id", "capture_context__direction"
    ):
        if direction in ("front", "right", "back", "left"):
            directions.setdefault(node_id, set()).add(direction)
    nodes = [
        {
            "id": str(n.id),
            "x": float(n.x),
            "y": float(n.y),
            "label": n.label,
            "kind": n.kind,
            "photo_directions": sorted(directions.get(n.id, set())),
            "stable_id": str(n.stable_id),
            "room_id": str(n.room_id) if n.room_id else None,
        }
        for n in revision.nodes.order_by("created_at")
    ]
    edges = [
        {
            "id": str(e.id),
            "from_node_id": str(e.from_node_id),
            "to_node_id": str(e.to_node_id),
            "cost": float(e.cost),
            "stable_id": str(e.stable_id),
            "distance_metres": float(e.distance_metres) if e.distance_metres is not None else None,
            "is_open": e.is_open,
            "restrictions": e.restrictions,
            "provenance": e.provenance,
        }
        for e in revision.edges.select_related("from_node", "to_node").order_by("created_at")
    ]
    underlay_url = None
    # Vector SVG first, then Image 2.5 SoT (see workspace.plan_display_asset).
    from maps.services.workspace import plan_display_asset

    underlay, _kind = plan_display_asset(revision)
    if underlay is not None:
        underlay_url = signed_url(underlay.storage_key)
    return {
        "revision_id": str(revision.id),
        "photo_uploads_available": point_photo_storage_ready(),
        "lock_version": Contribution.objects.values_list("lock_version", flat=True).get(
            pk=revision.contribution_id
        ),
        "coordinate_frame": revision.coordinate_frame,
        "underlay_url": underlay_url,
        "nodes": nodes,
        "edges": edges,
    }


@transaction.atomic
def add_node(
    revision: Revision,
    *,
    x: float,
    y: float,
    label: str = "",
    kind: str = Node.Kind.CHECKPOINT,
    actor,
    lock: bool = True,
    node_id=None,
) -> Node:
    # Editor gestures already hold the writable lock; skip a second Tiger round-trip.
    if lock:
        _require_writable(actor, revision)
    if x is None or y is None:
        raise GraphError("x and y are required.")
    width = float(revision.coordinate_frame.get("width", 1000))
    height = float(revision.coordinate_frame.get("height", 640))
    if not all(math.isfinite(float(v)) for v in [x, y]) or not (
        0 <= float(x) <= width and 0 <= float(y) <= height
    ):
        raise GraphError("Waypoint must be inside the floor plan.")
    if kind not in NODE_KINDS:
        raise GraphError("Unsupported waypoint kind (rooms require a linked room record).")
    fields = {
        "revision": revision,
        "kind": kind,
        "x": float(x),
        "y": float(y),
        "label": (label or "")[:120],
    }
    # Optional id lets undo restore a deleted waypoint without breaking edge endpoints.
    if node_id is not None:
        try:
            fields["id"] = uuid.UUID(str(node_id))
        except (ValueError, TypeError) as exc:
            raise GraphError("Invalid waypoint id.") from exc
    return Node.objects.create(**fields)


@transaction.atomic
def update_node(revision: Revision, *, node_id, label: str, actor) -> Node:
    _require_writable(actor, revision)
    try:
        node = revision.nodes.get(pk=node_id)
    except Node.DoesNotExist as exc:
        raise GraphError("Node not found on this revision.") from exc
    node.label = (label or "")[:120]
    node.save(update_fields=["label"])
    return node


@transaction.atomic
def remove_node(revision: Revision, *, node_id, actor, lock: bool = True) -> None:
    if lock:
        _require_writable(actor, revision)
    try:
        node = revision.nodes.get(pk=node_id)
    except Node.DoesNotExist as exc:
        raise GraphError("Node not found on this revision.") from exc
    Edge.objects.filter(revision=revision, from_node=node).delete()
    Edge.objects.filter(revision=revision, to_node=node).delete()
    from maps.models import ReferencePhoto, SceneRelationship

    SceneRelationship.objects.filter(revision=revision, node=node).delete()
    SceneRelationship.objects.filter(reference__node=node).delete()
    ReferencePhoto.objects.filter(revision=revision, node=node).delete()
    node.delete()


@transaction.atomic
def add_edge(
    revision: Revision,
    *,
    from_id,
    to_id,
    actor,
    lock: bool = True,
) -> Edge:
    if lock:
        _require_writable(actor, revision)
    if str(from_id) == str(to_id):
        raise GraphError("Self-loop edges are not allowed.")
    try:
        from_node = revision.nodes.get(pk=from_id)
        to_node = revision.nodes.get(pk=to_id)
    except Node.DoesNotExist as exc:
        raise GraphError("Both endpoints must exist on this revision.") from exc
    if Edge.objects.filter(revision=revision, from_node=from_node, to_node=to_node).exists():
        raise GraphError("Duplicate directed edge already exists.")
    cost = math.hypot(float(to_node.x) - float(from_node.x), float(to_node.y) - float(from_node.y))
    return Edge.objects.create(
        revision=revision,
        from_node=from_node,
        to_node=to_node,
        cost=cost,
    )


@transaction.atomic
def update_edge(revision: Revision, *, edge_id, cost, actor) -> Edge:
    _require_writable(actor, revision)
    if cost is None or not math.isfinite(float(cost)) or not 0 <= float(cost) < 10**10:
        raise GraphError("Connection weight must be finite, nonnegative and below 10 billion.")
    try:
        edge = revision.edges.get(pk=edge_id)
    except Edge.DoesNotExist as exc:
        raise GraphError("Edge not found on this revision.") from exc
    edge.cost = cost
    edge.save(update_fields=["cost"])
    return edge


@transaction.atomic
def remove_edge(revision: Revision, *, edge_id, actor, lock: bool = True) -> None:
    if lock:
        _require_writable(actor, revision)
    try:
        edge = revision.edges.get(pk=edge_id)
    except Edge.DoesNotExist as exc:
        raise GraphError("Edge not found on this revision.") from exc
    edge.delete()


@transaction.atomic
def set_underlay(revision: Revision, *, asset, actor, frame: dict | None = None) -> Revision:
    _require_writable(actor, revision)
    revision.source_asset = asset
    updates = ["source_asset"]
    if frame:
        revision.coordinate_frame = frame
        updates.append("coordinate_frame")
    revision.save(update_fields=updates)
    return revision


def freeze_revision(revision: Revision) -> Revision:
    """Test helper / future publish path — not exposed as a write API yet."""
    if revision.frozen_at is None:
        if not revision.content_hash:
            revision.content_hash = "0" * 64
        revision.frozen_at = timezone.now()
        revision.save(update_fields=["content_hash", "frozen_at"])
    return revision
