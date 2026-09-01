# Stack OAuth Standardization Implementation Plan

> **Status:** PROPOSED — 2026-09-01
>
> Implement this as an expand → migrate → contract rollout. Do not reinterpret or
> remove the current issuer/key API in the first release. Keep the current
> capability JWT claim and permission contract stable while changing how an
> issuer is discovered, proven, and how its keys are obtained.

## Goal

Replace UniCAS's manually asserted `issuer` plus manually uploaded public keys
with a standards-based Stack OAuth trust relationship:

1. Stack administrators register a canonical OAuth authorization-server
   `issuer`; UniCAS performs discovery, proves that the registrant controls a
   key advertised by that issuer, and automatically refreshes its JWKS.
2. UniDocs Cloudflare and Azure Gateways act as Stack OAuth authorization
   servers. They publish standard metadata/JWKS and issue the existing UniCAS
   capability JWT as the OAuth access token after user authorization.
3. Stack tenant applications discover the authorization server through
   standard protected-resource metadata and complete Authorization Code + PKCE.
4. The old manual issuer/key lifecycle is deprecated, observed through a
   compatibility window, and then removed.

## Non-goals

- UniCAS does not become the user identity provider or the Stack OAuth
  authorization server.
- UniCAS does not accept a `jwks_uri`, `jku`, or public key supplied by a tenant
  token.
- This migration does not change the durable `stackId` or `tenantId` namespace.
- This migration does not replace the internal short-lived capabilities used
  between Gateway and document services.
- OAuth scopes do not replace the canonical UniCAS permission claims in this
  rollout; the Gateway maps scopes to those claims.

## Current state

- A Stack is created without an issuer. An administrator later stores an
  arbitrary HTTPS `issuer`, an `audience`, and public keys in control D1.
- UniCAS verifies tenant capabilities against the D1 authority snapshot. It
  does not perform OAuth/OIDC discovery or remote JWKS refresh.
- Cloudflare and Azure Gateways already mint compatible capability JWTs through
  `GatewayCapabilityAuthority`, but neither Gateway implements user OAuth.
- Both Gateways still use the development-only path identity resolver; there is
  no production user-to-tenant membership authority.
- The tenant OAuth provider and debug-tool behavior is documented as a draft,
  but its public discovery route and tenant CLI are not implemented.
- The existing `/mcp` OAuth server is control-plane OAuth only. Its Cloudflare
  provider implementation is a useful behavioral reference, not a portable
  implementation for both Gateways.

## Fixed architecture

### Roles

```text
Stack administrator
  registers and proves control of a Stack OAuth issuer

Stack OAuth authorization server (initially each UniDocs Gateway)
  authenticates users, applies tenant membership/policy, obtains consent,
  and issues capability JWT access tokens

UniCAS
  OAuth protected resource and capability-token verifier

Stack tenant application
  OAuth public client using Authorization Code + PKCE
```

### Discovery chain

A tenant client starts from the UniCAS Stack resource, not from a private
UniCAS control-plane API:

```text
UniCAS protected-resource metadata
  -> authorization_servers: [canonical issuer]
  -> issuer OAuth/OIDC metadata
  -> authorization_endpoint, token_endpoint, jwks_uri, registration_endpoint
```

For resource `https://cas.example/stacks/{stackId}`, publish RFC 9728 protected
resource metadata at the path-bearing well-known location:

```text
https://cas.example/.well-known/oauth-protected-resource/stacks/{stackId}
```

The response contains at least:

```json
{
  "resource": "https://cas.example/stacks/{stackId}",
  "authorization_servers": ["https://gateway.example/oauth"],
  "scopes_supported": ["cas:read", "cas:write", "cas:manage"]
}
```

For authorization-server discovery, support both standard derivations for a
path-bearing issuer:

```text
OIDC:     {issuer}/.well-known/openid-configuration
RFC 8414: {origin}/.well-known/oauth-authorization-server/{issuer-path}
```

The selected metadata document must return an `issuer` exactly equal to the
registered canonical issuer. Query strings and fragments are forbidden on the
issuer. Trailing-slash handling is canonicalized once at registration and is
not normalized during token comparison.

Retain `/stacks/{stackId}/.well-known/openid-configuration` only as a temporary
compatibility pointer if an unreleased tenant tool already depends on it. It is
not the canonical protected-resource discovery endpoint.

### Registration and control proof

The new registration request accepts only:

- canonical `issuer`;
- expected `audience`/resource identifier;
- capability maximum lifetime;
- optional explicit metadata URL for documented non-standard providers.

It does not accept `jwks_uri` or JWK material.

Registration has two steps:

1. **Inspect:** UniCAS fetches metadata and JWKS through a platform discovery
   port, validates compatibility, and returns a short-lived challenge bound to
   `stackId`, canonical issuer, audience, metadata digest, nonce, and expiry.
2. **Confirm:** the Stack operator signs the challenge with a private key whose
   public JWK is currently advertised by the discovered `jwks_uri`. UniCAS
   verifies that proof against the fetched JWKS and atomically activates the
   issuer binding.

This prevents a Stack administrator from claiming somebody else's public
issuer merely because its metadata is readable. Provider-specific management
OAuth can be added later as an alternative proof method, but cannot weaken the
challenge binding.

All outbound discovery is SSRF-hardened: HTTPS only; no URL credentials;
restricted ports; DNS resolution checked against loopback, link-local, private,
and cloud metadata ranges; bounded redirects with same-authority policy;
bounded response size and time; JSON content validation; and no caller-chosen
URL after registration.

### JWKS lifecycle

- `jwks_uri` is always taken from the verified metadata document.
- UniCAS maintains a persisted discovered-key snapshot so tenant request
  verification remains independent of a live third-party network call.
- Refresh occurs on a schedule, on an administrator's explicit refresh, and
  once on an unknown `kid` with per-issuer single-flight/rate limiting.
- Refresh validates key type, algorithm, `kid` uniqueness, and absence of
  private JWK members before atomically replacing the accepted snapshot.
- Keys removed from a successfully refreshed JWKS stop validating immediately.
  Issuers must publish old and new keys concurrently for zero-downtime rotation.
- A temporary network failure may use the last-known-good snapshot only for a
  bounded hard-stale interval. Beyond it, verification fails closed with
  `registry_unavailable`; it never silently falls back to manual keys.
- Metadata changes to `issuer` are rejected. Changes to endpoints/JWKS URI are
  recorded and require the same-origin policy or administrator re-verification.

### OAuth behavior supplied by each Gateway

Each Gateway publishes:

- OAuth authorization-server metadata (RFC 8414); OIDC discovery as an optional
  compatibility alias if it also behaves as an OIDC issuer;
- `authorization_endpoint`;
- `token_endpoint`;
- `jwks_uri`;
- dynamic client registration (RFC 7591) for public tooling clients, unless a
  later client-metadata policy replaces it;
- Authorization Code only, mandatory PKCE S256, no implicit grant;
- rotating refresh tokens and revocation if refresh is enabled.

The OAuth access token is the existing `unidocs-cap+jwt` capability. The
Gateway maps granted OAuth scopes to canonical claims:

```text
cas:read   -> tenants:{tenantId}:cas:read
cas:write  -> tenants:{tenantId}:cas:write
cas:manage -> tenants:{tenantId}:cas:manage
```

The Gateway, not the client, derives `tenantId`, permissions, and `refDomain`
from authenticated identity and server-side membership/policy. If a user may
access multiple tenants, the Gateway consent UI may let the user choose only
from server-authorized memberships; a raw client-supplied tenant identifier is
never authoritative.

Browser, desktop, and CLI clients are public clients. Secrets are not returned
from discovery or dynamic registration. Redirect URIs are exact-match, except
for the RFC 8252 loopback-port rule. Consent is bound to client, user, tenant,
scopes, redirect URI, code challenge, and expiry.

### Portable Gateway design

Create a portable Stack OAuth authorization-server core shared by Azure and
Cloudflare rather than implementing two protocol engines. Keep it outside
`unicas-packages` so UniCAS remains independently movable and never depends on
`@unidocs/*`.

Suggested boundary:

```text
@unidocs/gateway-oauth
  protocol validation, authorization transaction state machine,
  PKCE, consent/grant policy, capability access-token issuance,
  refresh/revocation semantics, metadata/JWKS rendering

Cloudflare adapter
  D1/KV persistence, Worker routing, scheduled cleanup

Azure adapter
  PostgreSQL persistence, Node routing, scheduled cleanup
```

The core takes explicit ports for user authentication, tenant membership,
client/grant storage, signing-key access, clock, randomness, and audit. The
existing insecure path resolver remains local-development-only and cannot
satisfy an OAuth authorization request outside local mode.

## API and data model expansion

### New control-plane resource

Add a parallel `/admin/stacks/{stackId}/oauth-issuer` resource rather than
changing the meaning of the frozen `/issuer` API in place.

Proposed operations:

```text
GET  /admin/stacks/{stackId}/oauth-issuer
POST /admin/stacks/{stackId}/oauth-issuer/inspections
PUT  /admin/stacks/{stackId}/oauth-issuer              confirm proof / activate
POST /admin/stacks/{stackId}/oauth-issuer/refreshes
```

Representative state:

```text
stackId
issuer
audience
metadataUrl
metadataType                 oauth | oidc
authorizationEndpoint
tokenEndpoint
jwksUri
registrationEndpoint
scopesSupported
codeChallengeMethodsSupported
status                       pending | active | stale | incompatible | disabled
verifiedAt
lastRefreshAt
lastRefreshError
jwksDigest
capabilityMaxLifetimeSeconds
revision
```

Inspection challenges are short-lived, one-time, hashed at rest, and bound to
an immutable inspection result. Confirmation and refresh are audited.

Use a new `cas_stack_oauth_issuers` table plus inspection and discovered-key
snapshot tables. Do not overload legacy key lifecycle states: `active`,
`retiring`, and `revoked` describe administrator-managed keys, while discovered
JWKS is a replaceable provider snapshot.

During compatibility, authority lookup prefers an active OAuth issuer binding;
otherwise it reads the legacy manual binding. A Stack cannot have both modes
active simultaneously.

### Admin surfaces

- **Admin protocol/client:** add typed inspection, activation, status, and
  refresh operations with ETags and stable errors.
- **Admin WebUI:** replace the primary issuer page with a connection wizard:
  issuer/audience → inspect compatibility → display discovered endpoints and
  keys → show challenge signing instructions → activate → health/last refresh.
  Keep legacy management read-only behind a “Legacy issuer” warning during the
  compatibility period. Edit the source UI and regenerate embedded assets;
  never hand-edit the generated asset module.
- **Admin CLI:** add `unicas oauth-issuer inspect|activate|get|refresh`. Accept a
  compact proof generated outside the CLI; never accept private JWK material.
  Existing `issuer set` and `keys challenge|add|transition` print deprecation
  warnings and successor commands.
- **MCP:** add `inspect_oauth_issuer`, `activate_oauth_issuer`,
  `get_oauth_issuer`, and `refresh_oauth_issuer`. Keep old tools advertised but
  mark their descriptions deprecated during the compatibility window. New
  mutations retain `control:security`, explicit confirmation, ETag, and
  idempotency requirements.

## Work plan

### Phase 0 — lock decisions and conformance fixtures

- [ ] Approve this architecture and the canonical resource/audience format.
- [ ] Select the upstream end-user identity provider configuration model for
      each Gateway. Recommended default: configurable OIDC upstream plus a
      Gateway-owned user-to-tenant membership table.
- [ ] Decide whether RFC 7591 registration is open, software-statement-gated,
      or restricted by redirect policy. Recommended initial policy: public
      clients only, loopback/native and pre-approved HTTPS origins, explicit
      consent, rate limits, and administrator kill switch.
- [ ] Fix access/refresh token lifetimes and the JWKS hard-stale interval.
- [ ] Create shared metadata, JWKS, PKCE, challenge-proof, rotation, and error
      conformance fixtures used by UniCAS and both Gateways.

Exit: standards choices are documented and both platforms run the same fixture
suite before production code is added.

### Phase 1 — expand UniCAS protocol and storage

- [ ] Add OAuth issuer types, HTTP routes, route matching, errors, and threat
      model assertions in `@unicas/admin-protocol`.
- [ ] Add methods to `@unicas/admin-client` and cloud-neutral control
      operations.
- [ ] Introduce an outbound `OAuthDiscoveryPort`; keep fetch/DNS/platform code
      in `@unicas/service-cloudflare`, not in protocol packages.
- [ ] Add D1 tables for OAuth issuer bindings, inspection challenges,
      discovered metadata, discovered keys, refresh leases, and audit details.
- [ ] Implement inspect/confirm/get/refresh with membership, ETag,
      idempotency, one-time proof, issuer uniqueness, and one-active-mode
      invariants.
- [ ] Add scheduled and unknown-`kid` refresh paths with single-flight and
      hard-stale behavior.
- [ ] Add RFC 9728 protected-resource metadata for each Stack.

Exit: a test issuer can be safely inspected, proven, activated, refreshed, and
used to verify existing capability JWTs, while all legacy tests remain green.

### Phase 2 — upgrade admin WebUI, CLI, and MCP

- [ ] Implement the WebUI connection wizard and health display.
- [ ] Implement new admin-client and CLI commands, JSON output, help, and
      deprecation warnings.
- [ ] Add the four MCP tools to both remote and stdio catalogs and update exact
      catalog parity tests/documentation.
- [ ] Regenerate `service-cloudflare` embedded admin assets from the WebUI
      source.
- [ ] Add integration tests proving API, WebUI BFF, CLI, remote MCP, and stdio
      MCP resolve the same resource and enforce the same proof/ETag rules.

Exit: Stack administrators can complete registration and rotation observation
without manually uploading a JWK.

### Phase 3 — portable Gateway OAuth core

- [ ] Add the shared Gateway OAuth package and storage/identity/signing ports.
- [ ] Implement RFC 8414 metadata, JWKS, RFC 7591 client registration,
      Authorization Code + PKCE, consent, token, refresh, and revocation.
- [ ] Reuse the existing capability issuer for access-token claims; add golden
      tests showing old and OAuth-issued tokens are identical at the UniCAS
      verifier boundary.
- [ ] Implement authoritative user-to-tenant membership and role-to-scope
      policy. Remove path identity from every production authorization path.
- [ ] Separate end-user OAuth access tokens from internal Gateway-to-service
      delegated capabilities even if they initially share signing machinery.

Exit: the portable test suite passes against in-memory adapters and rejects
redirect, PKCE, tenant-confusion, scope-escalation, replay, and key-confusion
attacks.

### Phase 4 — Cloudflare Gateway adapter

- [ ] Route the issuer metadata/JWKS/authorize/token/register/revoke endpoints.
- [ ] Add D1/KV bindings and migrations for clients, authorization
      transactions, memberships, grants, refresh-token hashes, and audit.
- [ ] Publish a stable path-bearing issuer under the Gateway's public origin.
- [ ] Add scheduled cleanup and signing-key rotation publication overlap.
- [ ] Update Wrangler variables/secrets and local runtime provisioning.
- [ ] Register the Cloudflare issuer through the new UniCAS flow and verify the
      resulting JWKS digest before changing traffic.

Exit: a real public client can discover from UniCAS, authorize through the
Cloudflare Gateway, receive a capability token, and call the matching Stack and
Tenant in UniCAS.

### Phase 5 — Azure Gateway adapter

- [ ] Route the same protocol surface in the Node Gateway.
- [ ] Add PostgreSQL migrations and repositories implementing the shared OAuth
      ports and cleanup leases.
- [ ] Integrate Key Vault-backed signing keys without exporting private keys to
      clients or UniCAS. Publish public JWKs with stable `kid` values.
- [ ] Update Bicep, deployment scripts, environment validation, local runtime,
      and rotation runbooks.
- [ ] Register the Azure issuer and run the same discovery-to-data-plane E2E
      used by Cloudflare.

Exit: Cloudflare and Azure pass one shared black-box OAuth conformance suite and
produce capability tokens accepted by the same UniCAS verifier.

### Phase 6 — migrate consumers and production

- [ ] Add a tenant OAuth client/token provider for `@unicas/tenant-client` (or a
      separate tenant CLI package): RFC 9728 → RFC 8414/OIDC discovery → dynamic
      registration → browser authorization → code exchange → refresh.
- [ ] Change UniDocs Gateway user-facing authorization to bearer-token
      validation and authoritative tenant claims; keep internal delegation
      behind the Gateway.
- [ ] Change document-service trusted-key configuration from manually copied
      JWKS to verified issuer discovery, or keep it on a Gateway-generated
      pinned snapshot if those services must not make outbound calls.
- [ ] Backfill existing Stack rows as `legacy_manual`; activate discovered mode
      only after its issuer, audience, and JWKS produce equivalent verification.
- [ ] Canary Cloudflare, then Azure. Observe unknown issuer/`kid`, refresh,
      stale registry, audience, tenant mismatch, consent, and token exchange
      metrics.

Exit: all production tenant OAuth tokens use discovered issuers; no production
component requires a manually uploaded public key for Stack OAuth.

### Phase 7 — deprecate and contract

- [ ] Mark legacy HTTP responses with `Deprecation: true`, a documented
      `Sunset`, and successor `Link` where applicable.
- [ ] Make legacy issuer/key mutations disabled by default behind an emergency
      compatibility flag; retain reads and audit export.
- [ ] Remove manual controls from the primary WebUI and stop documenting old
      CLI/MCP commands except in migration guidance.
- [ ] Wait at least the maximum capability lifetime plus maximum refresh-token
      lifetime and the agreed observation window after the last legacy use.
- [ ] Remove legacy mutation routes/tools, possession-challenge storage,
      manual key tables/code, direct local seeding, and deployment inputs.
- [ ] Preserve historical audit records and publish a final schema migration.

Exit: the only active Stack OAuth trust source is verified discovery plus
provider JWKS; legacy state remains only as historical audit/migration data.

## Primary implementation areas

```text
unicas-packages/admin-protocol/src/{types,http,routes,threat-model}.ts
unicas-packages/admin-client/src/client.ts
unicas-packages/service/src/{control-admin,tenant-auth}.ts
unicas-packages/service-cloudflare/src/{control-schema,control-admin-repository,control-authority,worker}.ts
unicas-packages/service-cloudflare/src/admin-bff/bff.ts
unicas-packages/service-cloudflare/src/mcp/server.ts
unicas-packages/admin-webui/src/ui/views/issuer.tsx
unicas-packages/admin-cli/src/commands/issuer.ts
unicas-packages/admin-cli/src/mcp/catalog.ts
packages/gateway-common/src/{identity,capability-authority,gateway-handler}.ts
packages/cloudflare-gateway/**
packages/azure-gateway/**
stacks/unidocs-cloudflare/**
stacks/unidocs-azure/**
docs/cas-tenant-oidc-provider-contract.md
docs/cas-tenant-debug-tools.md
docs/cas-control-plane-{cli,mcp}.md
docs/cas-architecture.md
docs/cas-operations.md
```

## Required tests and release gates

### Security and protocol

- Metadata issuer exact-match, path-bearing URL derivation, endpoint HTTPS, and
  SSRF/redirect rejection.
- Registration challenge expiry, replay rejection, metadata-digest binding,
  wrong-Stack proof, wrong-key proof, and concurrent registration.
- JWKS duplicate `kid`, algorithm/key mismatch, private members, empty set,
  rotation overlap, successful removal, outage/stale cutoff, unknown-`kid`
  refresh, and refresh storm suppression.
- OAuth redirect exact-match, PKCE S256, code one-time use, authorization
  transaction binding, consent, scope downgrade, refresh rotation/reuse
  detection, and revocation.
- Cross-Stack and cross-Tenant token rejection, audience mismatch,
  over-lifetime token rejection, and `refDomain` authorization.

### Cross-surface parity

- Admin HTTP, BFF, CLI, remote MCP, and stdio MCP expose equivalent state and
  enforce membership, `control:security`, ETag, confirmation, and idempotency.
- Generated UI assets are reproducible from source.
- Legacy API behavior remains unchanged until its announced contract phase.

### Cross-platform E2E

Run the same black-box flow against Cloudflare and Azure:

1. read RFC 9728 Stack resource metadata;
2. fetch and pin authorization-server metadata;
3. register a public client;
4. authorize with S256 PKCE and tenant consent;
5. exchange the code for a capability JWT;
6. validate the JWT against discovered JWKS;
7. call allowed UniCAS operations;
8. prove wrong Stack/Tenant/scope calls fail;
9. rotate the Gateway signing key with overlap;
10. refresh and revoke the grant.

### Workspace gates

```text
pnpm typecheck
pnpm test
pnpm build
node scripts/analyze-deps.mjs
git diff --check
```

Also add a documentation contract check so examples agree on metadata paths,
issuer canonicalization, scopes, claim shape, and deprecated operations.

## Rollback strategy

- Expand phases are additive and leave legacy authority rows and keys intact.
- Activation is an atomic per-Stack mode switch guarded by ETag; rollback
  switches authority lookup back to the unchanged legacy snapshot.
- Gateway deployment retains the old internal signing configuration until all
  access and refresh tokens from the rollback window expire.
- Database migrations are forward-only and additive until Phase 7. Do not drop
  columns/tables during rollout.
- A discovery outage never changes the canonical issuer or silently selects a
  different JWKS source.
- Do not roll back the entire UniCAS control database to undo one Stack OAuth
  registration; use the per-Stack mode switch and audited forward repair.

## Decisions requiring explicit approval before Phase 1

1. Canonical audience: one UniCAS service resource per Stack (recommended) or a
   deployment-wide audience plus mandatory `stackId` claim.
2. Upstream user authentication for each UniDocs Gateway and ownership of the
   user-to-tenant membership directory.
3. Dynamic registration policy and allowed HTTPS/loopback redirect classes.
4. Access token, refresh token, inspection challenge, discovery cache, and
   hard-stale durations.
5. Whether document services consume Gateway discovery directly or receive a
   deployment-pinned discovered JWKS snapshot.
