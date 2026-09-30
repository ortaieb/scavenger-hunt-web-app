# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
ARG ALPINE_VERSION=3.22
# "nonroot" (default): hardened, no shell/package manager — see below.
# "debug-nonroot": the same image plus BusyBox (a shell + core utilities),
# for on-demand interactive debugging (e.g. Railway's console, `docker exec`)
# — see issue #28. Never the default: pass
# --build-arg RUNTIME_TAG=debug-nonroot explicitly when you actually need a
# shell; production should stay on the shell-less image.
ARG RUNTIME_TAG=nonroot

# --- build: full toolchain, compiles TypeScript to dist/ ---------------------
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- deps: production dependencies only --------------------------------------
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# --- runtime: distroless, no shell or package manager by default, nonroot ---
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:${RUNTIME_TAG} AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000
# The distroless image already runs as the unprivileged `nonroot` user (65532).
USER nonroot

# No shell or curl in this image (distroless), so the probe is a plain node
# script hitting /health directly. PORT is read at HEALTHCHECK-run time, so
# a platform-injected override (e.g. Railway's) is honoured, not just the
# ENV default above. /nodejs/bin/node is the image's own entrypoint binary
# (see its Config.Entrypoint) — it isn't on PATH for a bare `exec`, unlike
# when it's the container's own ENTRYPOINT, so the absolute path is required.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://localhost:${process.env.PORT}/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# `node` is the image entrypoint, so CMD only carries the script path.
#
# This image never bakes in a TLS certificate and defaults to plain HTTP
# (no TLS_KEY_PATH/TLS_CERT_PATH set, nothing mounted at ./certs) — the
# right mode for a platform like Railway that terminates HTTPS itself (see
# issue #24). The camera/geolocation APIs /challenge uses do require HTTPS
# off localhost, but that's the platform's job here, not this container's;
# for serving HTTPS directly instead, mount a real certificate and set
# TLS_KEY_PATH/TLS_CERT_PATH.
CMD ["dist/index.js"]
