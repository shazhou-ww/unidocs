FROM node:24-bookworm-slim

WORKDIR /workspace
# Corepack requires a per-version registry endpoint that our mirrors do not serve.
COPY package.json /tmp/package.json
RUN PNPM_VERSION=$(node -e "process.stdout.write(require('/tmp/package.json').packageManager.match(/^pnpm@([0-9.]+)/)[1])") \
	&& rm /tmp/package.json \
	&& npm install -g "pnpm@${PNPM_VERSION}" --registry=https://packagefeedproxy.microsoft.io/npm/ \
	&& [ "$(pnpm --version)" = "$PNPM_VERSION" ]
COPY . .
RUN pnpm install --frozen-lockfile --registry=https://packagefeedproxy.microsoft.io/npm/

ENV UNIDOCS_LOCAL_HOST=0.0.0.0
CMD ["node", "stacks/unidocs-cloudflare/local/dev.mjs"]
