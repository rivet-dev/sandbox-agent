# Server Testing

## Snapshot tests

The HTTP/SSE snapshot suite lives in:
- `server/packages/sandbox-agent/tests/http_sse_snapshots.rs`

Snapshots are written to:
- `server/packages/sandbox-agent/tests/snapshots/`

## Agent selection

`SANDBOX_TEST_AGENTS` controls which agents run. It accepts a comma-separated list or `all`.
If it is **not set**, tests will auto-detect installed agents by checking:
- binaries on `PATH`, and
- the default install dir (`$XDG_DATA_HOME/sandbox-agent/bin` or `./.sandbox-agent/bin`)

If no agents are found, tests fail with a clear error.

## Credential handling

Credentials are pulled from the host by default via `extract_all_credentials`:
- environment variables (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
- local CLI configs (Claude/Codex/Amp/OpenCode)

You can override host credentials for tests with:
- `SANDBOX_TEST_ANTHROPIC_API_KEY`
- `SANDBOX_TEST_OPENAI_API_KEY`

If `SANDBOX_TEST_AGENTS` includes an agent that requires a provider credential and it is missing,
tests fail before starting.

## Credential health checks

Before running agent tests, credentials are validated with minimal API calls:
- Anthropic: `GET https://api.anthropic.com/v1/models`
  - `x-api-key` for API keys
  - `Authorization: Bearer` for OAuth tokens
  - `anthropic-version: 2023-06-01`
- OpenAI: `GET https://api.openai.com/v1/models` with `Authorization: Bearer`

401/403 yields a hard failure (`invalid credentials`). Other non-2xx responses or network
errors fail with a health-check error.

Health checks run in a blocking thread to avoid Tokio runtime drop errors inside async tests.

## Snapshot stability

To keep snapshots deterministic:
- Event streams are truncated after the first assistant or error event.
- Permission flow snapshots are truncated after the permission request (or first assistant) event.
- Unknown events are preserved as `kind: unknown` (raw payload in universal schema).

## Typical commands

Run only Claude snapshots:
```
SANDBOX_TEST_AGENTS=claude cargo test -p sandbox-agent --test http_sse_snapshots
```

Run all detected agents:
```
cargo test -p sandbox-agent --test http_sse_snapshots
```

## Universal Schema

When modifying agent conversion code in `server/packages/universal-agent-schema/src/agents/` or adding/changing properties on the universal schema, update the feature matrix in `README.md` to reflect which agents support which features.
