"""Local read-only MCP scaffold. HTTP and map mutations await authorization services."""

import json

from mcp.server import MCPServer

server = MCPServer("SnapWay", version="0.1.0")


@server.resource("snapway://status", mime_type="application/json")
def status() -> str:
    """Describe implemented capabilities without claiming map or provider readiness."""
    return json.dumps({"service": "snapway-mcp", "stage": "scaffold", "map_tools_enabled": False})


if __name__ == "__main__":
    server.run(transport="stdio")
