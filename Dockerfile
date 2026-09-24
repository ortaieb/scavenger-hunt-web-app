# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
ARG ALPINE_VERSION=3.22

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

# --- runtime: distroless, no shell or package manager, runs as nonroot -------
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000
# The distroless image already runs as the unprivileged `nonroot` user (65532).
USER nonroot
# `node` is the image entrypoint, so CMD only carries the script path.
#
# The camera/geolocation APIs the /challenge page uses require HTTPS (or
# localhost). This image serves plain HTTP by default; mount a real
# certificate and set TLS_KEY_PATH/TLS_CERT_PATH to serve HTTPS directly, or
# terminate TLS at a reverse proxy in front of it.
CMD ["dist/index.js"]
