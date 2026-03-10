set dotenv-load := true

# =============================================================================
# Release
# =============================================================================

[group('release')]
release *ARGS:
	cd scripts/release && pnpm exec tsx ./main.ts --phase setup-local {{ ARGS }}

# Build a single target via Docker
[group('release')]
release-build target="x86_64-unknown-linux-musl":
	./docker/release/build.sh {{target}}

# Build all release binaries
[group('release')]
release-build-all:
	./docker/release/build.sh x86_64-unknown-linux-musl
	./docker/release/build.sh aarch64-unknown-linux-musl
	./docker/release/build.sh x86_64-pc-windows-gnu
	./docker/release/build.sh x86_64-apple-darwin
	./docker/release/build.sh aarch64-apple-darwin

# =============================================================================
# Development
# =============================================================================

[group('dev')]
dev-daemon:
	SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo run -p sandbox-agent -- daemon start --upgrade

[group('dev')]
dev: dev-daemon
	pnpm dev -F @sandbox-agent/inspector -- --host 0.0.0.0

[group('dev')]
build:
	cargo build -p sandbox-agent

[group('dev')]
test:
	cargo test --all-targets

[group('dev')]
check:
	cargo check --all-targets
	cargo fmt --all -- --check
	pnpm run typecheck

[group('dev')]
fmt:
	cargo fmt --all

[group('dev')]
install-fast-sa:
	SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build --release -p sandbox-agent
	rm -f ~/.cargo/bin/sandbox-agent
	cp target/release/sandbox-agent ~/.cargo/bin/sandbox-agent

[group('dev')]
install-gigacode:
	SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build --release -p gigacode
	rm -f ~/.cargo/bin/gigacode
	cp target/release/gigacode ~/.cargo/bin/gigacode

[group('dev')]
run-sa *ARGS:
	SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo run -p sandbox-agent -- {{ ARGS }}

[group('dev')]
run-gigacode *ARGS:
	SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo run -p gigacode -- {{ ARGS }}

[group('dev')]
dev-docs:
	cd docs && pnpm dlx mintlify dev --host 0.0.0.0

install:
    pnpm install
    pnpm build --filter @sandbox-agent/inspector...
    cargo install --path server/packages/sandbox-agent --debug
    cargo install --path gigacode --debug

install-fast:
    SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo install --path server/packages/sandbox-agent --debug
    SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo install --path gigacode --debug

install-release:
    pnpm install
    pnpm build --filter @sandbox-agent/inspector...
    cargo install --path server/packages/sandbox-agent
    cargo install --path gigacode
