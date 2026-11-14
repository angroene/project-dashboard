# Status: verified on linux/arm64 (Docker 29.5); not yet built on amd64.
# See docs/DEPLOYMENT.md.

# ---- build: compile the web UI and the server -------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.base.json tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PCC_HOST=0.0.0.0 \
    PCC_PORT=8790 \
    PCC_DATA_ROOT=/data \
    PCC_WEB_ROOT=/app/dist/web \
    PCC_AUTH_TOKEN_FILE=/run/secrets/pcc_token
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY LICENSE ./LICENSE
COPY docs/THIRD_PARTY_LICENSES.md ./THIRD_PARTY_LICENSES.md
# The data volume is created owned by the unprivileged user so a fresh named volume is writable. projects/ exists from
# the start so the file watcher is attached at startup and new project folders show up without waiting for a rescan.
RUN mkdir -p /data/projects && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8790

# The server refuses to bind 0.0.0.0 without a token and without HTTPS (built-in TLS or a proxy declared with
# PCC_BEHIND_HTTPS_PROXY=1), so this image fails fast unless the token file and the TLS or proxy settings are
# supplied (see docker-compose.yml).
CMD ["node", "dist/server/server/main.js"]
