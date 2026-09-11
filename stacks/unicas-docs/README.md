# UniCAS documentation stack

This stack publishes the public, static UniCAS documentation site independently from the UniCAS service and Admin Portal.

```text
pnpm dev unicas-docs
pnpm stack:deploy unicas-docs --dry-run
pnpm stack:deploy unicas-docs
pnpm smoke unicas-docs
```

Production hostname: `https://unicas-docs.shazhou.work`.

The stack has no Worker entrypoint and no D1, R2, KV, Durable Object, service, OAuth, or secret bindings. Cloudflare Workers Static Assets serves the `@unicas/docs-webui` production build and falls back to `index.html` for guide and API reference routes.

Deployment credentials are read from the process environment. When invoking deployment locally, inject `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from `cfg` only for the deployment process and clear them afterward. Never print or persist token values.
