# Process Terminal Support

This document describes the PTY/terminal session support added to the Process Manager API.

## Overview

The Process Manager now supports Docker-style terminal sessions with `-t` (TTY) and `-i` (interactive) flags. When a process is started with TTY enabled, a pseudo-terminal (PTY) is allocated, allowing full interactive terminal applications to run.

## API

### Starting a Process with TTY

```bash
curl -X POST http://localhost:2468/v1/process \
  -H "Content-Type: application/json" \
  -d '{
    "command": "bash",
    "args": [],
    "tty": true,
    "interactive": true,
    "terminalSize": {
      "cols": 120,
      "rows": 40
    }
  }'
```

Response includes `tty: true` and `interactive: true` flags.

### Terminal WebSocket

Connect to a running PTY process via WebSocket:

```
ws://localhost:2468/v1/process/{id}/terminal
```

#### Message Types

**Client -> Server:**
- `{"type": "input", "data": "ls -la\n"}` - Send keyboard input
- `{"type": "resize", "cols": 120, "rows": 40}` - Resize terminal

**Server -> Client:**
- `{"type": "data", "data": "..."}` - Terminal output
- `{"type": "exit", "code": 0}` - Process exited
- `{"type": "error", "message": "..."}` - Error occurred

### Terminal Resize

```bash
curl -X POST http://localhost:2468/v1/process/{id}/resize \
  -H "Content-Type: application/json" \
  -d '{"cols": 120, "rows": 40}'
```

### Terminal Input (REST)

For non-WebSocket clients:

```bash
curl -X POST http://localhost:2468/v1/process/{id}/input \
  -H "Content-Type: application/json" \
  -d '{"data": "ls -la\n"}'
```

For binary data, use base64 encoding:

```bash
curl -X POST http://localhost:2468/v1/process/{id}/input \
  -H "Content-Type: application/json" \
  -d '{"data": "bHMgLWxhCg==", "base64": true}'
```

## Inspector UI

The Inspector UI now shows:
- PTY badge on processes with TTY enabled
- Terminal/Logs tabs for PTY processes
- Interactive xterm.js terminal when expanded
- Auto-resize on window/container resize

## Testing

### Start the Server

```bash
cargo run --package sandbox-agent -- serve
```

### Test Interactive Bash

```bash
# Start a bash shell with PTY
curl -X POST http://localhost:2468/v1/process \
  -H "Content-Type: application/json" \
  -d '{
    "command": "bash",
    "tty": true,
    "interactive": true
  }'

# Open the Inspector UI and interact with the terminal
open http://localhost:2468
```

### Test with vim

```bash
curl -X POST http://localhost:2468/v1/process \
  -H "Content-Type: application/json" \
  -d '{
    "command": "vim",
    "args": ["test.txt"],
    "tty": true,
    "interactive": true
  }'
```

### Test with htop

```bash
curl -X POST http://localhost:2468/v1/process \
  -H "Content-Type: application/json" \
  -d '{
    "command": "htop",
    "tty": true,
    "interactive": true
  }'
```

## Implementation Details

### Backend

- Uses `portable-pty` crate for cross-platform PTY support (Unix only for now)
- PTY output is continuously read and broadcast to WebSocket subscribers
- PTY input is received via channel and written to the master PTY
- Terminal resize uses `TIOCSWINSZ` ioctl via portable-pty
- `TERM=xterm-256color` is set automatically

### Frontend

- Uses `@xterm/xterm` for terminal rendering
- `@xterm/addon-fit` for auto-sizing
- `@xterm/addon-web-links` for clickable URLs
- WebSocket connection with JSON protocol
- ResizeObserver for container size changes

## Limitations

- PTY support is currently Unix-only (Linux, macOS)
- Windows support would require ConPTY integration
- Maximum of 256 broadcast subscribers per terminal
- Terminal output is logged but not line-buffered (raw bytes)
