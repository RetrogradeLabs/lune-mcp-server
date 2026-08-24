# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Build stage: install deps and bundle.
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS build
WORKDIR /app

# Copy workspace manifest + lockfile for cached install
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY packages/typescript-config ./packages/typescript-config
COPY apps/mcp ./apps/mcp

# Install only what apps/mcp needs (workspace-aware). --ignore-scripts skips
# the root `prepare` (lefthook install), which has no git repo to wire up here.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts --filter @retrograde-labs/lune-mcp-server
RUN bun run --filter @retrograde-labs/lune-mcp-server build

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS production-dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY packages/typescript-config ./packages/typescript-config
COPY apps/mcp/package.json ./apps/mcp/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts --production --filter @retrograde-labs/lune-mcp-server

# Runtime stage: minimal Node image. The published npm package targets Node, so
# the container runs the same runtime our users do.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
WORKDIR /app

# curl for ECS health checks
RUN apk add --no-cache curl

# Copy bundled output + the production-only hoisted tree. tsup leaves runtime
# dependencies external, and Bun may create no package-local node_modules.
COPY --from=build /app/apps/mcp/dist ./dist
COPY --from=build /app/apps/mcp/package.json ./package.json
COPY --from=production-dependencies /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 8080

# tini-less; node handles signals fine for an Express server
CMD ["node", "dist/cli.js", "--http", "--port", "8080"]
