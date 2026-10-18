"""Dijkstra shortest path on a published revision graph (open edges, cost weights)."""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from uuid import UUID

from maps.models import Edge, Node, Revision


@dataclass(frozen=True)
class PathHop:
    edge: Edge
    from_node: Node
    to_node: Node


@dataclass(frozen=True)
class PathResult:
    hops: list[PathHop]
    total_cost: float
    error: str = ""


def _as_uuid(value) -> UUID | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def node_on_revision(revision: Revision, node_id) -> Node | None:
    """Resolve MegaLoc / localize node_id (Node PK) on the pinned revision."""
    pk = _as_uuid(node_id)
    if pk is None:
        return None
    return Node.objects.filter(revision_id=revision.id, pk=pk).select_related("room").first()


def shortest_path(*, revision: Revision, start: Node, goal: Node) -> PathResult:
    if start.revision_id != revision.id or goal.revision_id != revision.id:
        return PathResult([], 0.0, error="node_revision_mismatch")
    if start.id == goal.id:
        return PathResult([], 0.0)

    nodes = {n.id: n for n in Node.objects.filter(revision_id=revision.id).select_related("room")}
    edges = list(
        Edge.objects.filter(revision_id=revision.id, is_open=True).select_related(
            "from_node", "to_node", "from_node__room", "to_node__room"
        )
    )
    adj: dict = {nid: [] for nid in nodes}
    for edge in edges:
        if edge.from_node_id in adj and edge.to_node_id in adj:
            adj[edge.from_node_id].append(edge)

    dist = {start.id: 0.0}
    prev: dict = {}
    heap: list[tuple[float, object]] = [(0.0, start.id)]

    while heap:
        cost, nid = heapq.heappop(heap)
        if cost > dist.get(nid, math.inf):
            continue
        if nid == goal.id:
            break
        for edge in adj.get(nid, []):
            nxt = edge.to_node_id
            weight = float(edge.cost)
            if weight < 0:
                continue
            cand = cost + weight
            if cand < dist.get(nxt, math.inf):
                dist[nxt] = cand
                prev[nxt] = edge
                heapq.heappush(heap, (cand, nxt))

    if goal.id not in prev and start.id != goal.id:
        return PathResult([], 0.0, error="unreachable")

    hops: list[PathHop] = []
    cur = goal.id
    while cur != start.id:
        edge = prev[cur]
        hops.append(
            PathHop(
                edge=edge,
                from_node=nodes[edge.from_node_id],
                to_node=nodes[edge.to_node_id],
            )
        )
        cur = edge.from_node_id
    hops.reverse()
    return PathResult(hops=hops, total_cost=float(dist.get(goal.id, 0.0)))
