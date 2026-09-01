# UniCAS stack

This stack owns the independently deployable CAS service. Implementation code
remains under `unicas-packages/`; this directory owns local orchestration and
Cloudflare deployment order.

```text
pnpm dev unicas
pnpm dev unicas --docker
pnpm stack:deploy unicas --dry-run
pnpm stack:deploy unicas
pnpm smoke unicas [baseUrl]
```

Production deploys one `@unicas/service-cloudflare` Worker containing the
tenant and admin HTTP service, admin BFF/UI, MCP ingress, and public routing.
The smoke entry exercises that public Worker and expects provisioned stack
credentials under the gitignored `.wrangler/cas-deploy/` directory.