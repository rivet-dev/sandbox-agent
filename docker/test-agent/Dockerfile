FROM rust:1.88.0-bookworm AS builder
WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY server/ ./server/
COPY gigacode/ ./gigacode/
COPY resources/agent-schemas/artifacts/ ./resources/agent-schemas/artifacts/
COPY scripts/agent-configs/ ./scripts/agent-configs/

ENV SANDBOX_AGENT_SKIP_INSPECTOR=1

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build -p sandbox-agent --release && \
    cp target/release/sandbox-agent /sandbox-agent

FROM node:22-bookworm-slim
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      ca-certificates \
      bash \
      libstdc++6 \
      xvfb \
      openbox \
      xdotool \
      imagemagick \
      x11-xserver-utils \
      dbus-x11 \
      xauth \
      fonts-dejavu-core \
      xterm \
      > /dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /sandbox-agent /usr/local/bin/sandbox-agent

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/sandbox-agent"]
CMD ["server", "--host", "0.0.0.0", "--port", "3000", "--no-token"]
