"""Template walking instructions from a Dijkstra path (no LLM)."""

from __future__ import annotations

import math

from maps.models import Node

from navigation.services.routing import PathResult


def _label(node: Node) -> str:
    if node.room_id and node.room:
        return (node.room.number or node.room.name or node.label or "").strip()
    return (node.label or node.kind or "waypoint").strip() or "waypoint"


def _turn(prev_dx: float, prev_dy: float, dx: float, dy: float) -> str:
    """Classify turn using 2D cross/dot of consecutive segment vectors (plan coords)."""
    cross = prev_dx * dy - prev_dy * dx
    dot = prev_dx * dx + prev_dy * dy
    # Near-zero previous length: no turn signal.
    if abs(prev_dx) < 1e-9 and abs(prev_dy) < 1e-9:
        return "straight"
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return "straight"
    # U-turn-ish
    if dot < 0 and abs(cross) < abs(dot) * 0.5:
        return "u_turn"
    if abs(cross) < 1e-6 or abs(math.atan2(cross, dot)) < math.radians(25):
        return "straight"
    return "left" if cross > 0 else "right"


def _turn_phrase(turn: str) -> str:
    return {
        "left": "Turn left",
        "right": "Turn right",
        "u_turn": "Turn around",
        "straight": "Continue straight",
    }.get(turn, "Continue")


def build_steps(path: PathResult) -> list[dict]:
    steps: list[dict] = []
    prev_dx = 0.0
    prev_dy = 0.0
    for index, hop in enumerate(path.hops):
        dx = float(hop.to_node.x) - float(hop.from_node.x)
        dy = float(hop.to_node.y) - float(hop.from_node.y)
        turn = "straight" if index == 0 else _turn(prev_dx, prev_dy, dx, dy)
        distance = hop.edge.distance_metres
        distance_f = float(distance) if distance is not None else None
        to_label = _label(hop.to_node)
        kind = hop.to_node.kind
        if index == 0:
            instruction = f"Head toward {to_label}"
        else:
            instruction = f"{_turn_phrase(turn)} toward {to_label}"
        if distance_f is not None and distance_f > 0:
            instruction = f"{instruction} (~{distance_f:.0f} m)"
        if kind in {Node.Kind.STAIRS, Node.Kind.LIFT}:
            instruction = f"{instruction} via {kind}"
        instruction = f"{instruction}."
        steps.append(
            {
                "from_node_id": str(hop.from_node.id),
                "to_node_id": str(hop.to_node.id),
                "from_stable_id": str(hop.from_node.stable_id),
                "to_stable_id": str(hop.to_node.stable_id),
                "to_kind": kind,
                "to_label": to_label,
                "turn": turn,
                "distance_metres": distance_f,
                "edge_id": str(hop.edge.id),
                "cost": float(hop.edge.cost),
                "instruction": instruction,
            }
        )
        prev_dx, prev_dy = dx, dy
    return steps


def instructions_from_steps(steps: list[dict], *, already_there: bool = False) -> str:
    if already_there:
        return "You are already at your destination."
    if not steps:
        return ""
    return " ".join(step["instruction"] for step in steps)


def path_payload(
    path: PathResult,
    *,
    start: Node,
    destination: Node,
) -> dict:
    if path.error:
        return {
            "ok": False,
            "error": path.error,
            "start_node_id": str(start.id),
            "start_stable_id": str(start.stable_id),
            "destination_node_id": str(destination.id),
            "destination_stable_id": str(destination.stable_id),
            "steps": [],
            "edge_ids": [],
            "total_cost": None,
            "instructions_text": "",
            "instructions_source": "template",
        }
    already = start.id == destination.id
    steps = [] if already else build_steps(path)
    text = instructions_from_steps(steps, already_there=already)
    return {
        "ok": True,
        "error": "",
        "start_node_id": str(start.id),
        "start_stable_id": str(start.stable_id),
        "destination_node_id": str(destination.id),
        "destination_stable_id": str(destination.stable_id),
        "steps": steps,
        "edge_ids": [str(h.edge.id) for h in path.hops],
        "total_cost": path.total_cost if not already else 0.0,
        "instructions_text": text,
        "instructions_source": "template",
    }
