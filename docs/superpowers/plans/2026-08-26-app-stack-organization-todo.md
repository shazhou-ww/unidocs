# UniDocs Application Stack — Organization & Deployment TODO

**Created:** 2026-08-26 — items handed off from the CAS middleware plan
(`docs/superpowers/plans/2026-08-26-cas-middleware.md`) plus the
application-stack organization work itself. The CAS middleware plan now
covers only the independently deployable CAS service; **how the full
UniDocs application stack is organized and deployed is this plan**.

## Handed-off context (already done, do not redo)

- The four application-stack `wrangler.toml` files
  (`packages/cloudflare-{gateway,markdown,docx,psd}`) are already rewritten
  to stack mode with real production values (stack issuer/kid/audience,
  `CAS_SERVICE` → `unidocs-cas-server-cloudflare`, `[exports.*]` DO
  declarations) and parse cleanly via `wrangler deploy --dry-run`. They are
  the deployable starting point.
- Application-stack packages stay `@unidocs/*` in `packages/`; they import
  the CAS middleware packages as `@unicas/*` from `unicas-packages/` — a
  future CAS monorepo extraction only swaps `workspace:*` for registry
  versions.
- The deployed middleware (edge/tenant/admin) is independent of the
  application stacks; its rollback drill succeeded live on 2026-08-26.

## TODO

### 1. Gateway production identity/auth (BLOCKER for any app-stack deploy)

- [ ] Replace `createInsecureTenantIdentityResolver` with a production
      identity/auth mechanism (the deployed gateway must authenticate and
      authorize end users; today it 401s everything meaningful).
- [ ] Wire the capability authority to verify doc-service identity JWTs in
      production (`CAPABILITY_ISSUER` / `CAPABILITY_TRUSTED_JWKS` on the
      gateway).
- [ ] Decide the end-user identity story per deployment (Cloudflare +
      Azure) and document it in the deployment runbook.

### 2. Application-stack production deployment

- [ ] Deploy doc workers first (markdown → docx → psd), gateway last.
- [ ] Set secrets before each deploy (`wrangler secret put`):
      doc workers: `CAPABILITY_ISSUER`, `CAPABILITY_TRUSTED_JWKS`,
      `CAS_STACK_TRUSTED_JWKS`, `SERVICE_ACCESS_KEY` (legacy fallback);
      gateway: `CAS_STACK_PRIVATE_KEY_PKCS8`, `DOC_SERVICES_JSON`.
- [ ] Rotate the provisional bootstrap stack keys (in
      `.wrangler/cas-deploy/`, gitignored) via the possession-proof console.
- [ ] Run the live CAS smoke against the deployed stack.

### 3. Independent deploy/rollback drills

- [ ] Prove each application stack deploys, rolls back, and operates without
      redeploying CAS (wrangler deployments list → rollback → restore, as
      done for the middleware on 2026-08-26).
- [ ] Prove CAS deploys compatibly without redeploying either stack.

### 4. Application-stack package organization

- [ ] Decide the final application-stack package layout under `packages/`
      (Cloudflare + Azure gateways/doc services, shared doctype/server
      kernels, SDKs).
- [ ] Document the boundary vs `unicas-packages/` (the CAS middleware
      monorepo) and the extraction path (workspace:* → registry).

### 5. Handed-off acceptance items (from the CAS middleware plan)

- [ ] Application-stack deploy/rollback drills (item 3 above) — was Task 9
      bullet 12; removed from the CAS plan on 2026-08-26.
- [ ] Any application-stack-specific operational gates that the CAS
      middleware plan's ops round does not cover.
