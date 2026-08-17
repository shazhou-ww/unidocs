FROM node:22-slim

ENV CI=true

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy entire workspace (dist/ included, pre-built on host)
COPY . /app
WORKDIR /app

# Install deps — workspace links resolve correctly, dist/ already exists
RUN pnpm install --frozen-lockfile

# Entrypoint starts wrangler dev server in packages/markdown
COPY e2e/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
