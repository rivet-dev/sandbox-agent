# syntax=docker/dockerfile:1.10.0
FROM rust:1.88.0

# Install dependencies
RUN apt-get update && apt-get install -y \
    llvm-14-dev \
    libclang-14-dev \
    clang-14 \
    gcc-mingw-w64-x86-64 \
    g++-mingw-w64-x86-64 \
    binutils-mingw-w64-x86-64 \
    ca-certificates \
    curl \
    git && \
    rm -rf /var/lib/apt/lists/*

# Switch MinGW-w64 to the POSIX threading model toolchain
RUN update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix && \
    update-alternatives --set x86_64-w64-mingw32-g++ /usr/bin/x86_64-w64-mingw32-g++-posix

# Install target
RUN rustup target add x86_64-pc-windows-gnu

# Configure Cargo for Windows cross-compilation
RUN mkdir -p /root/.cargo && \
    echo '\
[target.x86_64-pc-windows-gnu]\n\
linker = "x86_64-w64-mingw32-gcc"\n\
' > /root/.cargo/config.toml

# Set environment variables for cross-compilation
ENV CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
    CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc \
    CXX_x86_64_pc_windows_gnu=x86_64-w64-mingw32-g++ \
    CC_x86_64-pc-windows-gnu=x86_64-w64-mingw32-gcc \
    CXX_x86_64-pc-windows-gnu=x86_64-w64-mingw32-g++ \
    LIBCLANG_PATH=/usr/lib/llvm-14/lib \
    CLANG_PATH=/usr/bin/clang-14 \
    CARGO_INCREMENTAL=0 \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

# Set working directory
WORKDIR /build

# Copy the source code
COPY . .

# Build for Windows
# SANDBOX_AGENT_SKIP_INSPECTOR=1 skips embedding the inspector frontend
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent --release --target x86_64-pc-windows-gnu && \
    mkdir -p /artifacts && \
    cp target/x86_64-pc-windows-gnu/release/sandbox-agent.exe /artifacts/sandbox-agent-x86_64-pc-windows-gnu.exe

# Default command to show help
CMD ["ls", "-la", "/artifacts"]
