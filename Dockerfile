# syntax=docker/dockerfile:1

# node:*-alpine: the built-in `node` user is uid/gid 1000 (the cluster convention), and a
# shell stays available for `kubectl exec` debugging. No native dependencies, so the
# marginal CVE saving of distroless isn't worth a uid override.
ARG NODE_VERSION=24.21.0

# ---------- build ----------
# Build on the runner's native platform: the output is platform-independent JS and no
# production dependency has native code or install scripts, so there is no reason to
# run npm/tsc under QEMU for arm64.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` runs the build, and src/ isn't copied yet.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
# Production-only tree for the runtime stage.
RUN npm ci --omit=dev --ignore-scripts

# ---------- runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

ARG BUILD_DATE
ARG VCS_REF
ARG VERSION
LABEL org.opencontainers.image.title="retroachievements-mcp" \
      org.opencontainers.image.description="Token-efficient MCP server for the RetroAchievements Web API (stdio + Streamable HTTP)" \
      org.opencontainers.image.source="https://github.com/sharkusmanch/retroachievements-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}"

# Default to HTTP in the container (the cluster use). `docker run -i ... --stdio`
# overrides it for local stdio clients. The catalog cache lives under /tmp so the image
# works with readOnlyRootFilesystem + an emptyDir.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    RA_CACHE_DIR=/tmp/retroachievements-mcp

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Pre-create the cache dir owned by `node`, so a named volume mounted here inherits
# writable ownership (Docker copies image ownership into a fresh volume):
#   docker run -i --rm -v retroachievements-mcp-cache:/tmp/retroachievements-mcp …
RUN mkdir -p /tmp/retroachievements-mcp && chown node:node /tmp/retroachievements-mcp

USER node
EXPOSE 8080

# Exec form: node is PID 1 and receives SIGTERM directly for the graceful drain.
ENTRYPOINT ["node", "dist/index.js"]
