FROM node:24-slim

ENV CI=true

# System deps: curl for HTTP testing, postgresql for the local Azure stack's
# database — this container has no docker, so `docker compose` (the way
# every other environment gets Postgres for the Azure stack) isn't an
# option; Postgres has to live in the image itself. See
# `tests/treespec/spec.yaml` for the runtime side of this (starting the
# server and creating the unidocs role/database) and
# `azure/local/runtime.mjs`'s `postgres: "external"` option for how
# `startAzureRuntime()` connects to it instead of shelling out to compose.
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y curl postgresql \
    && rm -rf /var/lib/apt/lists/*

# treespec 的容器里没有 docker，所以本地 Azure 栈的 Postgres 只能装在
# 这个镜像里。端口 5433 与 packages/azure-sdk/docker-compose.yml 的宿主机映射一致，
# 这样 startAzureRuntime() 的连接串两种模式下完全相同。
ENV PGDATA=/var/lib/postgresql/data
RUN mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA"
USER postgres
RUN /usr/lib/postgresql/*/bin/initdb -D "$PGDATA" \
    && echo "port = 5433" >> "$PGDATA/postgresql.conf" \
    && echo "listen_addresses = 'localhost'" >> "$PGDATA/postgresql.conf"
USER root

# Public npm registries are SNI-blocked in this environment, same as the
# Debian mirror rewrite above — `corepack prepare` needs the same treatment.
# `COREPACK_NPM_REGISTRY` was tried first (the direct analogue of the apt
# mirror line) but does not actually work against this particular mirror:
# corepack resolves a package manager version via `<registry>/pnpm/<version>`
# (not the bare `<registry>/pnpm` packument), and that per-version endpoint on
# this mirror returns a *relative* `dist.tarball` path
# (`/pnpm/-/pnpm-<version>.tgz`) instead of an absolute URL — which fails
# corepack's own `tarball.startsWith("http")` check with "does not have a
# valid tarball", reproduced directly against this image's bundled corepack
# (`corepack --version` => 0.35.0) regardless of Accept header. Installing
# pnpm via plain `npm install -g` instead sidesteps corepack's resolution
# path entirely and hits the registry root, which this mirror does serve
# with absolute tarball URLs.
#
# The version is read out of root package.json's `packageManager` field at
# build time rather than hardcoded here — a hardcoded version would be a
# second source of truth that nothing keeps in sync with `packageManager`,
# so a future pnpm bump would silently leave this image on a stale pnpm
# until someone hit a confusing lockfile/engine mismatch. `docker build`'s
# context is the repo root (see `treespec.yaml`'s `projectDir: .`), so
# package.json is available to COPY in even though nothing else in this
# image needs the repository itself (that's tar'd in at container-run time
# by tests/treespec/spec.yaml's first step, not at build time).
COPY package.json /tmp/package.json
RUN PNPM_VERSION=$(node -e "process.stdout.write(require('/tmp/package.json').packageManager.match(/^pnpm@([0-9.]+)/)[1])") \
    && rm /tmp/package.json \
    && npm install -g "pnpm@${PNPM_VERSION}" --registry=https://repo.huaweicloud.com/repository/npm/ \
    && [ "$(pnpm --version)" = "$PNPM_VERSION" ]

# No ENTRYPOINT — treespec sets Cmd: ["sleep", "infinity"] itself
# and mounts projectDir at /app:ro
