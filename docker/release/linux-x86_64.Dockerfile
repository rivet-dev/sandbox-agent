# syntax=docker/dockerfile:1.10.0
FROM rust:1.91.0 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -y && \
    apt-get install -y \
    musl-tools \
    pkg-config \
    ca-certificates \
    git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN rustup target add x86_64-unknown-linux-musl

WORKDIR /build
COPY . .

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    RUSTFLAGS="-C target-feature=+crt-static" \
    cargo build -p sandbox-daemon-core --release --target x86_64-unknown-linux-musl && \
    mkdir -p /artifacts && \
    cp target/x86_64-unknown-linux-musl/release/sandbox-daemon /artifacts/sandbox-daemon-x86_64-unknown-linux-musl

CMD ["ls", "-la", "/artifacts"]
