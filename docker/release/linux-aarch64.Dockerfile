# syntax=docker/dockerfile:1.10.0

# Build inspector frontend
FROM node:22-alpine AS inspector-build
WORKDIR /app
RUN npm install -g pnpm

# Copy package files for workspaces
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/packages/inspector/package.json ./frontend/packages/inspector/
COPY sdks/cli-shared/package.json ./sdks/cli-shared/
COPY sdks/typescript/package.json ./sdks/typescript/

# Install dependencies
RUN pnpm install --filter @sandbox-agent/inspector...

# Copy SDK source (with pre-generated types from docs/openapi.json)
COPY docs/openapi.json ./docs/
COPY sdks/cli-shared ./sdks/cli-shared
COPY sdks/typescript ./sdks/typescript

# Build cli-shared and SDK (just tsup, skip generate since types are pre-generated)
RUN cd sdks/cli-shared && pnpm exec tsup
RUN cd sdks/typescript && SKIP_OPENAPI_GEN=1 pnpm exec tsup

# Copy inspector source and build
COPY frontend/packages/inspector ./frontend/packages/inspector
RUN cd frontend/packages/inspector && pnpm exec vite build

FROM rust:1.88.0 AS base

# Install dependencies for native ARM64 build with musl
# Note: This Dockerfile runs on ARM64 runners, so we use native compilation
RUN apt-get update && apt-get install -y \
    musl-tools \
    musl-dev \
    llvm-14-dev \
    libclang-14-dev \
    clang-14 \
    libssl-dev \
    pkg-config \
    ca-certificates \
    g++ \
    git \
    curl && \
    rm -rf /var/lib/apt/lists/*

# Install musl target for Rust
RUN rustup target add aarch64-unknown-linux-musl

# Set environment variables for native musl build
ENV LIBCLANG_PATH=/usr/lib/llvm-14/lib \
    CLANG_PATH=/usr/bin/clang-14 \
    CC_aarch64_unknown_linux_musl=musl-gcc \
    CXX_aarch64_unknown_linux_musl=g++ \
    AR_aarch64_unknown_linux_musl=ar \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc \
    CARGO_INCREMENTAL=0 \
    RUSTFLAGS="-C target-feature=+crt-static" \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

# Set working directory
WORKDIR /build

# Build for aarch64
FROM base AS aarch64-builder

# Accept version as build arg
ARG SANDBOX_AGENT_VERSION
ENV SANDBOX_AGENT_VERSION=${SANDBOX_AGENT_VERSION}

# Set up OpenSSL for aarch64 musl target (native build on ARM64)
ENV SSL_VER=1.1.1w
RUN wget https://www.openssl.org/source/openssl-$SSL_VER.tar.gz \
    && tar -xzf openssl-$SSL_VER.tar.gz \
    && cd openssl-$SSL_VER \
    && CC=musl-gcc ./Configure no-shared no-async --prefix=/musl --openssldir=/musl/ssl linux-aarch64 \
    && make -j$(nproc) \
    && make install_sw \
    && cd .. \
    && rm -rf openssl-$SSL_VER*

# Configure OpenSSL env vars for the build
ENV OPENSSL_DIR=/musl \
    OPENSSL_INCLUDE_DIR=/musl/include \
    OPENSSL_LIB_DIR=/musl/lib \
    OPENSSL_STATIC=1

# Copy the source code
COPY . .

# Copy pre-built inspector frontend
COPY --from=inspector-build /app/frontend/packages/inspector/dist ./frontend/packages/inspector/dist

# Build for Linux with musl (static binary) - aarch64
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build -p sandbox-agent --release --target aarch64-unknown-linux-musl && \
    mkdir -p /artifacts && \
    cp target/aarch64-unknown-linux-musl/release/sandbox-agent /artifacts/sandbox-agent-aarch64-unknown-linux-musl

# Default command to show help
CMD ["ls", "-la", "/artifacts"]
