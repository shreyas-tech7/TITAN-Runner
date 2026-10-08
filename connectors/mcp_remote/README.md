# Remote MCP server

Connects TITAN to an MCP server that someone else runs. TITAN lists the tools of the server and calls one when a person or a tool asks.

## Safety rules

- The endpoint must use https. The broker resolves the host through DNS over HTTPS and refuses a private or loopback answer.
- A redirect is refused.
- TITAN treats everything that the server returns as untrusted data. The text of a tool result never becomes an instruction for TITAN.
- `call_tool` has the data class `personal`, so a sub-agent cannot use it, and it needs approval unless you set it to auto-approve.
- TITAN sends the bearer token in the `Authorization` header only.

## Versions

TITAN speaks the stateless form of the specification dated 2026-07-28 when the server supports it. It falls back to the older `initialize` form for servers that use a version from 2025-03-26 on.
