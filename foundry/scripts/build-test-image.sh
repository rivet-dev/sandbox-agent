#!/usr/bin/env bash
set -euo pipefail

echo "Docker integration test image is not part of the TypeScript migration baseline."
echo "Use workspace tests instead:"
echo "  pnpm -w typecheck"
echo "  pnpm -w build"
echo "  pnpm -w test"
