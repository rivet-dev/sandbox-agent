# syntax=docker/dockerfile:1.10.0

# Build stage - compile the binary
FROM rust:1.88.0 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    musl-tools \
    musl-dev \
    pkg-config \
    ca-certificates \
    git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN rustup target add x86_64-unknown-linux-musl

WORKDIR /build
COPY . .

# Build static binary
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    SANDBOX_AGENT_SKIP_INSPECTOR=1 \
    RUSTFLAGS="-C target-feature=+crt-static" \
    cargo build -p sandbox-agent --release --target x86_64-unknown-linux-musl && \
    cp target/x86_64-unknown-linux-musl/release/sandbox-agent /sandbox-agent

# Runtime stage - minimal image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    git && \
    rm -rf /var/lib/apt/lists/*

# Copy the binary from builder
COPY --from=builder /sandbox-agent /usr/local/bin/sandbox-agent
RUN chmod +x /usr/local/bin/sandbox-agent

# Create non-root user
RUN useradd -m -s /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox

EXPOSE 2468

ENTRYPOINT ["sandbox-agent"]
CMD ["--host", "0.0.0.0", "--port", "2468"]
