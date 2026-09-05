# Unicas Tenant Debug Tools — Requirements

Status: requirements baseline v0.1 (design discussion session, 2026-08).

`unicas-tenant` is the tenant-facing debug tooling for the CAS data plane
(`/stacks/{stackId}/tenants/{tenantId}/cas/...`). It lets a tenant user query
and mutate CAS data — node content/metadata, leases, Root Refs, GC, usage — as
a low-level debugging and migration tool. CLI first; a WebUI sharing the same
session store follows later. It is deliberately **not** an end-user product.

## Positioning

- Audience: tenant users (not stack administrators; no control-plane access).
- Purpose: debug query/mutation of tenant data-plane state.
- Nature: low-level tool; safety rails (dry-run, confirm) matter more than UX.
- Form: `unicas-tenant` CLI now; WebUI later, sharing the same session store.

## Identity and login model

- The tool never holds issuer private keys and never embeds `client_id` /
  `client_secret`.
- Login unit is the **(stackId, tenantId) pair**; each entry is logged in and
  cached independently; several entries can coexist and the active one is
  switchable. `tenantId` is **not user input**: it is determined by the
  stack-side OAuth decision from the authenticated identity (see login flow).
- Login flow per entry:
  1. Resolve the stack's issuer (see below).
  2. RFC 8414 discovery at the issuer.
  3. RFC 7591 dynamic client registration — public client,
     `token_endpoint_auth_method=none`, PKCE, `response_type=code`.
  4. Browser authorization on the stack's own login page.
  5. Code exchange for a capability JWT (claims carry `tenantId` +
     `permissions`); the `tenantId` claim is authoritative — the provider
     derives it from the user's identity, never from a client-supplied
     parameter.
  6. Create/refresh the store entry keyed by `(stackId, claims.tenantId)`;
     cache the JWT under `~/.unicas` (0600), aligned with the admin-cli layout
     so the later WebUI can reuse the store.
- There is **no tenant selector parameter** in v1. A user's account maps to
  the tenant the stack's OAuth decides; accessing a different tenant of the
  same stack means logging in with a different account (logout first, then
  re-authorize).
- The stack's OIDC must accept **arbitrary dynamically registered clients**.
  The tenant WebUI/CLI is an ordinary client: no first-party whitelist, no
  pre-registered client credentials.

### Issuer resolution

The tool has no control-plane access, so the stack's issuer URL comes from a
new platform **public discovery endpoint**:

```text
GET /stacks/{stackId}/.well-known/openid-configuration
-> { issuer, audience }
```

Unauthenticated; served by the edge using the existing authority registry
(issuer → stackId mapping, ~30s cache). No tenant enumeration is provided: the
control plane has no tenant registry (tenants are implicit stack-app
partitions); the user supplies `tenantId` from their own application or admin.

## Capability and security

- **Lifetime**: discovered Stack OAuth issuers carry UniCAS's fixed server
  policy lifetime (30 minutes; `OAUTH_CAPABILITY_MAX_LIFETIME_SECONDS`) with
  the audience derived from the stack's canonical resource. The verifier
  enforces the authority's `capabilityMaxLifetimeSeconds` from the registry.
  The provider contract tells stack issuers that signing beyond the bound is
  rejected.
- **Refresh**: when the stack OIDC issues a refresh token, the tool caches it
  and auto-refreshes (automation-friendly). Refresh-token lifetime/rotation
  policy is part of the provider contract.
- **Permission posture**: full-permission login (`cas:read` + `cas:write` +
  `cas:manage` in one login). Consequence: a stolen long-lived `cas:manage`
  capability is administrator-equivalent. Accepted risk; mitigations are the
  per-stack lifetime cap, 0600 storage, and client-side safety rails
  (dry-run, `--confirm`). `sessions:*` permissions are app-layer and out of
  scope.

## Local session store and cache

Folder per (stack, tenant) under `~/.unicas`, aligned with the admin-cli layout
so the later WebUI reuses the same store:

```text
~/.unicas/
├── session.json                  # admin-cli session (cookie + CSRF)
└── tenants/
    ├── active.json               # global active entry {stackId, tenantId}
    └── <stackId encoded>/
        └── <tenantId encoded>/
            ├── session.json      # login state (0600)
            └── cas/              # node cache (0700), hash-prefix sharded
                ├── ab/           # first two hex chars of the hash
                │   ├── cdef…            # node content (binary)
                │   └── cdef….meta.json  # metadata sidecar: size/contentType/refs
                └── …
```

- **Per-entry `session.json`**: `{ stackId, tenantId, issuer, audience,
  clientId, token, expiresAt, refreshToken?, permissions[], subject,
  loggedInAt }`. Refresh tokens rotate in place with an atomic tmp+rename
  write. A failed refresh marks the entry `expired` (kept for inspection,
  never auto-cleared).
- **Cache semantics**: content-addressed, so the hash IS the content check —
  no staleness/invalidation problem. A cached node is trusted as-is; the only
  remote change is GC deleting the origin (the local copy is kept, which is
  what a debug tool wants). No eviction in v1; `cache status` / `cache clear`.
- **Cache policy — node granularity** (the disk cache implements
  `CasNodeCache` from `@unicas/tenant-client`): full node reads
  (`range === undefined`) populate the cache on miss; partial reads (`--range`)
  serve from a cached full copy or pass through without populating; metadata
  (incl. `refs`) is cached so subgraphs can be walked offline. `leaseNode`
  write-through is deferred.
- **Range contract**: the `CasNodeCache.read(key, range, load)` interface
  comment in tenant-client is updated to state that `range === undefined`
  means a full read (populate) and a present range means a partial read (serve
  or bypass); the policy lives in the cache implementation.
- **Blob layer**: `createCasBlobClient(cas, options)` is cache-agnostic and
  takes the tenant client as injected; its normal path reads child nodes in
  full, so blob reads populate the node cache automatically.
- **Permissions**: tenant directories 0700, `session.json` 0600; cached
  content may be sensitive and inherits the current user's permissions.

## Data-plane surface (CLI command draft)

| Group | Commands |
| --- | --- |
| Session | `login <stack> [--issuer URL]`, `logout <stack> <tenant>\|--all`, `list`, `status`, `use <stack> <tenant>` |
| Read | `node get <hash> [--range N[:L]] [--out file]`, `node meta <hash>`, `walk <hash> [--depth N]` |
| Admin | `usage`, `gc [--max-nodes N] [-y\|--yes]`, `root-refs update <refDomain> <hash> <delta> [-y\|--yes]`, `lease <hash> [--source file] [--duration-ms N]` |

Conventions aligned with the admin CLI: JSON on stdout, diagnostics on stderr,
exit codes 0/1/2, idempotency keys where applicable, CAS base URL from
`UNICAS_SERVER_URL`. Destructive operations (`gc`, `root-refs update`) confirm
interactively on a TTY, are skipped without a TTY, and `-y/--yes` skips the
prompt. No default dry-run for `gc`. `node get` never prints binary content to
stdout by default: it prints a JSON summary, `--out <file>` writes content,
`--out -` writes raw bytes.

## Platform deliverables and scope

- `unicas-tenant` CLI (new package under `unicas-packages/`, e.g.
  `@unicas/tenant-cli`).
- Public stack discovery endpoint on the edge (contract above).
- **Provider contract documentation**: discovery-document shape,
  authorize/token semantics, scopes, capability claims, error codes,
  refresh-token policy — see `docs/cas-tenant-oidc-provider-contract.md`.
  Stack applications implement their own OIDC provider; the platform ships the
  contract only (no reference provider in v1).

## Explicitly out of v1

- MCP server (revisit together with the WebUI).
- WebUI (but the store layout is designed for reuse).
- Tenant enumeration, `sessions:*` permissions, control-plane/admin operations.

## Open design questions

- Exact discovery endpoint contract (response shape, caching, error semantics,
  edge routing).
- CLI UX details (active-entry selection, flag/env precedence).
- Error taxonomy for login and data-plane failures.

## Decision log

| # | Decision | Date |
| --- | --- | --- |
| 1 | Tool is tenant-facing; never holds issuer keys; the stack provides the OAuth authorization URL and issues the tenant JWT | 2026-08 |
| 2 | JWT issuance must accept dynamically registered clients; no first-party tool clients | 2026-08 |
| 3 | Login unit is (stack, tenant) as peers | 2026-08 |
| 4 | CLI first, WebUI later (shared store) | 2026-08 |
| 5 | Issuer resolution via a public edge discovery endpoint | 2026-08 |
| 6 | Lifetime: default 8h, per-stack cap up to 7d, optional refresh token | 2026-08 |
| 7 | Full-permission login (`cas:manage` in one login) | 2026-08 |
| 8 | v1: no MCP | 2026-08 |
| 9 | Remove `cas_stack_issuer.status` — dead over-design (no write path existed; verifier `issuer_disabled` fail-closed was unreachable) | 2026-08 |
| 10 | Store: folder per (stack, tenant) — `session.json` + a per-tenant node cache (`cas/`, hash-prefix sharded, metadata sidecars) | 2026-08 |
| 11 | Cache at node granularity (`CasNodeCache`): full reads populate, partial reads serve-or-bypass, metadata cached for offline walk; blob layer benefits automatically; `leaseNode` write-through deferred | 2026-08 |
| 12 | No tenant selector parameter: `tenantId` is decided by the stack-side OAuth from the authenticated identity; multi-tenant access via separate accounts (logout → re-authorize) | 2026-08 |
| 13 | Destructive ops confirm interactively (TTY), refuse without TTY, `-y/--yes` skips; no default dry-run for `gc`; `node get` never prints binary by default | 2026-08 |
| 14 | Provider contract: scope vocabulary `cas:read`/`cas:write`/`cas:manage` (tool requests `cas:manage`, provider may downgrade); refresh token one-time rotation, ≤ 7d default; `jwks_uri` is the signing-key source | 2026-08 |
| 15 | Lifetime caps implemented: `MaximumCapabilityLifetimeSeconds` → 7d; per-stack `capabilityMaxLifetimeSeconds` (default 28800) in `issuer set`, webui, cli; CAS verifier enforces the per-stack cap from the registry | 2026-08 |
