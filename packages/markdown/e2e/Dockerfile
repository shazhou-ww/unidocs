FROM node:22-slim

RUN apt-get update && apt-get install -y curl jq && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY . /app
WORKDIR /app
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

WORKDIR /app/packages/markdown
COPY e2e/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
