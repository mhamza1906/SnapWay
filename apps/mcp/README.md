# MCP adapter

Official Python MCP SDK v2; local stdio transport only at initialization:

```sh
python scripts/dev.py mcp
```

Run this command from the repository root. MCP clients launch it as a subprocess;
it is not an ordinary interactive shell. The only resource is
`snapway://status`, a non-secret scaffold capability record. It exposes no map
tools, identity impersonation or HTTP listener.

Private Streamable HTTP and map tools require the planned signed delegation,
current map permissions and revision checks. Their implementation must invoke
the same backend command services as REST and jobs. Installed SDK availability
does not imply that these product integrations are complete.
