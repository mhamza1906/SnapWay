"""Local MCP stdio scaffold with thin graph_* tools over shared Django services.

Production Streamable HTTP and signed delegation are out of scope for this slice.
The configured actor is for local smoke only (SNAPWAY_MCP_ACTOR_EMAIL or first staff).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API_ROOT = ROOT / "apps" / "api"
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.development")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from maps.models import Revision  # noqa: E402
from maps.services.graph import (  # noqa: E402
    GraphError,
    GraphPermissionError,
    add_edge,
    add_node,
    list_graph,
    remove_edge,
    remove_node,
    update_node,
)

from mcp.server import MCPServer  # noqa: E402

server = MCPServer("SnapWay", version="0.1.0")
User = get_user_model()


def _actor():
    email = os.environ.get("SNAPWAY_MCP_ACTOR_EMAIL", "").strip()
    if email:
        user = User.objects.filter(email__iexact=email).first()
        if user is None:
            raise RuntimeError(f"SNAPWAY_MCP_ACTOR_EMAIL={email} not found")
        return user
    user = User.objects.filter(is_staff=True).order_by("id").first()
    if user is None:
        raise RuntimeError("No staff user for MCP actor; set SNAPWAY_MCP_ACTOR_EMAIL")
    return user


def _revision(revision_id: str) -> Revision:
    return Revision.objects.select_related("target", "source_asset").get(pk=revision_id)


def _tool_error(exc: Exception) -> str:
    return json.dumps({"ok": False, "error": str(exc)})


@server.resource("snapway://status", mime_type="application/json")
def status() -> str:
    """Describe implemented capabilities without claiming production readiness."""
    return json.dumps(
        {
            "service": "snapway-mcp",
            "stage": "scaffold",
            "map_tools_enabled": True,
            "limits": [
                "stdio local only",
                "actor from SNAPWAY_MCP_ACTOR_EMAIL or first staff",
                "no production delegation",
            ],
        }
    )


@server.tool(name="graph_list", description="List nodes and edges for a revision")
def graph_list(revision_id: str) -> str:
    try:
        return json.dumps({"ok": True, **list_graph(_revision(revision_id))})
    except Exception as exc:  # noqa: BLE001
        return _tool_error(exc)


@server.tool(name="graph_add_node", description="Add a checkpoint/junction waypoint")
def graph_add_node(
    revision_id: str,
    x: float,
    y: float,
    label: str = "",
    kind: str = "checkpoint",
) -> str:
    try:
        node = add_node(
            _revision(revision_id),
            x=x,
            y=y,
            label=label,
            kind=kind,
            actor=_actor(),
        )
        return json.dumps(
            {
                "ok": True,
                "id": str(node.id),
                "x": float(node.x),
                "y": float(node.y),
                "label": node.label,
                "kind": node.kind,
            }
        )
    except (GraphError, GraphPermissionError, Exception) as exc:  # noqa: BLE001
        return _tool_error(exc)


@server.tool(name="graph_update_node", description="Update a waypoint label")
def graph_update_node(revision_id: str, node_id: str, label: str = "") -> str:
    try:
        node = update_node(
            _revision(revision_id),
            node_id=node_id,
            label=label,
            actor=_actor(),
        )
        return json.dumps(
            {
                "ok": True,
                "id": str(node.id),
                "x": float(node.x),
                "y": float(node.y),
                "label": node.label,
                "kind": node.kind,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return _tool_error(exc)


@server.tool(name="graph_remove_node", description="Remove a node and incident edges")
def graph_remove_node(revision_id: str, node_id: str) -> str:
    try:
        remove_node(_revision(revision_id), node_id=node_id, actor=_actor())
        return json.dumps({"ok": True})
    except Exception as exc:  # noqa: BLE001
        return _tool_error(exc)


@server.tool(name="graph_add_edge", description="Connect two nodes on a revision")
def graph_add_edge(revision_id: str, from_node_id: str, to_node_id: str) -> str:
    try:
        edge = add_edge(
            _revision(revision_id),
            from_id=from_node_id,
            to_id=to_node_id,
            actor=_actor(),
        )
        return json.dumps(
            {
                "ok": True,
                "id": str(edge.id),
                "from_node_id": str(edge.from_node_id),
                "to_node_id": str(edge.to_node_id),
                "cost": float(edge.cost),
            }
        )
    except Exception as exc:  # noqa: BLE001
        return _tool_error(exc)


@server.tool(name="graph_remove_edge", description="Remove an edge from a revision")
def graph_remove_edge(revision_id: str, edge_id: str) -> str:
    try:
        remove_edge(_revision(revision_id), edge_id=edge_id, actor=_actor())
        return json.dumps({"ok": True})
    except Exception as exc:  # noqa: BLE001
        return _tool_error(exc)


if __name__ == "__main__":
    server.run(transport="stdio")
