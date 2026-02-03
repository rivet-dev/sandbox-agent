# Docker Sandbox Research

Research on Docker Desktop's Sandbox feature and its internal APIs.

## Overview

Docker Sandboxes (Docker Desktop 4.58+) provide hypervisor-level isolation using lightweight microVMs. Each sandbox gets its own kernel, private Docker daemon, and isolated network.

- **Platforms:** macOS (virtualization.framework), Windows (Hyper-V, experimental). Linux uses legacy container-based sandboxes.
- **Isolation:** MicroVM with separate kernel, not shared like containers
- **Networking:** Each VM has private network namespace, no cross-sandbox or host localhost access
- **File access:** Bidirectional file sync for specified workspace directories

## Official CLI

### Core Commands

```bash
# List sandboxes
docker sandbox ls

# Create and run
docker sandbox run claude ~/my-project

# Create without running
docker sandbox create --name my-sandbox claude ~/my-project

# Execute command in sandbox
docker sandbox exec my-sandbox <command>

# Execute with environment variables
docker sandbox exec -e API_KEY="xxx" my-sandbox <command>

# Stop sandbox (preserves state)
docker sandbox stop my-sandbox

# Remove sandbox
docker sandbox rm my-sandbox

# Inspect sandbox details
docker sandbox inspect my-sandbox

# Reset all sandboxes
docker sandbox reset

# Show version
docker sandbox version
```

### Run Options

```bash
docker sandbox run AGENT WORKSPACE [-- AGENT_ARGS...]

# Options:
#   --name              Custom sandbox name (default: <agent>-<workdir>)
#   -t, --template      Custom container image for sandbox
#   --load-local-template  Load locally built template image
#   --                  Pass additional arguments to agent
```

### Template Management

```bash
# Save current sandbox state as template
docker sandbox save my-sandbox my-template:v1

# Run with custom template
docker sandbox run --template my-template:v1 claude ~/project

# Run with local template (not pushed to registry)
docker sandbox run --load-local-template -t my-local-template:v1 claude ~/project
```

**Agent validation:** The CLI validates `agent_name` against a whitelist (claude, codex, gemini, etc.). This can be bypassed via the raw sandboxd API.

## Internal sandboxd API (Undocumented)

The `docker sandbox` CLI communicates with a daemon via Unix socket. This API is **undocumented and subject to change**.

### Socket Location

```
~/.docker/sandboxes/sandboxd.sock
```

### Endpoints

#### List VMs

```bash
curl -s --unix-socket ~/.docker/sandboxes/sandboxd.sock http://localhost/vm
```

Response:
```json
[
  {
    "vm_id": "uuid",
    "vm_name": "agent-vm",
    "agent_name": "claude",
    "workspace_dir": "/path/to/workspace"
  }
]
```

#### Create VM

```bash
curl -s -X POST --unix-socket ~/.docker/sandboxes/sandboxd.sock \
  http://localhost/vm \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "sandbox-agent", "workspace_dir": "/path/to/workspace"}'
```

**Required fields:**
- `agent_name` - Name of the agent (no whitelist validation at API level)
- `workspace_dir` - Host directory to sync into VM

Response:
```json
{
  "vm_id": "uuid",
  "vm_name": "sandbox-agent-vm",
  "vm_config": {
    "socketPath": "/Users/x/.docker/sandboxes/vm/sandbox-agent-vm/docker.sock",
    "fileSharingDirectories": ["/path/to/workspace"],
    "stateDir": "/Users/x/.docker/sandboxes/vm/sandbox-agent-vm",
    "assetDir": "/Users/x/.container-platform"
  },
  "ca_cert_path": "/Users/x/.docker/sandboxes/vm/sandbox-agent-vm/proxy_cacerts/proxy-ca.crt",
  "ca_cert_data": "base64..."
}
```

#### Delete VM

```bash
curl -s -X DELETE --unix-socket ~/.docker/sandboxes/sandboxd.sock \
  http://localhost/vm/{vm_name}
```

### VM Docker Socket

Each VM exposes its own Docker daemon at `vm_config.socketPath`. Use this to interact with containers inside the VM:

```bash
SOCK="/Users/x/.docker/sandboxes/vm/sandbox-agent-vm/docker.sock"

# List containers in VM
docker --host "unix://$SOCK" ps

# Load image into VM
docker save my-image:latest | docker --host "unix://$SOCK" load

# Run container in VM
docker --host "unix://$SOCK" run -d --name my-container my-image:latest

# Execute command in container
docker --host "unix://$SOCK" exec my-container <command>
```

### Why Use the Raw API?

The `docker sandbox` CLI validates agent names against a whitelist. The raw sandboxd API bypasses this validation, allowing custom agent names like `sandbox-agent`.

## Directory Structure

```
~/.docker/sandboxes/
├── sandboxd.sock                    # Main daemon socket
├── vm/
│   └── <sandbox-name>/
│       ├── docker.sock              # Per-VM Docker daemon socket
│       ├── proxy-config.json        # Network proxy configuration
│       └── proxy_cacerts/
│           └── proxy-ca.crt         # MITM proxy CA certificate
└── ...

~/.sandboxd/
└── proxy-config.json                # Default proxy config for new sandboxes
```

## File Sharing

The `workspace_dir` parameter sets up bidirectional file sync between host and VM:

1. Specify `workspace_dir` when creating VM
2. sandboxd syncs that directory into the VM at the same absolute path
3. Mount it into containers with `-v /path:/path`

Files modified in the VM are synced back to the host.

**Important:** This is file synchronization, not volume mounting. Files are copied between host and VM.

## Network Policies

### Proxy Architecture

Each sandbox includes an HTTP/HTTPS filtering proxy:
- Runs on host, accessible at `host.docker.internal:3128` from inside sandbox
- Enforces allow/deny policies on outbound HTTP/HTTPS traffic
- Raw TCP/UDP connections are blocked

### Policy Configuration

```bash
# View current policy
docker sandbox network proxy my-sandbox

# Set allow policy (default) - allows all except blocked
docker sandbox network proxy my-sandbox --policy allow

# Set deny policy - blocks all except allowed
docker sandbox network proxy my-sandbox --policy deny

# Allow specific hosts
docker sandbox network proxy my-sandbox --allow-host api.example.com
docker sandbox network proxy my-sandbox --allow-host "*.github.com"

# Block specific hosts
docker sandbox network proxy my-sandbox --block-host malicious.com

# Block CIDR ranges (these are blocked by default)
docker sandbox network proxy my-sandbox \
  --block-cidr 10.0.0.0/8 \
  --block-cidr 172.16.0.0/12 \
  --block-cidr 192.168.0.0/16 \
  --block-cidr 127.0.0.0/8

# Bypass HTTPS inspection for specific hosts
docker sandbox network proxy my-sandbox --bypass-host pinned-cert.example.com

# View blocked/allowed requests
docker sandbox network log my-sandbox
```

### Domain Matching Rules

- Exact match: `example.com` (does NOT match subdomains)
- Port-specific: `example.com:443`
- Wildcard: `*.example.com` (subdomains only)
- Catch-all: `*` or `*:443`

### Default Blocked CIDRs

- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918)
- `127.0.0.0/8`, `169.254.0.0/16` (localhost, link-local)
- IPv6: `::1/128`, `fc00::/7`, `fe80::/10`

### HTTPS Interception

By default, the proxy performs MITM on HTTPS:
- Terminates TLS and re-encrypts with its own CA
- Allows policy enforcement and credential injection
- Sandbox container trusts proxy CA automatically

Use `--bypass-host` or `--bypass-cidr` for apps with certificate pinning.

### Configuration Files

Per-sandbox: `~/.docker/sandboxes/vm/<sandbox-name>/proxy-config.json`

```json
{
  "policy": "allow",
  "network": {
    "allowedDomains": ["api.example.com"],
    "blockedDomains": ["blocked.com"],
    "blockCIDR": ["10.0.0.0/8"]
  }
}
```

Default for new sandboxes: `~/.sandboxd/proxy-config.json`

## Sandbox Templates

### Base Images

Official templates: `docker/sandbox-templates:<agent>`
- `docker/sandbox-templates:claude-code`
- Includes: Ubuntu base, Git, Docker CLI, Node.js, Python, Go

### Creating Custom Templates

```dockerfile
FROM docker/sandbox-templates:claude-code

USER root
# Install additional packages
RUN apt-get update && apt-get install -y postgresql-client redis-tools

# Install language-specific tools
RUN pip install pandas numpy

USER agent
```

Build and use:
```bash
docker build -t my-template:v1 .
docker sandbox run --load-local-template -t my-template:v1 claude ~/project
```

### Template Best Practices

- Always switch to `root` for system installs, back to `agent` at end
- Pin specific tool versions for reproducibility
- Don't use standard images like `python:3.11` as base (missing agent binaries)
- Use `docker sandbox save` to capture working sandbox state

## Inspect Output

```bash
docker sandbox inspect my-sandbox
```

Returns JSON with:
```json
[{
  "id": "abc123...",
  "name": "my-sandbox",
  "created_at": "2025-01-15T10:30:00Z",
  "status": "running",
  "template": "docker/sandbox-templates:claude-code",
  "labels": {
    "com.docker.sandbox.agent": "claude",
    "com.docker.sandbox.workingDirectory": "/Users/x/project",
    "com.docker.sandboxes.flavor": "microvm"
  }
}]
```

## Limitations

- **No port exposure:** Sandbox VMs don't support `-p` port mapping to host
- **No host localhost access:** Cannot reach services on host machine
- **No cross-sandbox networking:** VMs are completely isolated from each other
- **macOS/Windows only:** Linux requires legacy container-based sandboxes
- **HTTP/HTTPS only:** Raw TCP/UDP connections to external services are blocked
- **Agent whitelist:** CLI validates agent names; use raw API to bypass

## Known Issues & Feature Requests

From [docker/cli GitHub issues](https://github.com/docker/cli/issues):

- **#6766** - Support for opencode in `docker sandbox create`
- **#6734** - Add GitHub Copilot CLI support to `docker sandbox run`
- **#6731** - Support platform selection (`--platform linux/amd64`)

The agent whitelist is hardcoded in the CLI. Workarounds:
1. Use the raw sandboxd API (bypasses validation)
2. Use `--template` with a custom image (still requires valid agent name)

## Source Code

The `docker sandbox` plugin is **closed source** and distributed with Docker Desktop. The open-source [docker/cli](https://github.com/docker/cli) repo does not contain sandbox implementation.

Key observations from docker/cli:
- Sandbox is a plugin, not part of core CLI
- Uses `SandboxID` and `SandboxKey` in network settings (container isolation concept)
- No sandbox subcommand code in public repo

## References

### Official Documentation
- [Docker Sandboxes Overview](https://docs.docker.com/ai/sandboxes/)
- [Docker Sandboxes Architecture](https://docs.docker.com/ai/sandboxes/architecture/)
- [Docker Sandboxes Templates](https://docs.docker.com/ai/sandboxes/templates/)
- [Network Policies](https://docs.docker.com/ai/sandboxes/network-policies/)
- [CLI Reference](https://docs.docker.com/reference/cli/docker/sandbox/)

### Blog Posts & Tutorials
- [Docker Blog: A New Approach for Coding Agent Safety](https://www.docker.com/blog/docker-sandboxes-a-new-approach-for-coding-agent-safety/)
- [Docker Blog: Run Claude Code Safely](https://www.docker.com/blog/docker-sandboxes-run-claude-code-and-other-coding-agents-unsupervised-but-safely/)
- [Everything You Need to Know About Docker AI Sandboxes](https://blog.codeminer42.com/everything-you-need-to-know-about-docker-ai-sandboxes/)
- [Docker Sandboxes Tutorial and Cheatsheet](https://www.ajeetraina.com/docker-sandboxes-tutorial-and-cheatsheet/)

### Related Projects
- [microsandbox](https://github.com/microsandbox/microsandbox) - Self-hosted microVM sandboxes
- [arrakis](https://github.com/abshkbh/arrakis) - MicroVM sandbox with backtracking support
- [docker-sandbox-run-copilot](https://github.com/henrybravo/docker-sandbox-run-copilot) - Community Copilot template
