# syntax=docker/dockerfile:1
# GitSlappin, optional Docker mode. See README "Run with Docker".

FROM node:24.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --silent --no-audit --no-fund
COPY shared shared
COPY server server
COPY client client
RUN npm run build

FROM node:24.22.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system safe.directory '*' \
 && mkdir /data \
 && chown 1000:1000 /data
COPY --from=build /app /app
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/gitslappin-entrypoint
ENV NODE_ENV=production HOME=/home/node
USER node
WORKDIR /app/server
ENTRYPOINT ["/usr/local/bin/gitslappin-entrypoint"]
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
