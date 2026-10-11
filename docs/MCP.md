# Model Context Protocol (MCP)

TITAN works as both an MCP server and an MCP client. Tools such as Claude Code and the Claude app can call TITAN through `POST /mcp` on the Worker. TITAN can also connect to remote MCP servers through the `remote_mcp` connector.

## Dual-era protocol support

The Worker route `POST /mcp` speaks two MCP protocol versions on the same endpoint:

| Version | Header rule | Transport style |
|---|---|---|
| `2024-11-05` | No `MCP-Protocol-Version` header is required after `initialize`. | Stateless JSON-RPC 2.0 over HTTP POST. |
| `2025-11-25` | Every request after `initialize` carries `MCP-Protocol-Version: 2025-11-25`. | Streamable HTTP JSON-RPC 2.0. |

A `GET /mcp` request returns `405 Method Not Allowed` with `Allow: POST` so clients know to send JSON-RPC over `POST`.

## Scopes and tools

Every MCP token has a list of scopes. A token can see and call only the tools that match its scopes.

| Tool | Required scope | What it does |
|---|---|---|
| `titan_status` | `status:read` | Reads the sub-agent queue, provider health, and pulse status. |
| `titan_list_tasks` | `status:read` | Lists recent sub-agent tasks. |
| `titan_get_task` | `status:read` | Reads one sub-agent task by id. |
| `titan_keys_status` | `status:read` | Lists provider key states without any secret values. |
| `titan_lessons` | `status:read` or `memory:read` | Reads recent system memory lessons. |
| `titan_create_task` | `tasks:write` | Queues a new sub-agent task. |
| `titan_list_connectors` | `connectors:read` | Lists connected tools and their actions. |
| `titan_connector_call` | `connectors:call:read` (plus `connectors:call:write` or `connectors:call:personal` when needed) | Calls a connector action through the broker. Write actions wait for approval. |
| `titan_notify` | `notify:send` | Sends a custom event through the notification router. |

A token with `chat:write` can also call `POST /chat` with `Authorization: Bearer <token>`.

## Connect Claude Code with a Bearer token

1. Open the Connectors page and choose the "MCP" tab.
2. Enter a label, pick the scopes you want, and click "Make token".
3. Copy the token right away. TITAN stores only the SHA-256 hash and never shows the token again.
4. Run this command in your terminal:

```bash
claude mcp add --transport http titan <WORKER_URL>/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"
```

5. Start Claude Code and ask it to run `titan_status`.

## Connect the Claude app with OAuth 2.1 and PKCE

The Worker also implements OAuth 2.1 with S256 PKCE for MCP clients:

- `GET /.well-known/oauth-protected-resource` returns the resource metadata for `<WORKER_URL>/mcp`.
- `GET /.well-known/oauth-authorization-server` returns the issuer, registration, authorization, and token endpoints.
- `POST /oauth/mcp/register` registers a public client whose redirect URI matches the allowlist (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, or `http://localhost` / `http://127.0.0.1`).
- `GET /oauth/mcp/authorize` redirects to the dashboard consent card on `/connectors/?mcp_authorize=1`.
- When you click "Approve access", the Worker issues a single-use code (`mcpc_...`) and redirects back to the client.
- `POST /oauth/mcp/token` verifies the S256 `code_verifier`, returns an access token (`titan_mcp_...`) and a refresh token (`titan_mcpr_...`), and rotates both on `grant_type=refresh_token`.
- You can revoke any Bearer or OAuth token at any time on the MCP tab.
