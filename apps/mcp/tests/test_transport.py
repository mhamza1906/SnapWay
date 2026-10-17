import json
import sys

import anyio
from config.environment import ROOT
from mcp import Client
from mcp.client.stdio import StdioServerParameters


def test_status_resource_over_real_stdio_transport():
    async def check():
        parameters = StdioServerParameters(
            command=sys.executable, args=["-m", "apps.mcp.server"], cwd=ROOT
        )
        with anyio.fail_after(20):
            async with Client(parameters) as client:
                result = await client.read_resource("snapway://status")
                payload = json.loads(result.contents[0].text)
                assert payload["map_tools_enabled"] is False
                assert payload["stage"] == "scaffold"

    anyio.run(check)
