# Docker Sandbox Example

Runs sandbox-agent inside a Docker Sandbox microVM for enhanced isolation.

## Requirements

- Docker Desktop 4.58+ (macOS or Windows)
- `ANTHROPIC_API_KEY` environment variable

## Usage

```bash
pnpm start
```

First run builds the image and creates the VM (slow). Subsequent runs reuse the VM (fast).

To clean up resources:
```bash
pnpm cleanup
```

## What it does

1. Checks if VM exists, creates one if not (via sandboxd daemon API)
2. Builds and loads the template image into the VM (one-time)
3. Starts a container with sandbox-agent server (with proxy config for network access)
4. Creates a Claude session and sends a test message
5. Streams and displays Claude's response

## Notes

- Docker Sandbox VMs have network isolation - outbound HTTPS goes through a proxy at `host.docker.internal:3128`
- The container is configured with `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is set to bypass proxy SSL verification (for testing)
- `ANTHROPIC_API_KEY` is baked into the container at creation time - run `pnpm cleanup` and restart if you change the key
- Resources are kept hot between runs for faster iteration - use `pnpm cleanup` to remove
