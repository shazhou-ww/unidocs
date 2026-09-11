# Shared documentation stack

This stack publishes the public product documentation portal independently from application and service deployments. UniCAS lives under `/unicas`; UniDocs Admin documentation lives under `/unidocs`.

```text
pnpm dev docs
pnpm stack:deploy docs --dry-run
pnpm stack:deploy docs
pnpm smoke docs
```

Production entries: `https://docs.shazhou.work/unicas` and `https://docs.shazhou.work/unidocs`.

The stack has no Worker entrypoint and no D1, R2, KV, Durable Object, service, OAuth, or secret bindings. Cloudflare Workers Static Assets serves the `@unidocs/docs-webui` production build and falls back to `index.html` for product guides and API reference routes.

Deployment credentials are read from the process environment. When invoking deployment locally, inject `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from `cfg` only for the deployment process and clear them afterward. Never print or persist token values.
