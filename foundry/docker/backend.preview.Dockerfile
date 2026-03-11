# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3

ARG GIT_SPICE_VERSION=v0.23.0
ARG SANDBOX_AGENT_VERSION=0.3.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gh \
    nodejs \
    npm \
    openssh-client \
  && npm install -g pnpm@10.28.2 \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) spice_arch="x86_64" ;; \
    arm64) spice_arch="aarch64" ;; \
    *) echo "Unsupported architecture for git-spice: $arch" >&2; exit 1 ;; \
  esac; \
  tmpdir="$(mktemp -d)"; \
  curl -fsSL "https://github.com/abhinav/git-spice/releases/download/${GIT_SPICE_VERSION}/git-spice.Linux-${spice_arch}.tar.gz" -o "${tmpdir}/git-spice.tgz"; \
  tar -xzf "${tmpdir}/git-spice.tgz" -C "${tmpdir}"; \
  install -m 0755 "${tmpdir}/gs" /usr/local/bin/gs; \
  ln -sf /usr/local/bin/gs /usr/local/bin/git-spice; \
  rm -rf "${tmpdir}"

RUN curl -fsSL "https://releases.rivet.dev/sandbox-agent/${SANDBOX_AGENT_VERSION}/install.sh" | sh

ENV PATH="/root/.local/bin:${PATH}"
ENV SANDBOX_AGENT_BIN="/root/.local/bin/sandbox-agent"

WORKDIR /workspace/quebec

COPY quebec /workspace/quebec
COPY rivet-checkout /workspace/rivet-checkout

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sandbox-agent/foundry-shared build
RUN pnpm --filter @sandbox-agent/foundry-client build
RUN pnpm --filter @sandbox-agent/foundry-backend build

CMD ["bash", "-lc", "git config --global --add safe.directory /workspace/quebec >/dev/null 2>&1 || true; exec bun packages/backend/dist/index.js start --host 0.0.0.0 --port 7841"]
