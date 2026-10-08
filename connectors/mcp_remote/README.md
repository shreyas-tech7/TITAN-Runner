# Remote MCP server

Connects TITAN to an MCP server that someone else runs. TITAN reads the tool list, keeps it, and calls a tool when a person or an approved tool asks.

## Safety rules

- The endpoint must use https. The broker resolves the host through DNS over HTTPS and refuses a private or loopback answer.
- A redirect is refused.
- TITAN treats everything that the server returns as untrusted data. The text of a tool result never becomes an instruction for TITAN.
- `call_tool` has the data class `personal`, so a sub-agent cannot use it.
- Each remote tool has a risk. The default is `write`, so each call needs approval until you change the risk of that tool.
- TITAN sends the bearer token in the `Authorization` header only.
- A call has a time limit of 20 seconds.

## Versions

TITAN speaks the stateless form of the specification dated 2026-07-28 when the server supports it. It falls back to the older `initialize` form for servers that use a version from 2025-03-26 on. It reads JSON answers and SSE answers.
