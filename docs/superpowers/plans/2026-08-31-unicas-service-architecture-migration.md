# UniCAS Service Architecture Migration Plan

> **Status:** IN PROGRESS as of 2026-08-31.
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
- `@unicas/control-plane` — partially migrated; removal pending.
- `@unicas/control-plane-mcp` — ingress migration pending.

The final client dependency directions remain:

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
  |-- Admin BFF / OIDC and static assets
  |-- MCP / OAuth ingress
  |
  v
@unicas/service
  |-- tenant capability authorization
  |-- Root Ref semantics
  |-- node lease / read / usage / GC semantics
  |-- admin stack / member / invitation semantics
  `-- remaining issuer / key / audit semantics (pending)
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

### Phase 4 — Admin business-kernel extraction: in progress

Completed:

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

Relevant commits:

- `e3452a5` — stack administration moved into service
- `3d5cfc3` — membership and invitation administration moved into service

Remaining legacy methods in `@unicas/control-plane`:

- `getIssuer`
- `putIssuer`
- `createPossessionChallenge`
- `listIssuerKeys`
- `createIssuerKey`
- `deleteIssuerKey`
- `listControlAuditEvents`

## Current task sequence

### Task 1 — Extract issuer configuration

- [ ] Add cloud-neutral issuer records, plans, results, and semantic repository
  methods to the control admin service boundary.
- [ ] Move `getIssuer` and `putIssuer` policy into `@unicas/service`.
- [ ] Keep membership authorization, issuer/audience validation, global issuer
  uniqueness, capability lifetime policy, ETag checks, revisions, and audit
  action selection in the service kernel.
- [ ] Implement D1 reads and atomic issuer mutation in
  `@unicas/service-cloudflare`.
- [ ] Bind these operations to the extracted service in
  `createControlPlaneOperations()`.
- [ ] Add pure service tests and D1 integration/MCP tests.

### Task 2 — Extract issuer keys and possession challenges

- [ ] Move `createPossessionChallenge`, `listIssuerKeys`, `createIssuerKey`, and
  `deleteIssuerKey` policy into `@unicas/service`.
- [ ] Keep possession proof construction/verification, algorithm/JWK policy,
  key state transitions, active-key safety, ETag behavior, expiry, and audit
  selection cloud-neutral.
- [ ] Add semantic repository plans for challenge creation/consumption and
  atomic key creation/transition.
- [ ] Implement D1 storage in `@unicas/service-cloudflare`.
- [ ] Preserve exact wire error codes and MCP security-scope behavior.

### Task 3 — Extract control audit listing

- [ ] Move `listControlAuditEvents` cursor, authorization, limit, snapshot, and
  response-shaping semantics into `@unicas/service`.
- [ ] Keep D1 query syntax and row mapping in `@unicas/service-cloudflare`.
- [ ] Cover filtered paging, cursor binding, MCP attribution, and empty pages.

### Task 4 — Delete `@unicas/control-plane`

Prerequisite: all seven remaining methods above are served by
`ControlPlaneAdminService` and its Cloudflare repository.

- [ ] Remove the legacy `ControlPlaneService` composition path.
- [ ] Remove duplicated authority and compatibility facade modules.
- [ ] Update `service-cloudflare`, MCP, scripts, aliases, package references,
  lockfile, root TypeScript references, boundary tests, and current docs.
- [ ] Delete `unicas-packages/control-plane`.
- [ ] Confirm no live source imports `@unicas/control-plane`.

### Task 5 — Consolidate MCP/OAuth ingress

- [ ] Move Cloudflare MCP/OAuth Worker ingress into
  `@unicas/service-cloudflare`.
- [ ] Keep generic MCP tool presentation separate from control business
  semantics and inject `ControlPlaneOperations`.
- [ ] Preserve OAuth discovery, PKCE, consent, scope, token, origin, and audit
  behavior.
- [ ] Migrate tests, then delete `@unicas/control-plane-mcp`.

### Task 6 — Finish admin BFF consolidation

- [ ] Move remaining Cloudflare-facing OIDC/session/BFF server composition into
  `@unicas/service-cloudflare`.
- [ ] Keep `@unicas/admin-webui` as browser UI only.
- [ ] Restore the final client direction
  `admin-webui -> admin-client -> admin-protocol`.
- [ ] Update package boundaries, build flow, asset generation, and tests.

### Task 7 — Documentation and deployment closeout

- [ ] Update the active architecture and operations documents to the final
  two-package server boundary.
- [ ] Keep dated historical plans/specifications unchanged except for explicit
  completion annotations where useful.
- [ ] Verify local and production Wrangler bindings retain existing Durable
  Object class names, D1/R2/KV bindings, routes, and migration compatibility.
- [ ] Verify provisioning scripts import schema from the final adapter package.

## Validation gates

Run focused validation after each extraction slice:

```text
pnpm --filter @unicas/service typecheck
pnpm --filter @unicas/service test
pnpm --filter @unicas/service-cloudflare typecheck
pnpm --filter @unicas/service-cloudflare test
pnpm --filter @unicas/control-plane typecheck
pnpm --filter @unicas/control-plane test
pnpm --filter @unicas/control-plane-mcp typecheck
pnpm --filter @unicas/control-plane-mcp test
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
```

Most recent verified migration results before this plan update:

- tenant package consolidation: full workspace typecheck and test passed;
- workspace/deployment guards: 215 tests passed;
- control/session dependency inversion: 38 test files, 233 tests passed;
- member/invitation extraction validation: 40 test files, 218 tests passed;
- editor diagnostics and dependency analysis: no migration-related errors.

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

- branch: `main`, 13 commits ahead of `origin/main`;
- latest migration commit: `3d5cfc3` (`move membership administration into service`);
- `@unicas/server-cloudflare` is absent;
- `@unicas/control-plane` remains only for issuer/key/possession/audit-list
  behavior and temporary composition;
- unrelated working-tree edits remain intentionally unstaged.
