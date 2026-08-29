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
  switchable.
- Login flow per entry:
  1. Resolve the stack's issuer (see below).
  2. RFC 8414 discovery at the issuer.
  3. RFC 7591 dynamic client registration — public client,
     `token_endpoint_auth_method=none`, PKCE, `response_type=code`.
  4. Browser authorization on the stack's own login page.
  5. Code exchange for a capability JWT (claims carry `tenantId` +
     `permissions`).
  6. Cache the JWT under `~/.unicas` (0600), aligned with the admin-cli layout
     so the later WebUI can reuse the store.
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

- **Lifetime**: default **8 hours**; per-stack configurable cap up to **7
  days** via the control-plane issuer configuration. The verifier cap
  (`MaximumCapabilityLifetimeSeconds`, currently 1800s) is raised to the 7-day
  hard maximum; the per-stack cap is enforced by the CAS verifier from the
  authority registry. The provider contract tells stack issuers that signing
  beyond the configured cap is rejected.
- **Refresh**: when the stack OIDC issues a refresh token, the tool caches it
  and auto-refreshes (automation-friendly). Refresh-token lifetime/rotation
  policy is part of the provider contract.
- **Permission posture**: full-permission login (`cas:read` + `cas:write` +
  `cas:manage` in one login). Consequence: a stolen long-lived `cas:manage`
  capability is administrator-equivalent. Accepted risk; mitigations are the
  per-stack lifetime cap, 0600 storage, and client-side safety rails
  (dry-run, `--confirm`). `sessions:*` permissions are app-layer and out of
  scope.

## Data-plane surface (CLI command draft)

| Group | Commands |
| --- | --- |
| Session | `login <stack> <tenant>`, `logout <stack> <tenant>\|--all`, `list`, `status`, `use <stack> <tenant>` |
| Read | `node get <hash> [--range N[:L]] [--out file]`, `node meta <hash>`, `walk <hash> [--depth N]` |
| Admin | `usage`, `gc [--dry-run] [--max-nodes N] [--confirm]`, `root-refs update <refDomain> <hash> <delta> [--confirm]`, `lease <hash> [--source file] [--duration-ms N]` |

Conventions aligned with the admin CLI: JSON on stdout, diagnostics on stderr,
exit codes 0/1/2, idempotency keys where applicable, explicit `--confirm` for
destructive operations, CAS base URL from `UNICAS_SERVER_URL`.

## Platform deliverables and scope

- `unicas-tenant` CLI (new package under `unicas-packages/`, e.g.
  `@unicas/tenant-cli`).
- Public stack discovery endpoint on the edge (contract above).
- **Provider contract documentation**: discovery-document shape,
  authorize/token semantics, scopes, capability claims, error codes,
  refresh-token policy. Stack applications implement their own OIDC provider;
  the platform ships the contract only (no reference provider in v1).

## Explicitly out of v1

- MCP server (revisit together with the WebUI).
- WebUI (but the store layout is designed for reuse).
- Tenant enumeration, `sessions:*` permissions, control-plane/admin operations.

## Open design questions

- Exact discovery endpoint contract (response shape, caching, error semantics,
  edge routing).
- Session store layout (entries, keys, refresh-token handling).
- CLI UX details (active-entry selection, flag/env precedence).
- Verifier / issuer / control-plane changes for the lifetime caps.
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
