# UniCAS stack

This stack owns the independently deployable CAS service. Implementation code
remains under `unicas-packages/`; this directory owns local orchestration and
Cloudflare deployment order.

```text
pnpm dev unicas
pnpm dev unicas --docker
pnpm run deploy unicas --dry-run
pnpm run deploy unicas
pnpm smoke unicas [baseUrl]
```

Deployment order is tenant, admin, then edge. The smoke entry exercises the
public edge and expects provisioned stack credentials under the gitignored
`.wrangler/cas-deploy/` directory.