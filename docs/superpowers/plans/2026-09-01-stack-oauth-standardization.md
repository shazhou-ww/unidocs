# Stack OAuth Standardization Implementation Plan

> **Status:** IN PROGRESS — 2026-09-01
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

- UniCAS now supports discovered OAuth issuer inspection and signed activation,
  persists immutable metadata/JWKS snapshots, prefers active OAuth authorities
  during capability verification, and publishes RFC 9728 metadata per Stack.
  Scheduled/unknown-`kid` JWKS refresh and hard-stale enforcement remain open.
- The shared `@unidocs/gateway-oauth` core implements RFC 8414 metadata, JWKS,
  public-client registration, Authorization Code + mandatory PKCE S256,
  consent transactions, capability access tokens, rotating refresh tokens,
  replay-family revocation, and cloud-neutral storage/identity ports.
- Cloudflare and Azure Gateway adapters expose the same OAuth protocol surface
  with D1 and PostgreSQL persistence respectively. Both OAuth authorization
  paths fail closed outside explicit local/test identity mode until a real
  Gateway-owned upstream identity/session adapter is selected and deployed.
- The Cloudflare production issuer is active for Stack `cas_SZ6wfcfqS34J`
  (`unidocs-cloudflare`) at
  `https://unicas.shazhou.work/oauth/unidocs-cloudflare`. UniCAS discovery,
  issuer-control proof, activation, metadata, JWKS, and RFC 9728 publication
  have been verified against the deployed Workers. Interactive user grants are
  intentionally unavailable until production identity and membership
  administration are connected.
- Azure has not yet been registered or exercised against the production UniCAS
  control/data planes, and Key Vault-backed signing is still outstanding.
- The tenant OAuth client/token provider and production consumer migration are
  not implemented. Legacy issuer/key mutation APIs remain available with
  deprecation messaging during the compatibility window.
- The existing `/mcp` OAuth server is control-plane OAuth only. Its Cloudflare
  provider implementation is a useful behavioral reference, not a portable
  implementation for both Gateways.

### Progress snapshot — 2026-09-01

- UniCAS protocol, discovery validation, inspection/activation proof, verifier
  switch, admin API/client, WebUI, CLI/MCP onboarding, and RFC 9728 are landed.
- The portable Gateway OAuth core and in-memory conformance coverage are landed;
  OAuth-issued capability claims have a golden compatibility test at the
  UniCAS verifier boundary.
- Cloudflare D1 storage, routes, cleanup, local discovery-to-data-plane E2E,
  production Worker routing, and the `unidocs-cloudflare` issuer activation are
  complete. Active JWKS digest:
  `c04e8152428efbe0a0960fa4eb7691286b0ec4e00034e537835a8b909c1a3e4d`.
- Azure PostgreSQL storage and route wiring are landed and locally validated;
  production identity, Key Vault signing, deployment, registration, and shared
  black-box E2E remain.

### Known issue — TODO 2026-09-02: production docx create is very slow

**RESOLVED 2026-09-02 — bucket migrated from EEUR to APAC.** Create latency:
`docx 70s → ~5.1s`, `markdown 10.9s → ~3.2s`; R2 HEAD inside the middleware DO
dropped from median 1.7s to ~65ms. Full diagnosis and migration record below.

**Diagnosed 2026-09-02 — root cause confirmed: the production CAS R2 bucket
`unidocs-cas` lived in the `EEUR` (Eastern Europe) region, ~6-15× farther from
the traffic than it should be. Everything else (D1, capability verify, DO
dispatch, concurrency) is fast.**

Evidence (production, tenant `shazhou-ww`, stack `cas_SZ6wfcfqS34J`; traffic
lands at colo KIX / Osaka):

1. **Bucket locations (CF API, per-bucket GET):**
   `unidocs-cas` = **EEUR**, `unidocs-cas-preview` = **APAC**,
   `qiankun-scope-data` = WNAM. The CAS data plane writes to the EEUR bucket.
2. **End-to-end create latency** (2 samples ~1h apart):
   `docx create 12.8s → 70s`, `markdown create 5.5s → 10.9s`.
3. **CAS probe** (`scripts/probe-cas-latency.mjs`, Server-Timing measured inside
   the middleware DO — purely CF-internal DO→R2):
   `R2 PUT 5.0-5.7s`, `R2 GET prefix 1.4-2.0s`, `R2 HEAD 0.8-3.3s (median 1.7s)`;
   D1 ops 5-20ms, capability verify ~16ms cold / ~0ms warm, DO dispatch ~20ms.
4. **Dedicated bench worker** (`scripts/r2-bench/`, deployed as
   `r2-bench-shazhou` then deleted; plain-worker path AND Durable-Object path,
   same request source, no CAS logic). 1KB objects, 8-10 rounds each:

   ```text
   worker @KIX → cas     (EEUR):  put ~850ms  get ~540ms  head ~280ms
   worker @KIX → preview (APAC):  put ~260ms  get ~130ms  head ~110ms
   DO          → cas     (EEUR):  put 1.9-16s (median ~3.1s)  get 1.1-3.9s  head 0.8-5.2s (median ~2.2s)
   DO          → preview (APAC):  put ~0.5-1.2s  get ~0.2-0.5s  head ~0.2-0.35s
   ```

   Two consistent penalties: EEUR bucket ≈ 2-3× slower than APAC bucket from
   the same path; DO→R2 ≈ 3-8× slower than plain worker→R2 (DOs are pinned
   near the requester region but their R2 path is much worse).

Why docx create pays ~26 R2 ops:

1. `storeState` stores 7 OpenXML parts (default `Document.create()` package:
   `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`,
   `word/styles.xml`, `word/_rels/document.xml.rels`, `docProps/core.xml`,
   `docProps/app.xml`). Each part = one full-body CAS lease = **R2 PUT + R2
   GET (read-back verify)**.
2. Snapshot SValue root (refs → the 7 parts) = R2 PUT + R2 GET + **7× R2 HEAD**
   (one `isNodeReady` per child in `finalizeCanonicalNodeLease`).
3. Delta root = R2 PUT + R2 GET + 1× R2 HEAD.
4. `#settlePending` bodyless renewals = 2× R2 HEAD (`leaseReadyNode` →
   `isNodeReady` does a D1 read **plus an R2 HEAD** on every call).
5. All funnels through ONE per-`(stack,tenant)` middleware DO whose
   `#mutationTail` gate serializes begin/finalize; R2 latencies add linearly.

Markdown is only ~6-8 R2 ops → 5.5s/10.9s, consistent with per-op latency.

Answers to the three review questions (2026-09-02):

- **Can CAS node uploads be parallel?** The R2 PUT stream already happens
  OUTSIDE the DO mutation gate (`#streamCanonicalUpload`), so concurrent
  uploads of different nodes genuinely overlap; the docx side caps at
  `PART_IO_CONCURRENCY=2` (memory, not correctness). Parallelism is NOT the
  bottleneck — per-op R2 latency is (2-6s vs 10-20ms D1). Only the
  begin/finalize D1 steps are serialized by the gate (~20ms each).
- **Can isNodeReady's R2 HEAD be cached in D1?** Yes. `isNodeReady` =
  `SELECT 1 FROM cas_nodes` + `R2 HEAD`; the HEAD defends only against the
  GC crash window (GC deletes R2 first, D1 row second — non-atomic). Writing a
  verified/ready marker (or trusting the row) plus a per-DO short-TTL cache
  removes ~11 R2 HEADs (~1-3s each) per docx create. Trade-off: a GC crash in
  that window could leave a row without an object → read 404 (rare, recoverable).
- **Is it R2 itself or the CAS path?** A dedicated plain-worker bench proves R2
  itself is fine (APAC bucket: HEAD ~110ms): the problem is bucket placement
  (`unidocs-cas` = EEUR) plus DO→R2 overhead.

Recommended fix order (deploy-level first, then code):

1. **[DONE 2026-09-02] Migrate `unidocs-cas` to an APAC bucket.** Created
   `unidocs-cas-apac` (`--location apac`), copied all 670 objects via the CF
   v4 object API (`scripts/r2-migrate-copy.mjs`: list → GET → PUT, 0 failed,
   0 missing, 0 size mismatch; raw body upload — the documented multipart
   form is not implemented server-side, 501), flipped `CAS_R2` in
   `unicas-packages/service-cloudflare/wrangler.toml`, redeployed, verified
   pre-migration reads (metadata/content via CAS API, docx export via gateway),
   then deleted the EEUR bucket (had to empty it first — R2 bucket delete
   requires an empty bucket). Actual result: docx create ~5.1s, markdown ~3.2s
   (slightly above the ~2-4s estimate because the remaining per-op R2 cost is
   DO→R2, not bucket distance).
2. Remove the redundant post-upload read-back R2 GET in
   `finalizeCanonicalNodeLease` (PUT already verified `sha256`).
3. Cache `isNodeReady` (D1-ready marker / per-DO TTL) to cut the ~11 R2 HEADs.
4. Only then reconsider concurrency/structural changes (DO SQLite node cache,
   middleware DO sharding).

Re-measure with `scripts/measure-create-latency.mjs` + `scripts/probe-cas-latency.mjs`
after the bucket move; `scripts/r2-bench/` can be redeployed for before/after
R2 numbers (it is intentionally gitignored-free but harmless to keep).

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

The new registration request accepts only the canonical `issuer`.

UniCAS derives the audience as `{CAS_PUBLIC_ORIGIN}/stacks/{stackId}` and fixes
the maximum capability lifetime as service policy. Neither value is selected
by the Stack administrator. Both remain visible in inspection and issuer
responses and are bound into the signed activation challenge.

It does not accept `jwks_uri` or JWK material.

Registration has two steps:

1. **Inspect:** UniCAS fetches metadata and JWKS through a platform discovery
   port, validates compatibility, and returns a short-lived challenge bound to
  `stackId`, canonical issuer, derived audience, fixed lifetime, metadata and
  JWKS digests, nonce, and expiry.
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

- [x] Approve this architecture and the canonical resource/audience format.
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

- [x] Add OAuth issuer types, HTTP routes, route matching, errors, and threat
      model assertions in `@unicas/admin-protocol`.
- [x] Add methods to `@unicas/admin-client` and cloud-neutral control
      operations.
- [x] Introduce an outbound `OAuthDiscoveryPort`; keep fetch/DNS/platform code
      in `@unicas/service-cloudflare`, not in protocol packages.
- [ ] Add D1 tables for OAuth issuer bindings, inspection challenges,
      discovered metadata, discovered keys, refresh leases, and audit details.
- [ ] Implement inspect/confirm/get/refresh with membership, ETag,
      idempotency, one-time proof, issuer uniqueness, and one-active-mode
      invariants.
- [ ] Add scheduled and unknown-`kid` refresh paths with single-flight and
      hard-stale behavior.
- [x] Add RFC 9728 protected-resource metadata for each Stack.

Current partials: issuer/inspection/metadata/key/audit persistence and
inspect/get/activate semantics are complete. Refresh leases, an explicit
refresh operation, scheduled/unknown-`kid` refresh, and hard-stale behavior are
not complete.

Exit: a test issuer can be safely inspected, proven, activated, refreshed, and
used to verify existing capability JWTs, while all legacy tests remain green.

### Phase 2 — upgrade admin WebUI, CLI, and MCP

- [x] Implement the WebUI connection wizard and health display.
- [x] Implement new admin-client and CLI commands, JSON output, help, and
      deprecation warnings.
- [ ] Add the four MCP tools to both remote and stdio catalogs and update exact
      catalog parity tests/documentation.
- [x] Regenerate `service-cloudflare` embedded admin assets from the WebUI
      source.
- [ ] Add integration tests proving API, WebUI BFF, CLI, remote MCP, and stdio
      MCP resolve the same resource and enforce the same proof/ETag rules.

Current partials: get/inspect/activate are available through remote and stdio
MCP and were used for the production Cloudflare activation. The fourth refresh
tool and complete cross-surface integration matrix remain open.

Exit: Stack administrators can complete registration and rotation observation
without manually uploading a JWK.

### Phase 3 — portable Gateway OAuth core

- [x] Add the shared Gateway OAuth package and storage/identity/signing ports.
- [x] Implement RFC 8414 metadata, JWKS, RFC 7591 client registration,
      Authorization Code + PKCE, consent, token, refresh, and revocation.
- [x] Reuse the existing capability issuer for access-token claims; add golden
      tests showing old and OAuth-issued tokens are identical at the UniCAS
      verifier boundary.
- [x] Implement authoritative user-to-tenant membership and role-to-scope
      policy. Remove path identity from every production authorization path.
      The Cloudflare data plane now validates the Gateway-issued OAuth access
      token (issuer + stack JWKS) on every `/tenants/*` request; the path
      resolver remains an explicit `INSECURE_PATH_IDENTITY=true` dev opt-in
      only, and never applies to a request that presents a token.
- [x] Separate end-user OAuth access tokens from internal Gateway-to-service
      delegated capabilities even if they initially share signing machinery.

Current partial: upstream OIDC user authentication in the Gateway browser
flow is implemented (`GATEWAY_OIDC_CLIENT_ID`/`GATEWAY_PUBLIC_ORIGIN` +
encrypted session cookie); membership administration still happens by seeding
the D1 `gateway_oauth_tenant_memberships` table.

Exit: the portable test suite passes against in-memory adapters and rejects
redirect, PKCE, tenant-confusion, scope-escalation, replay, and key-confusion
attacks.

### Phase 4 — Cloudflare Gateway adapter

- [x] Route the issuer metadata/JWKS/authorize/token/register/revoke endpoints.
- [x] Add D1/KV bindings and migrations for clients, authorization
      transactions, memberships, grants, refresh-token hashes, and audit.
- [x] Publish a stable path-bearing issuer under the Gateway's public origin.
- [x] Add scheduled cleanup and signing-key rotation publication overlap.
- [x] Update Wrangler variables/secrets and local runtime provisioning.
- [x] Register the Cloudflare issuer through the new UniCAS flow and verify the
      resulting JWKS digest before changing traffic.
- [x] Serve the Gateway webui (OAuth client + document list) under `/ui/*`.
- [ ] Production user identity (upstream OIDC) and membership administration
      go live with the deployed Gateway; `INSECURE_PATH_IDENTITY` is never set
      in production.

Current partials: D1 clients, transactions, authorization codes, memberships,
refresh families/hashes, and audit are deployed; a separate durable grant model
is not. Scheduled cleanup is deployed, while signing-key overlap/rotation
publication remains. The issuer is active and discoverable, but the phase exit
still requires production user identity and a real public-client grant.

Exit: a real public client can discover from UniCAS, authorize through the
Cloudflare Gateway, receive a capability token, and call the matching Stack and
Tenant in UniCAS.

### Phase 5 — Azure Gateway adapter

- [x] Route the same protocol surface in the Node Gateway.
- [x] Add PostgreSQL migrations and repositories implementing the shared OAuth
      ports and cleanup leases.
- [ ] Integrate Key Vault-backed signing keys without exporting private keys to
      clients or UniCAS. Publish public JWKs with stable `kid` values.
- [ ] Update Bicep, deployment scripts, environment validation, local runtime,
      and rotation runbooks.
- [ ] Register the Azure issuer and run the same discovery-to-data-plane E2E
      used by Cloudflare.

Current partial: protocol routing, PostgreSQL stores, replay-safe rotation,
fail-closed identity, and cleanup are implemented and locally tested. Key Vault,
production identity, final deployment plumbing/runbooks, registration, and
production E2E remain.

Exit: Cloudflare and Azure pass one shared black-box OAuth conformance suite and
produce capability tokens accepted by the same UniCAS verifier.

### Phase 6 — migrate consumers and production

- [ ] Add a tenant OAuth client/token provider for `@unicas/tenant-client` (or a
      separate tenant CLI package): RFC 9728 → RFC 8414/OIDC discovery → dynamic
      registration → browser authorization → code exchange → refresh.
- [x] Change UniDocs Gateway user-facing authorization to bearer-token
      validation and authoritative tenant claims; keep internal delegation
      behind the Gateway. The Gateway webui (`packages/web-gateway`) acts as
      the OAuth client; the data plane validates the issued access token
      against the issuer + stack JWKS.
- [x] Change document-service trusted-key configuration from manually copied
      JWKS to verified issuer discovery, or keep it on a Gateway-generated
      pinned snapshot if those services must not make outbound calls. Doc
      workers now support `CAS_STACK_JWKS_URI` (live jwks_uri or `"discover"`)
      with the pinned snapshot retained as the non-discovery fallback.
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
