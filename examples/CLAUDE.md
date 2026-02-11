# Examples Instructions

## Docker Isolation

- Docker examples must behave like standalone sandboxes.
- Do not bind mount host files or host directories into Docker example containers.
- If an example needs tools, skills, or MCP servers, install them inside the container during setup.

## Testing Examples (ACP v1)

Examples should be validated against v1 endpoints:

1. Start the example: `SANDBOX_AGENT_DEV=1 pnpm start`
2. Pick a server id, for example `example-smoke`.
3. Create ACP transport by POSTing `initialize` to `/v1/acp/example-smoke?agent=mock` (or another installed agent).
4. Open SSE stream: `GET /v1/acp/example-smoke`.
5. Send `session/new` then `session/prompt` via `POST /v1/acp/example-smoke`.
6. Close connection via `DELETE /v1/acp/example-smoke`.

v1 reminder:

- `/v1/*` is removed and returns `410 Gone`.
