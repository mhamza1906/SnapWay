"""Atomic editor gestures on an author's pinned snapshot; no inference side effects."""

import math
import uuid

from django.db import transaction

from maps.models import Contribution, Edge, Node
from maps.services.graph import (
    NODE_KINDS,
    GraphError,
    _require_writable,
    add_edge,
    add_node,
    list_graph,
    remove_edge,
    remove_node,
)


class EditorConflict(GraphError):
    """Another tab changed this draft after the client loaded it."""


def _rows(data, key):
    rows = data.get(key, [])
    if not isinstance(rows, list) or len(rows) > 500:
        raise GraphError(f"{key} must be an array of at most 500 items.")
    return rows


@transaction.atomic
def edit_graph(revision, *, data, actor):
    if not isinstance(data, dict):
        raise GraphError("Expected an editor command object.")
    expected = data.get("expected_version")
    if type(expected) is not int or expected < 0:
        raise GraphError("expected_version must be a nonnegative integer.")
    _require_writable(actor, revision)
    version = Contribution.objects.get(pk=revision.contribution_id).lock_version
    if expected != version - 1:
        raise EditorConflict(
            "This draft changed in another tab. Reload the snapshot before editing."
        )
    # Use fresh dimensions under the same revision lock (underlay uploads can change them).
    revision.refresh_from_db()
    frame = revision.coordinate_frame or {}
    updates = _rows(data, "nodes")
    try:
        ids = [uuid.UUID(str(row.get("id"))) for row in updates if isinstance(row, dict)]
    except (ValueError, TypeError) as exc:
        raise GraphError("Each node update needs a valid UUID.") from exc
    if len(ids) != len(updates) or len(ids) != len(set(ids)):
        raise GraphError("Node updates must be objects with distinct IDs.")
    existing = revision.nodes.in_bulk(ids)
    if len(existing) != len(ids):
        raise GraphError("Node not found on this revision.")
    changed = []
    for row, node_id in zip(updates, ids, strict=True):
        if not isinstance(row, dict):
            raise GraphError("Each node update must be an object.")
        node = existing[node_id]
        fields = []
        if "x" in row or "y" in row:
            try:
                x, y = float(row["x"]), float(row["y"])
            except (KeyError, TypeError, ValueError) as exc:
                raise GraphError("A move needs numeric x and y.") from exc
            if not (
                math.isfinite(x)
                and math.isfinite(y)
                and 0 <= x <= float(frame.get("width", 1000))
                and 0 <= y <= float(frame.get("height", 640))
            ):
                raise GraphError("Waypoint must be inside the floor plan.")
            node.x, node.y = x, y
            fields += ["x", "y"]
        if "label" in row:
            if not isinstance(row["label"], str) or len(row["label"]) > 120:
                raise GraphError("Label must be text, at most 120 characters.")
            node.label = row["label"]
            fields.append("label")
        if "kind" in row:
            if row["kind"] != node.kind and row["kind"] not in NODE_KINDS:
                raise GraphError("Unsupported waypoint kind.")
            node.kind = row["kind"]
            fields.append("kind")
        if fields:
            changed.append(node)
    if changed:
        # One group drag is a bounded number of queries, not one query per pointer/node.
        Node.objects.bulk_update(changed, ["x", "y", "label", "kind"], batch_size=100)
    for row in _rows(data, "create_nodes"):
        if not isinstance(row, dict):
            raise GraphError("Each created waypoint must be an object.")
        add_node(
            revision,
            x=row.get("x"),
            y=row.get("y"),
            label=row.get("label") or "",
            kind=row.get("kind") or "checkpoint",
            actor=actor,
            lock=False,
            node_id=row.get("id"),
        )
    for row in _rows(data, "edges"):
        if not isinstance(row, dict):
            raise GraphError("Each edge update must be an object.")
        try:
            edge = revision.edges.get(pk=row.get("id"))
            cost = float(row["cost"])
        except (Edge.DoesNotExist, KeyError, TypeError, ValueError) as exc:
            raise GraphError("An existing edge and a numeric cost are required.") from exc
        if not math.isfinite(cost) or not 0 <= cost < 10**10:
            raise GraphError("Weight must be finite, nonnegative and below 10 billion.")
        edge.cost = cost
        edge.save(update_fields=["cost"])
    for edge_id in _rows(data, "delete_edges"):
        remove_edge(revision, edge_id=edge_id, actor=actor, lock=False)
    for node_id in _rows(data, "delete_nodes"):
        remove_node(revision, node_id=node_id, actor=actor, lock=False)
    for row in _rows(data, "connect"):
        if not isinstance(row, dict) or type(row.get("both", False)) is not bool:
            raise GraphError("A connection needs endpoints and a boolean both flag.")
        add_edge(
            revision, from_id=row.get("from"), to_id=row.get("to"), actor=actor, lock=False
        )
        if row.get("both"):
            add_edge(
                revision, from_id=row.get("to"), to_id=row.get("from"), actor=actor, lock=False
            )
    return list_graph(revision)
