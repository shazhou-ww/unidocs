FROM node:24-slim

ENV CI=true

# System deps: curl for HTTP testing
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# No ENTRYPOINT — treespec sets Cmd: ["sleep", "infinity"] itself
# and mounts projectDir at /app:ro
