# syntax=docker/dockerfile:1.10.0
FROM rust:1.88.0 AS base

# Install dependencies
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
    g++-multilib \
    git \
    curl && \
    rm -rf /var/lib/apt/lists/* && \
    wget -q https://github.com/cross-tools/musl-cross/releases/latest/download/x86_64-unknown-linux-musl.tar.xz && \
    tar -xf x86_64-unknown-linux-musl.tar.xz -C /opt/ && \
    rm x86_64-unknown-linux-musl.tar.xz

# Install musl targets
RUN rustup target add x86_64-unknown-linux-musl

# Set environment variables
ENV PATH="/opt/x86_64-unknown-linux-musl/bin:$PATH" \
    LIBCLANG_PATH=/usr/lib/llvm-14/lib \
    CLANG_PATH=/usr/bin/clang-14 \
    CC_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-gcc \
    CXX_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-g++ \
    AR_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-ar \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-unknown-linux-musl-gcc \
    CARGO_INCREMENTAL=0 \
    RUSTFLAGS="-C target-feature=+crt-static -C link-arg=-static-libgcc" \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

# Set working directory
WORKDIR /build

# Build for x86_64
FROM base AS x86_64-builder

# Set up OpenSSL for x86_64 musl target
ENV SSL_VER=1.1.1w
RUN wget https://www.openssl.org/source/openssl-$SSL_VER.tar.gz \
    && tar -xzf openssl-$SSL_VER.tar.gz \
    && cd openssl-$SSL_VER \
    && ./Configure no-shared no-async --prefix=/musl --openssldir=/musl/ssl linux-x86_64 \
    && make -j$(nproc) \
    && make install_sw \
    && cd .. \
    && rm -rf openssl-$SSL_VER*

# Configure OpenSSL env vars for the build
ENV OPENSSL_DIR=/musl \
    OPENSSL_INCLUDE_DIR=/musl/include \
    OPENSSL_LIB_DIR=/musl/lib \
    PKG_CONFIG_ALLOW_CROSS=1

# Copy the source code
COPY . .

# Build for Linux with musl (static binary) - x86_64
# SANDBOX_AGENT_SKIP_INSPECTOR=1 skips embedding the inspector frontend
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent --release --target x86_64-unknown-linux-musl && \
    mkdir -p /artifacts && \
    cp target/x86_64-unknown-linux-musl/release/sandbox-agent /artifacts/sandbox-agent-x86_64-unknown-linux-musl

# Default command to show help
CMD ["ls", "-la", "/artifacts"]
