---
name: sandbox-agent-processes
description: >-
  Start, stop, and monitor long-lived processes (dev servers, builds, watchers)
  and run one-shot commands inside the sandbox via the Sandbox Agent process HTTP API.
  TRIGGER when: user asks to start a dev server, run a build watcher,
  manage background processes, check process logs, or needs a long-running command
  that outlives a single shell execution.
  DO NOT TRIGGER when: user wants to run a simple inline shell command with the Bash tool.
user-invocable: false
---

# Sandbox Agent Process Management

You are running inside a Sandbox Agent runtime. Use the process HTTP API
documented below to manage processes. All endpoints are under `/v1/processes`.

The server URL is `$SANDBOX_AGENT_URL`. Use it as the base for all curl
commands (e.g., `curl -s $SANDBOX_AGENT_URL/v1/processes`).
All curl commands below should be run via the Bash tool.

---

## Run a one-shot command

Execute a command to completion and get stdout/stderr/exit code.

```bash
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes/run \
  -H "Content-Type: application/json" \
  -d '{
    "command": "make",
    "args": ["build"],
    "cwd": "/workspace",
    "timeoutMs": 60000
  }'
```

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | yes | Program to execute |
| `args` | string[] | no | Command arguments |
| `cwd` | string | no | Working directory |
| `env` | object | no | Extra environment variables |
| `timeoutMs` | number | no | Timeout in ms (default: 30000) |
| `maxOutputBytes` | number | no | Cap on captured output (default: 1MB) |

**Response:**

```json
{
  "exitCode": 0,
  "timedOut": false,
  "stdout": "...",
  "stderr": "",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "durationMs": 2345
}
```

---

## Create a managed process

Spawn a long-lived process (e.g., dev server) that persists until stopped.

```bash
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes \
  -H "Content-Type: application/json" \
  -d '{
    "command": "npm",
    "args": ["run", "dev"],
    "cwd": "/workspace"
  }'
```

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | yes | Program to execute |
| `args` | string[] | no | Command arguments |
| `cwd` | string | no | Working directory |
| `env` | object | no | Extra environment variables |
| `tty` | bool | no | Allocate a PTY (default: false) |
| `interactive` | bool | no | Mark as interactive (default: false) |

**Response** (`ProcessInfo`):

```json
{
  "id": "proc_1",
  "command": "npm",
  "args": ["run", "dev"],
  "cwd": "/workspace",
  "tty": false,
  "interactive": false,
  "status": "running",
  "pid": 12345,
  "exitCode": null,
  "createdAtMs": 1709866543221,
  "exitedAtMs": null
}
```

---

## List processes

```bash
curl -s $SANDBOX_AGENT_URL/v1/processes
```

Returns `{ "processes": [ ...ProcessInfo ] }`.

---

## Get a single process

```bash
curl -s $SANDBOX_AGENT_URL/v1/processes/proc_1
```

Returns a `ProcessInfo` object. Check `status` (`"running"` or `"exited"`) and `exitCode`.

---

## Stop a process (SIGTERM)

```bash
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes/proc_1/stop
```

Optionally wait for the process to exit:

```bash
curl -s -X POST "$SANDBOX_AGENT_URL/v1/processes/proc_1/stop?waitMs=5000"
```

Returns updated `ProcessInfo`.

---

## Kill a process (SIGKILL)

```bash
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes/proc_1/kill
```

Same interface as stop. Use when SIGTERM is not sufficient.

---

## Delete a process

Remove a stopped process from the list. Fails with 409 if still running.

```bash
curl -s -X DELETE $SANDBOX_AGENT_URL/v1/processes/proc_1
```

Returns 204 on success.

---

## Fetch process logs

Get buffered log output from a managed process.

```bash
# All logs
curl -s $SANDBOX_AGENT_URL/v1/processes/proc_1/logs

# Last 50 entries
curl -s "$SANDBOX_AGENT_URL/v1/processes/proc_1/logs?tail=50"

# Only stdout
curl -s "$SANDBOX_AGENT_URL/v1/processes/proc_1/logs?stream=stdout"
```

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `stream` | string | `stdout`, `stderr`, `combined`, or `pty` |
| `tail` | number | Return only the last N entries |
| `since` | number | Only entries with sequence > this value |
| `follow` | bool | Stream live via SSE (see below) |

**Response:**

```json
{
  "processId": "proc_1",
  "stream": "combined",
  "entries": [
    {
      "sequence": 1,
      "stream": "stdout",
      "timestampMs": 1709866543221,
      "data": "aGVsbG8=",
      "encoding": "base64"
    }
  ]
}
```

Log entry `data` is base64-encoded. Decode it to read the output.

---

## Follow logs via SSE

Stream live log output using Server-Sent Events:

```bash
curl -s -N "$SANDBOX_AGENT_URL/v1/processes/proc_1/logs?follow=true"
```

Each SSE event has type `log` and contains a JSON `ProcessLogEntry` as data.
Use `since=<sequence>` to resume from a known position.

---

## Send input to a process

Write to a process's stdin (or PTY input for tty processes).

```bash
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes/proc_1/input \
  -H "Content-Type: application/json" \
  -d '{"data": "echo hello\n", "encoding": "utf8"}'
```

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | string | yes | Input data |
| `encoding` | string | no | `utf8`, `text`, or `base64` (default: `utf8`) |

Returns `{ "bytesWritten": 12 }`.

---

## Resize terminal (PTY only)

For processes started with `"tty": true`:

```bash
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes/proc_1/terminal/resize \
  -H "Content-Type: application/json" \
  -d '{"cols": 120, "rows": 40}'
```

---

## Get/set runtime configuration

```bash
# Get current config
curl -s $SANDBOX_AGENT_URL/v1/processes/config

# Update config
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes/config \
  -H "Content-Type: application/json" \
  -d '{
    "maxConcurrentProcesses": 32,
    "defaultRunTimeoutMs": 60000,
    "maxRunTimeoutMs": 300000,
    "maxOutputBytes": 2097152,
    "maxLogBytesPerProcess": 10485760,
    "maxInputBytesPerRequest": 65536
  }'
```

---

## Common patterns

### Start a dev server and check it's running

```bash
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes \
  -H "Content-Type: application/json" \
  -d '{"command":"npm","args":["run","dev"],"cwd":"/workspace"}'

# Wait a moment, then check logs for startup confirmation
curl -s "$SANDBOX_AGENT_URL/v1/processes/proc_1/logs?tail=20"
```

### Run a build and check for errors

```bash
curl -s -X POST $SANDBOX_AGENT_URL/v1/processes/run \
  -H "Content-Type: application/json" \
  -d '{"command":"npm","args":["run","build"],"cwd":"/workspace","timeoutMs":120000}'
```

Check `exitCode` in the response. Non-zero means failure — read `stderr` for details.

### Stop and clean up a process

```bash
curl -s -X POST "$SANDBOX_AGENT_URL/v1/processes/proc_1/stop?waitMs=5000"
curl -s -X DELETE $SANDBOX_AGENT_URL/v1/processes/proc_1
```

---

## Error responses

Errors use `application/problem+json`:

```json
{
  "type": "about:blank",
  "status": 409,
  "title": "Conflict",
  "detail": "max concurrent process limit reached (64)"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (invalid encoding, malformed body) |
| 404 | Process not found |
| 409 | Conflict (process still running, or limit reached) |
| 413 | Input payload too large |
| 501 | Process API not supported on this platform |
