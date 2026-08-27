FROM node:24-bookworm-slim

RUN corepack enable
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile

ENV UNIDOCS_LOCAL_HOST=0.0.0.0
CMD ["node", "stacks/unidocs-cloudflare/local/dev.mjs"]