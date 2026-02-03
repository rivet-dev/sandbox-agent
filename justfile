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
dev:
	pnpm dev -F @sandbox-agent/inspector

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
dev-docs:
	cd docs && pnpm dlx mintlify dev
