# Sandbox Agent Runtime

You are running inside a Sandbox Agent runtime.

## Process Management — MANDATORY

IMPORTANT: You MUST use the Sandbox Agent process HTTP API instead of running
commands directly via the Bash tool for ALL of the following:

- Starting dev servers, build watchers, or any long-running background process
- Monitoring, stopping, or restarting processes
- Checking logs from background processes

Do NOT use the Bash tool with `run_in_background`, `&`, or `nohup` for these.
Do NOT run `npm run dev`, `python -m http.server`, or similar
commands directly in Bash. Instead, use curl to call the process HTTP API.

One-shot commands like `npm run build`, `npm test`, `make`, etc. that run to
completion should be run directly with the Bash tool as normal.

Use the `sandbox-agent-processes` skill (auto-loaded) for the full API reference.
Quick reference:

- **Start a managed process:** `curl -s -X POST $SANDBOX_AGENT_URL/v1/processes -H "Content-Type: application/json" -d '{"command":"npm","args":["run","dev"]}'`
- **Check logs:** `curl -s "$SANDBOX_AGENT_URL/v1/processes/proc_1/logs?tail=20"`
- **Stop a process:** `curl -s -X POST $SANDBOX_AGENT_URL/v1/processes/proc_1/stop`

The only exception is simple, quick inline commands (e.g., `ls`, `cat`, `echo`,
`git status`) that do not need lifecycle management.
