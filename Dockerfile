# syntax=docker/dockerfile:1.7
# Build stage: install deps and bundle.
FROM node:20-alpine AS build
WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

# Copy workspace manifest + lockfile for cached install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY tooling ./tooling
COPY apps/mcp ./apps/mcp

# Install only what apps/mcp needs (workspace-aware)
RUN pnpm install --frozen-lockfile --filter @retrograde-labs/lune-mcp-server...
RUN pnpm --filter @retrograde-labs/lune-mcp-server build

# Runtime stage: minimal Node image
FROM node:20-alpine AS runtime
WORKDIR /app

# curl for ECS health checks
RUN apk add --no-cache curl

# Copy bundled output + workspace node_modules (tsup leaves runtime deps external)
COPY --from=build /app/apps/mcp/dist ./dist
COPY --from=build /app/apps/mcp/package.json ./package.json
COPY --from=build /app/apps/mcp/node_modules ./node_modules
COPY --from=build /app/node_modules ./node_modules_workspace

# Hoisted pnpm puts most deps at root node_modules; merge so node can resolve them
RUN cp -rn node_modules_workspace/* node_modules/ 2>/dev/null || true && rm -rf node_modules_workspace

ENV NODE_ENV=production
EXPOSE 8080

# tini-less; node handles signals fine for an Express server
CMD ["node", "dist/cli.js", "--http", "--port", "8080"]
