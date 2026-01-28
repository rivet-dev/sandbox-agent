# syntax=docker/dockerfile:1.10.0
FROM rust:1.91.0 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -y && \
    apt-get install -y \
    musl-tools \
    musl-dev \
    pkg-config \
    ca-certificates \
    git \
    perl \
    make && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Build OpenSSL for musl target
RUN curl -sL https://www.openssl.org/source/openssl-3.2.0.tar.gz | tar xz && \
    cd openssl-3.2.0 && \
    CC=musl-gcc ./Configure no-shared no-async --prefix=/usr/local/musl linux-x86_64 && \
    make -j$(nproc) && \
    make install_sw && \
    cd .. && rm -rf openssl-3.2.0

RUN rustup target add x86_64-unknown-linux-musl

ENV OPENSSL_DIR=/usr/local/musl \
    OPENSSL_STATIC=1 \
    PKG_CONFIG_ALLOW_CROSS=1

WORKDIR /build
COPY . .

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    RUSTFLAGS="-C target-feature=+crt-static" \
    cargo build -p sandbox-agent --release --target x86_64-unknown-linux-musl && \
    mkdir -p /artifacts && \
    cp target/x86_64-unknown-linux-musl/release/sandbox-agent /artifacts/sandbox-agent-x86_64-unknown-linux-musl

CMD ["ls", "-la", "/artifacts"]
