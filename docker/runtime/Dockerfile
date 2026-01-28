# syntax=docker/dockerfile:1.10.0

# Build stage - compile the binary
FROM rust:1.88.0 AS builder

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies (g++-multilib not available on arm64)
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
    curl \
    wget && \
    rm -rf /var/lib/apt/lists/*

# Install musl cross toolchain for amd64 only
# On arm64, we build natively using musl-gcc from musl-tools (already installed)
RUN if [ "$TARGETARCH" = "amd64" ]; then \
        wget -q https://github.com/cross-tools/musl-cross/releases/latest/download/x86_64-unknown-linux-musl.tar.xz && \
        tar -xf x86_64-unknown-linux-musl.tar.xz -C /opt/ && \
        rm x86_64-unknown-linux-musl.tar.xz && \
        rustup target add x86_64-unknown-linux-musl; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        rustup target add aarch64-unknown-linux-musl; \
    fi

# Set environment variables based on architecture
ENV LIBCLANG_PATH=/usr/lib/llvm-14/lib \
    CLANG_PATH=/usr/bin/clang-14 \
    CARGO_INCREMENTAL=0 \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

# Build OpenSSL for musl target
ENV SSL_VER=1.1.1w
RUN if [ "$TARGETARCH" = "amd64" ]; then \
        export PATH="/opt/x86_64-unknown-linux-musl/bin:$PATH" && \
        wget https://www.openssl.org/source/openssl-$SSL_VER.tar.gz && \
        tar -xzf openssl-$SSL_VER.tar.gz && \
        cd openssl-$SSL_VER && \
        ./Configure no-shared no-async --prefix=/musl --openssldir=/musl/ssl linux-x86_64 && \
        make -j$(nproc) && \
        make install_sw && \
        cd .. && \
        rm -rf openssl-$SSL_VER*; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        export CC=musl-gcc && \
        wget https://www.openssl.org/source/openssl-$SSL_VER.tar.gz && \
        tar -xzf openssl-$SSL_VER.tar.gz && \
        cd openssl-$SSL_VER && \
        ./Configure no-shared no-async --prefix=/musl --openssldir=/musl/ssl linux-aarch64 && \
        make -j$(nproc) && \
        make install_sw && \
        cd .. && \
        rm -rf openssl-$SSL_VER*; \
    fi

# Set OpenSSL environment variables
ENV OPENSSL_DIR=/musl \
    OPENSSL_INCLUDE_DIR=/musl/include \
    OPENSSL_LIB_DIR=/musl/lib \
    PKG_CONFIG_ALLOW_CROSS=1

WORKDIR /build
COPY . .

# Build static binary based on architecture
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    if [ "$TARGETARCH" = "amd64" ]; then \
        export PATH="/opt/x86_64-unknown-linux-musl/bin:$PATH" && \
        export CC_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-gcc && \
        export CXX_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-g++ && \
        export AR_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-ar && \
        export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-unknown-linux-musl-gcc && \
        export RUSTFLAGS="-C target-feature=+crt-static -C link-arg=-static-libgcc" && \
        SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent --release --target x86_64-unknown-linux-musl && \
        cp target/x86_64-unknown-linux-musl/release/sandbox-agent /sandbox-agent; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        export CC_aarch64_unknown_linux_musl=musl-gcc && \
        export AR_aarch64_unknown_linux_musl=ar && \
        export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc && \
        export RUSTFLAGS="-C target-feature=+crt-static" && \
        SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent --release --target aarch64-unknown-linux-musl && \
        cp target/aarch64-unknown-linux-musl/release/sandbox-agent /sandbox-agent; \
    fi

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
