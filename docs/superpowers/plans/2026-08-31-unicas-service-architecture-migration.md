# UniCAS Service Architecture Migration Plan

> **Status:** COMPLETE as of 2026-08-31.
>
> **Source of truth for current migration progress.** Update this document after
> each completed slice. Historical plans under this directory remain unchanged.
> Preserve unrelated PSD work and concurrent formatting-only edits when staging.

## Goal

Converge UniCAS on two server-side packages:

- `@unicas/service`: cloud-neutral tenant and admin business semantics behind
  explicit semantic platform ports.
- `@unicas/service-cloudflare`: the sole deployable Cloudflare Worker and owner
  of D1, R2, KV, Durable Object, schema, BFF/OIDC, MCP/OAuth, and HTTP/Worker
  lifecycle adapters.

Remove the transitional server packages after their behavior and test coverage
have moved:

- `@unicas/server-cloudflare` — removed.
- `@unicas/control-plane` — removed.
- `@unicas/control-plane-mcp` — removed.

The final client dependency directions are:

```text
[admin-cli, admin-webui] -> admin-client -> admin-protocol
[tenant-cli, tenant-webui] -> tenant-client -> tenant-protocol
                                  ^
                                  |
                         tenant-blob-client
```

UniCAS stays independently movable: production and test code under
`unicas-packages/` must not depend on `@unidocs/*` packages.

## Target server architecture

```text
Public HTTP
  |
  v
@unicas/service-cloudflare
  |-- Worker routing and credential stripping
  |-- D1 / R2 / KV adapters and schema migration
  |-- Durable Object wrappers and keyed single-writer dispatch
  |-- Admin BFF / OIDC and static assets (src/admin-bff)
  |-- MCP / OAuth ingress (src/mcp)
  |
  v
@unicas/service
  |-- tenant capability authorization
  |-- Root Ref semantics
  |-- node lease / read / usage / GC semantics
  |-- admin stack / member / invitation semantics
  `-- issuer / key / possession / audit semantics
```

Cloud-neutral service code must not contain SQL, D1/R2/Worker types, HTTP
response construction, or Durable Object lifecycle code. Cloudflare adapters
must not make business-policy decisions that belong in service kernels.

## Progress summary

### Phase 1 — Tenant service extraction: complete

- [x] Move stack capability verification and permission mapping into
  `@unicas/service`.
- [x] Move Root Ref parsing, canonicalization, idempotency, projection,
  revision planning, and retry semantics into `@unicas/service`.
- [x] Move node GC policy into `@unicas/service`.
- [x] Move tenant node usage aggregation into `@unicas/service`.
- [x] Move node content range/read and metadata shaping into `@unicas/service`.
- [x] Move bodyless lease, orphan adoption, and streaming lease semantics into
  `@unicas/service`.
- [x] Preserve direct request-body streaming to object storage and canonical
  prefix inspection after upload.

Relevant commits:

- `65ca058` — node GC extraction
- `c0fbd4a` — node usage extraction
- `f11fc3a` — node read extraction
- `317be67` — bodyless lease extraction
- `4ea4468` — streaming lease extraction

### Phase 2 — Cloudflare tenant package consolidation: complete

- [x] Move tenant node D1/R2 repositories into `@unicas/service-cloudflare`.
- [x] Move tenant and Root Ref domain Durable Objects into
  `@unicas/service-cloudflare`.
- [x] Move tenant schema and audit-reader RPC into
  `@unicas/service-cloudflare`.
- [x] Migrate authorization, DO dispatch, storage, audit, and schema tests.
- [x] Point application-stack Cloudflare service bindings at the unified
  `unidocs-cas` Worker.
- [x] Delete `@unicas/server-cloudflare` and remove package graph, lockfile,
  script, deployment, and documentation references.

Relevant commits:

- `e1cf2ac` — tenant node adapters moved
- `ec91f14` — tenant DOs, Root Ref adapters, schema, and audit reader moved
- `e3256d7` — tenant authorization/dispatch coverage preserved
- `b8a950b` — retired tenant Cloudflare package removed

### Phase 3 — Control-plane boundary preparation: complete

- [x] Move the D1 authority resolver adapter into
  `@unicas/service-cloudflare`.
- [x] Move pure audit, cursor, error, ID, JWKS, possession, and validation
  helpers into `@unicas/service`.
- [x] Define cloud-neutral `ControlPlaneOperations` and
  `ControlSessionRepository` contracts in `@unicas/service`.
- [x] Change the admin BFF to consume injected control/session ports.
- [x] Make `@unicas/service-cloudflare` the admin composition root.
- [x] Move control schema and D1 session storage into
  `@unicas/service-cloudflare`.
- [x] Make the host Worker own schema migration before admin and MCP dispatch.
- [x] Change MCP tool construction to consume injected
  `ControlPlaneOperations` rather than constructing a D1 service internally.

Relevant commits:

- `6f8e08b` — authority adapter moved
- `f6f34ef` — pure control helpers moved
- `e8bd45d` — control/session ports injected into admin BFF
- `36dbc65` — control schema and session adapters moved

### Phase 4 — Admin business-kernel extraction: complete

- [x] Move `me`, `listStacks`, `createStack`, `getStack`, `patchStack`, and
  `recordSessionAudit` into cloud-neutral `ControlPlaneAdminService`.
- [x] Add a semantic D1 repository for identity, stack, idempotency, snapshot,
  and audit persistence.
- [x] Move `listMembers`, `deleteMember`, `createMemberInvitation`, and
  `acceptMemberInvitation` into `ControlPlaneAdminService`.
- [x] Keep invitation creation, audit, snapshot, and idempotency atomic.
- [x] Enforce last-member and stack-revision protection in the adapter commit.
- [x] Atomically claim valid pending invitations exactly once and synchronize
  accepted-member display metadata.
- [x] Preserve admin BFF, CLI, and MCP operation signatures through
  `ControlPlaneOperations`.
- [x] Move `getIssuer` and `putIssuer` policy into `ControlPlaneAdminService`
  with a semantic issuer repository and atomic commit plans.
- [x] Move `createPossessionChallenge`, `listIssuerKeys`, `createIssuerKey`,
  and `deleteIssuerKey` policy into `ControlPlaneAdminService`, keeping
  possession proof construction/verification, algorithm/JWK policy, key state
  transitions, active-key safety, ETag behavior, expiry, and audit selection
  cloud-neutral; one-time challenge consumption is atomic in the adapter.
- [x] Move `listControlAuditEvents` cursor, authorization, limit, snapshot,
  and response-shaping semantics into `ControlPlaneAdminService`; D1 query
  syntax and row mapping stay in the Cloudflare repository.
- [x] `createControlPlaneOperations()` binds every operation to the extracted
  service; no operation remains on the legacy composition path.

Relevant commits:

- `e3452a5` — stack administration moved into service
- `3d5cfc3` — membership and invitation administration moved into service
- (working tree) — issuer configuration moved into service
- (working tree) — issuer keys and possession challenges moved into service
- (working tree) — control audit listing moved into service

### Phase 5 — Transitional package removal: complete

- [x] Remove the legacy `ControlPlaneService` composition path.
- [x] Remove duplicated authority and compatibility facade modules.
- [x] Update `service-cloudflare`, MCP, scripts, aliases, package references,
  lockfile, root TypeScript references, boundary tests, and current docs.
- [x] Delete `unicas-packages/control-plane`.
- [x] Confirm no live source imports `@unicas/control-plane`.
- [x] Move the Cloudflare MCP/OAuth Worker ingress into
  `@unicas/service-cloudflare` (`src/mcp`).
- [x] Keep generic MCP tool presentation separate from control business
  semantics and inject `ControlPlaneOperations`.
- [x] Preserve OAuth discovery, PKCE, consent, scope, token, origin, and audit
  behavior.
- [x] Migrate tests, then delete `@unicas/control-plane-mcp`.
- [x] Move remaining Cloudflare-facing OIDC/session/BFF server composition into
  `@unicas/service-cloudflare` (`src/admin-bff`).
- [x] Keep `@unicas/admin-webui` as browser UI only.
- [x] Restore the final client direction
  `admin-webui -> admin-client -> admin-protocol`.
- [x] Update package boundaries, build flow, asset generation, and tests.

### Phase 6 — Documentation and deployment closeout: complete

- [x] Update the active architecture and operations documents to the final
  two-package server boundary.
- [x] Keep dated historical plans/specifications unchanged except for explicit
  completion annotations where useful.
- [x] Verify local and production Wrangler bindings retain existing Durable
  Object class names, D1/R2/KV bindings, routes, and migration compatibility.
- [x] Verify provisioning scripts import schema from the final adapter package.

## Validation gates

Run focused validation after each extraction slice:

```text
pnpm --filter @unicas/service typecheck
pnpm --filter @unicas/service test
pnpm --filter @unicas/service-cloudflare typecheck
pnpm --filter @unicas/service-cloudflare test
pnpm --filter @unicas/admin-webui typecheck
pnpm --filter @unicas/admin-webui test
node scripts/analyze-deps.mjs
git diff --check
```

Before deleting a transitional package or completing a milestone, also run:

```text
pnpm typecheck
pnpm test
pnpm build
```

Package/deployment guards that must remain green include:

```text
tests/unit/workspace/package-deps.test.mjs
tests/unit/scripts/doc-types.test.mjs
tests/unit/scripts/stack-deploy.test.mjs
tests/unit/scripts/azure-stack-env.test.mjs
tests/unit/scripts/cas-possession-sign.test.mjs
tests/unit/scripts/workspace-aliases.test.mjs
```

Final verified migration results:

- issuer/key/audit extraction: full workspace typecheck and build passed;
  `@unicas/service` 78 tests and `@unicas/service-cloudflare` 121 tests passed;
  workspace/deployment guards: 240 tests passed.
- transitional package removal: `pnpm typecheck`, `pnpm build` passed; no live
  source imports of `@unicas/control-plane`, `@unicas/control-plane-mcp`, or
  `@unicas/admin-webui` remain outside docs/boundary assertions.
- BFF/MCP consolidation: `@unicas/service-cloudflare` 121 tests passed
  (migrated BFF, session, MCP, OAuth, and routing coverage included);
  `@unicas/admin-webui` 22 tests passed; editor diagnostics and dependency
  analysis showed no migration-related errors.

## Invariants and migration rules

- Preserve Durable Object class names, actor keys, D1 table names, R2 object
  keys, public routes, headers, response bodies, status codes, and error codes.
- Preserve keyed single-writer semantics for tenant and Root Ref mutations.
- Keep streaming lease bodies streaming; do not materialize canonical node
  uploads in service code.
- Service repository ports describe business reads and atomic commit plans, not
  SQL statements or generic D1 wrappers.
- Cloudflare repositories own SQL, row mapping, uniqueness detection, and
  transaction mechanics, but not validation or policy.
- Do not create reverse dependencies from `service`, presentation packages, or
  MCP into `service-cloudflare`.
- Keep tenant capabilities, admin browser sessions, and MCP OAuth grants as
  separate trust domains.
- Do not weaken tests during moves. Migrate unique coverage before deleting the
  old implementation.
- Stage only files for the active slice. At this checkpoint, unrelated PSD test
  edits and formatting-only changes in node adapters may exist in the worktree
  and must not be included accidentally.

## Current repository checkpoint

At the time of this update:

- branch: `main`;
- `@unicas/server-cloudflare`, `@unicas/control-plane`, and
  `@unicas/control-plane-mcp` are absent;
- `@unicas/service-cloudflare` is the single deployable Worker hosting the
  admin BFF (`src/admin-bff`) and the MCP/OAuth ingress (`src/mcp`) over
  `ControlPlaneOperations` and `ControlPlaneAdminService` from
  `@unicas/service`;
- `@unicas/admin-webui` is browser UI only and consumes admin types through
  `@unicas/admin-client`;
- unrelated working-tree edits remain intentionally unstaged.
