# MCP adapter

Official Python MCP SDK v2; local stdio transport only at initialization:

```sh
python scripts/dev.py mcp
```

Run this command from the repository root. MCP clients launch it as a subprocess;
it is not an ordinary interactive shell.

## Status resource

`snapway://status` reports `map_tools_enabled: true` for this scaffold profile,
plus local-only limits (stdio, configured actor, no production delegation).

## Graph tools (local smoke)

Thin wrappers over `maps.services.graph` (same commands as REST):

| Tool | Purpose |
| --- | --- |
| `graph_list` | List nodes/edges for a revision |
| `graph_add_node` | Add checkpoint/junction waypoint |
| `graph_update_node` | Update waypoint label |
| `graph_remove_node` | Remove node + incident edges |
| `graph_add_edge` | Connect two nodes |
| `graph_remove_edge` | Remove an edge |

Actor resolution (local only):

1. `SNAPWAY_MCP_ACTOR_EMAIL` if set and found
2. else the first Django staff user

Membership and unfrozen-revision checks still apply. There is no production
signed delegation or Streamable HTTP listener in this slice.

Private Streamable HTTP and delegated identity remain planned work. Installed
SDK availability does not imply those product integrations are complete.
