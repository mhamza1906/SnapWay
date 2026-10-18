"""Resolve MegaLoc's revision-local result into an application-owned checkpoint."""

from uuid import UUID

from maps.models import Node


def resolve_detected_node(decision, entries):
    """Never turn a candidate, missing node or stale index identity into a location."""
    try:
        node_id = UUID(decision.get("node_id") or decision.get("location_id") or "")
        revision_id = UUID(decision.get("revision_id") or "")
        target_id = UUID(decision.get("target_id") or "")
        location_id = decision.get("location_id")
        if location_id and UUID(location_id) != node_id:
            return None
    except (ValueError, TypeError, AttributeError):
        return None
    if not any(
        entry.revision_id == str(revision_id) and entry.target_id == str(target_id)
        for entry in entries
    ):
        return None
    node = (
        Node.objects.select_related("revision__target__floor__building", "room")
        .filter(
            pk=node_id,
            revision_id=revision_id,
            revision__target_id=target_id,
            revision__target__status="open",
        )
        .first()
    )
    if node is None:
        return None
    floor = node.revision.target.floor
    label = node.label or (node.room.number or node.room.name if node.room_id else "")
    return {
        "node_id": str(node.id),
        "stable_id": str(node.stable_id),
        "revision_id": str(node.revision_id),
        "target_id": str(target_id),
        "label": label or "Checkpoint",
        "kind": node.kind,
        "floor_id": str(floor.id),
        "floor_name": floor.name,
        "building_id": str(floor.building_id),
        "building_name": floor.building.name,
    }
