FROM node:22-slim

ENV CI=true

# System deps: curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# No ENTRYPOINT — treespec sets Cmd: ["sleep", "infinity"] itself
# and mounts projectDir at /app:ro
