# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/backend/package.json packages/backend/package.json
COPY packages/rivetkit-vendor/rivetkit/package.json packages/rivetkit-vendor/rivetkit/package.json
COPY packages/rivetkit-vendor/workflow-engine/package.json packages/rivetkit-vendor/workflow-engine/package.json
COPY packages/rivetkit-vendor/traces/package.json packages/rivetkit-vendor/traces/package.json
COPY packages/rivetkit-vendor/sqlite-vfs/package.json packages/rivetkit-vendor/sqlite-vfs/package.json
COPY packages/rivetkit-vendor/sqlite-vfs-linux-x64/package.json packages/rivetkit-vendor/sqlite-vfs-linux-x64/package.json
COPY packages/rivetkit-vendor/sqlite-vfs-linux-arm64/package.json packages/rivetkit-vendor/sqlite-vfs-linux-arm64/package.json
COPY packages/rivetkit-vendor/sqlite-vfs-darwin-arm64/package.json packages/rivetkit-vendor/sqlite-vfs-darwin-arm64/package.json
COPY packages/rivetkit-vendor/sqlite-vfs-darwin-x64/package.json packages/rivetkit-vendor/sqlite-vfs-darwin-x64/package.json
COPY packages/rivetkit-vendor/sqlite-vfs-win32-x64/package.json packages/rivetkit-vendor/sqlite-vfs-win32-x64/package.json
COPY packages/rivetkit-vendor/runner/package.json packages/rivetkit-vendor/runner/package.json
COPY packages/rivetkit-vendor/runner-protocol/package.json packages/rivetkit-vendor/runner-protocol/package.json
COPY packages/rivetkit-vendor/virtual-websocket/package.json packages/rivetkit-vendor/virtual-websocket/package.json
RUN pnpm fetch --frozen-lockfile --filter @sandbox-agent/foundry-backend...

FROM base AS build
COPY --from=deps /pnpm/store /pnpm/store
COPY . .
RUN pnpm install --frozen-lockfile --prefer-offline --filter @sandbox-agent/foundry-backend...
RUN pnpm --filter @sandbox-agent/foundry-shared build
RUN pnpm --filter @sandbox-agent/foundry-backend build
RUN pnpm --filter @sandbox-agent/foundry-backend deploy --prod --legacy /out

FROM oven/bun:1.2 AS runtime
ENV NODE_ENV=production
ENV HOME=/home/task
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    gh \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN addgroup --system --gid 1001 task \
  && adduser --system --uid 1001 --home /home/task --ingroup task task \
  && mkdir -p /home/task \
  && chown -R task:task /home/task /app
COPY --from=build /out ./
USER task
EXPOSE 7741
CMD ["bun", "dist/index.js", "start", "--host", "0.0.0.0"]
