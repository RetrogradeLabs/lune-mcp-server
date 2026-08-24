# Builds this repository on its own, without the monorepo it is mirrored from.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 8080
# stdio by default: that is what an MCP client and an external introspection
# check expect from a container, and it needs only LUNE_API_KEY in the env.
# Override with `--http --port 8080` to serve Streamable HTTP instead, which
# authenticates per request rather than from the environment.
CMD ["node", "dist/cli.js"]
