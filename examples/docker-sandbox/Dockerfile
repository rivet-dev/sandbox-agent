FROM --platform=linux/amd64 node:22-slim

RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*

# Install sandbox-agent
RUN curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh

# Pre-install claude agent and add to PATH
RUN sandbox-agent install-agent claude
ENV PATH="/root/.local/share/sandbox-agent/bin:$PATH"
