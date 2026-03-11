# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm into the image so we can run as a non-root user at runtime.
# Using npm here avoids Corepack's first-run download behavior.
RUN npm install -g pnpm@10.28.2

WORKDIR /app

CMD ["bash", "-lc", "LEFTHOOK=0 pnpm install --force --frozen-lockfile --filter @sandbox-agent/foundry-frontend... && cd foundry/packages/frontend && exec pnpm vite --host 0.0.0.0 --port 4173"]
