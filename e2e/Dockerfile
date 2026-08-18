FROM node:22-slim

ENV CI=true

# System deps: curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# Pre-install dependencies to /opt/deps (cached layer, not affected by /app mount)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json /opt/deps/
COPY packages/markdown/package.json /opt/deps/packages/markdown/
WORKDIR /opt/deps
RUN pnpm install --frozen-lockfile

# Entrypoint copies source from /app (ro mount) to /workspace, symlinks deps, builds
COPY e2e/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
