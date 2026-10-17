import json
import os
import sys

import anyio
from config.environment import ROOT
from mcp import Client
from mcp.client.stdio import StdioServerParameters


def test_status_resource_over_real_stdio_transport():
    async def check():
        env = {**os.environ, "DJANGO_SETTINGS_MODULE": "config.settings.test"}
        parameters = StdioServerParameters(
            command=sys.executable,
            args=["-m", "apps.mcp.server"],
            cwd=ROOT,
            env=env,
        )
        with anyio.fail_after(40):
            async with Client(parameters) as client:
                result = await client.read_resource("snapway://status")
                payload = json.loads(result.contents[0].text)
                assert payload["map_tools_enabled"] is True
                assert payload["stage"] == "scaffold"
                tools = await client.list_tools()
                names = {t.name for t in tools.tools}
                assert {
                    "graph_list",
                    "graph_add_node",
                    "graph_update_node",
                    "graph_remove_node",
                    "graph_add_edge",
                    "graph_remove_edge",
                }.issubset(names)

    anyio.run(check)
