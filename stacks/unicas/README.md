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

## Managed issuer

When the Worker has both managed-issuer bindings, every newly created stack
receives an active, UniCAS-managed issuer. The issuer URL is logically unique:

```text
https://<public-origin>/managed-issuers/<stackId>
```

The URL is server-derived and cannot be changed. Existing stacks that predate
managed issuers expose the same fixed URL in a disabled revision-zero state;
their first enable provisions the binding atomically.

The deployment uses one ES256 signing key across those logical issuers. Set
`MANAGED_ISSUER_KEY_ID` as a non-secret Wrangler var and
`MANAGED_ISSUER_PRIVATE_KEY_PKCS8` as a Wrangler secret. A local key can be
generated with `pnpm keys:local`; use the resulting `kid` and
`privateKeyPkcs8` fields without committing the generated file.

Only current stack members can mint managed capabilities through the admin
BFF. Each `(stack, OIDC issuer, subject)` maps to a stable isolated tenant.
Capabilities expire after 120 seconds and include read, write, and manage for
that tenant. The Playground keeps the bearer only in React state.

Managed issuer metadata and JWKS are public only while that issuer remains
active for the stack. A custom issuer has an independent lifecycle and can be
active at the same time. Protected-resource discovery lists the active custom
issuer first, so CLI login prefers it, then lists the managed issuer as the
fallback. Disabling managed issuance stops new managed capabilities
immediately, while already issued tokens age out according to their expiry and
verifier cache bounds.

Rotate the deployment signing key with overlap: deploy a JWKS/key-ring capable
revision before switching `MANAGED_ISSUER_KEY_ID`. The current implementation
holds one active managed key, so a no-downtime production rotation requires
adding key-ring support before changing the configured key.