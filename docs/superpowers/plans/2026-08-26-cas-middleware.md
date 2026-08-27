# CAS Middleware Implementation Plan

> **Status:** COMPLETE as of 2026-08-26. Tasks 1–10 are done; Task 11
> (documentation) is largely delivered — `docs/cas-architecture.md`,
> `docs/capability-key-operations.md`, `docs/cas-operations.md` (SLOs,
> alerts, runbooks), README — with only ongoing doc-maintenance items and
> the `check-cas-contract-docs.mjs` CI script left open. Two [~] items
> remain by design: console-based possession-proof stack registration
> (admin onboarding round) and the remaining ops-gate delivery (scheduled
> backups, destructive restore drill, alert delivery, analytics — tracked in
> `docs/cas-operations.md`). The application-stack organization/deployment
> was handed off to `2026-08-26-app-stack-organization-todo.md`.
>
> **For agentic workers:** Implement one task at a time and keep the checkboxes
> current. Preserve the middleware/control-plane boundary and do not
> reintroduce owner/ref assignment semantics while migrating callers.
> Coordinate the authorization changes with
> `2026-08-25-gateway-issued-capability-authorization.md`.

**Goal:** Turn UniDocs CAS into an independently deployed and operated
multi-stack middleware service. Stack administrators self-register and manage
their stacks through a dedicated top-level `/admin` control plane; Azure and Cloudflare UniDocs
deployments become separate initial stacks consuming the same CAS service. As
part of that boundary, replace the two competing root APIs with one
signed-count Root Refs API, add stack-domain audit, remove root-owner
assignments, and delete the unused portable-node HTTP surface.

**Architecture:** CAS owns one service endpoint, storage plane, operator
control plane, and stack admin plane independent of any UniDocs application
stack. CAS uses stable `stackId` as its top-level trust and data namespace.
Within a stack, `tenantId` identifies data ownership and `refDomain`
independently identifies Root Ref audit attribution. Stack administrators
authenticate to the control plane through OIDC, initially Google, and manage
equal-permission membership, one tenant JWT issuer with multiple public keys,
observed Root Ref domains, and audit data. Tenant APIs continue to use stack-issued JWT
capabilities. The authoritative CAS lifecycle state remains the
`(stackId, tenantId)`-scoped aggregate `root_ref_count`; domain tables are
atomic audit projections and never authoritative lifecycle inputs.

**Tech Stack:** TypeScript, pnpm monorepo, Cloudflare Workers, Durable Objects,
D1, R2, OIDC-backed BFF sessions, stack-issued JWT capability tokens, Vitest.

## Scope

This plan covers:

- an independently deployable CAS middleware service and stable service URL;
- self-service administrator login, stack registration, membership,
  issuer/public-key configuration, domain management, and control-plane audit;
- formal stack admin APIs and a WebUI-facing control-plane ingress;
- the `@unicas/protocol` tenant contracts and separate
  `@unicas/protocol-admin` control-plane contracts;
- CAS tenant clients, admin BFF/session APIs, and stack integration adapters;
- Cloudflare CAS routing, storage, control-plane state, transactions, and
  migrations;
- onboarding the Azure and Cloudflare UniDocs deployments as distinct stacks;
- tenant JWT issuer configuration, independent OIDC admin-session
  authentication, stable stack identity, `refDomain` derivation, and
  authorization;
- ownership of CAS route matching versus Gateway exposure policy;
- migration away from `rootAssignments` and `cas_root_owners`;
- removal of the unused portable-node HTTP contracts and handlers while
  retaining the shared canonical binary format;
- current-balance and event-log query behavior;
- caller/deployment migration, tests, operations, and architecture
  documentation.

This plan does not:

- split CAS into a separate source repository; CAS remains in the UniDocs
  monorepo and is independent at the build/deployment/operations boundary;
- require a second CAS deployment per UniDocs stack;
- make stack operators CAS platform operators;
- model individual business references inside CAS;
- allow callers to assign a stable owner/ref ID to a hash;
- make domain balances authoritative for GC or node lifecycle;
- require Gateway to expose any particular CAS operation;
- define automatic correction from audit data;
- treat control-plane operator identities as tenant/end-user identities.

## Fixed decisions

### Middleware deployment and repository boundary

CAS is one independently deployed middleware service with its own endpoint,
release lifecycle, storage bindings, observability, secrets, migrations,
availability objectives, and incident procedures. Application stacks do not
own or embed CAS storage. They register with CAS and call it over its supported
service contracts.

The initial UniDocs topology is:

```text
Independent CAS middleware
├── stack: unidocs-cloudflare
└── stack: unidocs-azure
```

The repository is already close to this physical topology: `cloudflare-cas`
is the only CAS server deployment, and Azure services already call it through
a remote base URL. The missing middleware boundaries are self-service stack
registration, stack-aware storage, independent control/admin authentication,
capability-based tenant access, and removal of the cross-stack shared
`CAS_ACCESS_KEY`.

The two stacks may contain the same textual `tenantId` without sharing state.
They register independent tenant JWT issuers, keys, domains, and policies. The
CAS deployment provider is not part of `stackId`; a CAS runtime
can move without renaming registered stacks.

Source ownership does not change. `protocol-cas`, `cas-client`,
`cas-server-common`, the deployable CAS runtime, stack adapters, control-plane
code, and tests remain pnpm workspace packages in the UniDocs monorepo. The
monorepo may produce multiple independently deployable artifacts; repository
co-location must not create runtime coupling to Gateway or a particular stack.

### Self-service stack control plane

Stack administrators register and administer stacks themselves. The MVP
identity provider is Google OIDC, and persistence uses immutable `(iss, sub)`
identity rather than email. Additional identity providers are deferred.

Control-plane resources include:

```text
operator identities
stacks
stack memberships
one tenant JWT issuer definition per stack and multiple public keys/JWKS
control-plane audit events
Root Ref audit data
```

A stack is administered through N:N membership, not a single email. Every MVP
member has the same administrator authority. A stack must always retain at
least one member; adding a replacement member and removing the previous member
implements management transfer. CAS platform operators retain separate
suspension and disaster-recovery powers that stack members cannot grant
themselves.

The MVP WebUI and admin API use one Google OIDC-backed BFF session. CAS does not
issue stack admin credentials or automation access tokens in this phase.
Browser code stores only a secure session cookie and never stores a long-lived
broad bearer token.

### `cas-admin-webui` package boundary

`unicas-packages/admin-webui` is a private pnpm workspace package and independent
deployable. It follows the existing monorepo Web toolchain with a Vite +
TypeScript client and a Worker BFF/server entry. Deployment routing mounts it
at `/admin` on the CAS service domain; the tenant CAS runtime owns the
unprefixed `/stacks` data plane.

The package owns:

- Google OIDC login/callback initiation and validation;
- encrypted or signed `HttpOnly`, `Secure`, `SameSite` session cookies;
- CSRF/origin protection and session rotation/expiry;
- `/admin` BFF route handling and stack membership enforcement;
- management UI state, forms, tables, pagination, and operator workflows.

It depends on `@unicas/protocol-admin` and the cloud-neutral
`cas-control-plane` service library. It does not import tenant CAS worker/DO
implementation modules, does not accept stack tenant JWTs, and has no binding
to tenant D1, R2, or Durable Objects. Control-plane reads/writes go through the
service library and `CAS_CONTROL_DB`; Root Ref audit reads use a narrowly
defined read service rather than direct browser storage access.

### Single-domain front door

A dedicated lightweight `cas-edge` Worker owns the public CAS hostname,
DNS/custom route, TLS termination, and top-level dispatch. It forwards
`/stacks/...` to the private `cloudflare-cas` tenant Worker and `/admin/...` to
the private `cas-admin-webui` Worker through distinct service bindings. Neither
backing Worker has an independent public route. Health endpoints distinguish
edge, tenant, and admin readiness so one plane can be diagnosed without
treating the others as healthy.

The front door performs strict normalized-prefix matching before authentication:

```text
/stacks/... -> strip Cookie and admin/session headers -> CAS_TENANT_SERVICE
/admin/...  -> strip tenant Authorization and identity override headers
               -> CAS_ADMIN_SERVICE binding
other       -> 404
```

It supplies trusted original-origin metadata to the BFF from deployment
configuration rather than accepting spoofable forwarded headers. The BFF
accepts requests only from the service binding and validates its own OIDC
session, CSRF token, origin, and stack membership.

The admin BFF reads Root Ref audit through a narrow private RPC/service
entrypoint exported by the tenant Worker; the edge never exposes that entrypoint
as an HTTP route. The call graph is acyclic:

```text
cas-edge -> cloudflare-cas
cas-edge -> cas-admin-webui -> cloudflare-cas audit-reader RPC
```

The three Workers are independently deployable but publish a tested
compatibility version. Deployment updates private backing Workers first, then
the edge; rollback reverses that order. At least the current and immediately
previous compatible versions are retained. An incompatible protocol change
requires an expand/deploy/contract rollout rather than a simultaneous blind
replacement.

### Scope model

CAS has three explicit scope concepts:

```text
stackId
├── tenantId   data ownership and lifecycle isolation
└── refDomain  Root Ref audit attribution
```

`stackId` is the top-level deployment-service namespace. `tenantId` and
`refDomain` are orthogonal dimensions beneath it. A Root Ref audit domain is
identified by `(stackId, refDomain)` and spans tenant-owned operations inside
that stack; each balance row and event also records the affected `tenantId`.
Do not concatenate these fields into an `issuer:domain` string. Keep them
structured in authorization context, routes, storage keys, and logs.

The JWT `iss` value is an authentication authority identifier, not the durable
data namespace. Each stack registers exactly one stable tenant issuer, and each
issuer value maps to exactly one `stackId`. That issuer has multiple public keys
selected by `kid`, supporting replicated issuers and zero-downtime key rotation.
Multiple issuer identities per stack and issuer migration are deferred. CAS
does not recognize a Gateway product identity; Gateway is only one possible
implementation of a stack's issuer.

Avoid using the generic term `scope` for `refDomain`, because JWT permission
claims commonly use `scope`. In this plan:

```text
JWT scope / permission  what an authenticated caller may do
refDomain              which business domain emitted a Root Ref change
```

### Core root model

The root model is a stack-and-tenant-level signed-count ledger:

```text
(stackId, tenantId, hash) -> rootRefCount
```

A business operation submits a signed, non-zero integer delta per hash. Two
logical references to the same hash are represented by `+2`; releasing one is
`-1`. CAS does not know the identities of those logical references.

For each hash, the core invariant is:

```text
rootRefCount >= 0
```

The update batch is atomic. A move from hash A to hash B is one request
containing `{ A: -1, B: +1 }`.

### Responsibility boundary

Business domains are responsible for:

- emitting exactly one increment when a logical root reference is acquired;
- emitting exactly one decrement when it is released;
- using one stable `requestId` for retries of the same business operation;
- persisting enough business state to reconstruct their intended balances;
- participating in operator-assisted reconciliation between intended balances
  and CAS audit data after an incident.

CAS is responsible for:

- canonicalizing and validating a complete change batch;
- making retries idempotent by `refDomain + requestId + payloadHash`;
- rejecting request ID reuse with a different payload;
- rejecting an aggregate result below zero or outside safe integer bounds;
- requiring every positively referenced hash to be ready;
- atomically updating aggregate counts, idempotency, and audit records;
- preventing GC while aggregate root or child counts are non-zero.

CAS cannot detect a balanced but semantically incorrect sequence of business
increments and decrements. That is a reconciliation concern, not a reason to
add logical Ref entities to CAS.

### Reference domains

`refDomain` means a stable business boundary that independently emits and
reconciles root changes. It is not a user account, tenant, process instance,
or logical reference.

Initial examples are:

```text
doc
asset
indexer
```

If deployment topology requires stronger attribution, registered stable names
such as `doc:markdown` and `doc:docx` may be used. Ephemeral instance IDs must
not be used because restarts and scale-out must retain one continuous ledger.

Root Refs write requests do not carry `refDomain` in their path, query,
headers, or body. CAS derives it from a validated capability claim issued for
the calling service. Each stack declares which domains its issuer may mint. A
writer cannot select another domain.

The existing shared `CAS_ACCESS_KEY` cannot prove domain attribution. The
trusted write-attribution path therefore depends on the capability migration.
A local test adapter may inject a validated authorization context, but no
compatibility path may trust an arbitrary caller-supplied domain header.

For tenant service APIs, the stack issuer signs `tenantId`, permissions, and
where required `refDomain` into a JWT capability. CAS selects a configured
tenant issuer by `iss`, selects a key by `kid`, verifies signature, algorithm,
the CAS data-plane audience, time bounds, and claims, and then maps the issuer
to `stackId`. An issuer or JWKS location supplied only by the token is never
trusted or fetched dynamically.

The authorization context travels end to end through capability claim/input
types, stack-authority issuance, service verification/delegation, CAS client
configuration, CAS verification, and stack-and-tenant DO forwarding. Root Refs
writes use the verified claim as their sole domain source. The current
`X-Tenant-Id`, request body, query parameters, and arbitrary headers cannot
supply or override stack, tenant, or domain identity. Runtime adapters must
forward the delegated CAS capability instead of authenticating Root Refs only
with the shared access key.

Audit reads are different: an operator with dedicated audit-read permission
selects a domain as an explicit query target. That path parameter is a filter
over audit data, not the attribution source for a Root Refs write.

### Authentication planes

Tenant service and stack admin APIs use completely separate authentication
planes:

```text
tenant service API
  credential: stack issuer JWT capability
  verifier: tenant issuer/key registry
  audience: CAS data plane
  authority: issuer-derived stack + signed tenant and optional refDomain

stack admin API
  credential: Google OIDC-backed BFF session
  verifier: OIDC identity + stack membership
  authority: membership in the stack named by the /admin path
```

The tenant and admin verifier configurations and trust roots are disjoint. A
tenant JWT is never accepted by an `/admin` route even if it contains an
admin-looking scope; an OIDC control session is never accepted by a tenant
route. The MVP does not provide admin automation tokens. The WebUI uses its
OIDC-backed BFF session and never embeds a broad credential in browser code.

### Tenant authority registry

`CAS_CONTROL_DB` is authoritative for the globally unique issuer-to-stack
mapping and issuer keys. `cas-admin-webui`/`cas-control-plane` are the only
writers. The tenant runtime receives a read-only authority-repository binding;
its code path exposes only lookup operations and is tested to issue no control
schema mutations.

For each tenant JWT, CAS:

1. parses unverified `iss` and `kid` only as lookup keys;
2. resolves one active issuer record and key from the controlled registry;
3. verifies configured algorithm, signature, exact issuer, CAS audience,
  lifetime, tenant, permissions, and optional `refDomain`;
4. derives `stackId` only from the verified registry record;
5. compares derived stack and signed tenant with the request path before any
  tenant D1, R2, or DO access.

Unknown/ambiguous issuers, unknown or revoked keys, missing `kid`, algorithm
downgrade, wrong audience, and claim mismatches fail closed. Token-provided
JWKS locations are never fetched. Exactly one issuer is active per stack and an
issuer value is globally unique.

Active authority records may be cached in a Worker isolate for 30 seconds.
Revocation/key-removal propagation is bounded to 60 seconds and is measured by
an admin mutation receipt plus tenant-verifier telemetry. A cached record older
than 60 seconds is not used when the control database is unavailable; tenant
authentication fails closed until the registry can be refreshed. Key rotation
uses overlapping `active` and `retiring` keys for at least the maximum JWT
lifetime; an explicitly `revoked` key is rejected after the propagation bound.
Every issuer/key change and every stale-cache/fail-closed event is audited.

The current static `CAPABILITY_ISSUER`/JWKS configuration bootstraps one
operator-selected legacy stack during migration. A verification job proves the
dynamic registry accepts equivalent tokens before traffic switches. Static
configuration remains rollback-compatible through the rollback window and is
removed only in the contract phase; normal registry changes require no CAS
deployment.

### CAS-neutral tenant capability

All stack issuers produce the same CAS data-plane claim shape:

```text
iss, aud, sub, iat, nbf?, exp, jti
tenantId
permissions[]
refDomain?   required only for Root Refs writes
```

`stackId` is derived from the verified issuer registry and is not a
caller-selected claim. `sub` is an opaque service principal retained for audit;
CAS does not recognize `gateway`, `doc:`, deployment names, or subject-prefix
semantics. Azure and Cloudflare stack authorities are adapters that issue this
same contract.

Tenant permissions are operation-specific:

```text
cas:read         content and metadata reads
cas:write        lease/upload/lease-extension and Root Refs writes
cas:usage:read   tenant usage
cas:gc:trigger   advisory tenant GC
```

There is no tenant `cas:admin` permission. Root Refs requires `cas:write` plus
a valid issuer-signed `refDomain`. CAS validates the domain claim and the first
successful write records it in the audit revision catalog. Exact audience and
permission matching is required; unknown permissions do not grant access. The verified principal,
issuer/stack, tenant, permission, domain, request ID, and decision are available
to security telemetry without logging the bearer token.

### Audit-only data

The domain event log and current-balance projection are strongly recorded
audit data:

```text
cas_root_domain_events
cas_root_domain_refs
```

They are written in the same atomic operation as the aggregate count update so
every successful update is auditable. Failure to write audit data fails and
rolls back the whole request.

They are not authoritative inputs. In particular:

- update validation reads `cas_nodes.root_ref_count`, not domain balances;
- GC reads aggregate root/child counts and lease state only;
- node readiness does not depend on domain records;
- CAS does not reject a negative domain balance if the tenant aggregate remains
  valid;
- CAS never automatically rewrites aggregate counts from audit projections;
- an audit mismatch raises an operational diagnostic and requires an explicit
  repair decision.

Negative domain balances are intentionally visible. They may indicate an
over-release, a pre-migration reference attributed to a baseline domain, or a
business bookkeeping defect. Rejecting them would silently turn audit data
into a second ownership model.

### Idempotency

Idempotency is scoped to `(stackId, tenantId, refDomain, requestId)`.

- First successful use records the canonical payload hash and audit revision.
- Retrying the same request ID and payload is a no-op and returns the original
  revision with `idempotent: true`.
- Reusing the request ID with another payload returns `409 Conflict`.
- The same textual request ID in a different domain does not conflict.
- A rejected request creates no idempotency row, event, projection change, or
  aggregate change.

The initial implementation retains idempotency records and audit events
indefinitely. Retention/compaction requires a later protocol design with an
explicit minimum available revision and reconstructable checkpoints.

## Target HTTP API

CAS defines its complete service and operator API. Gateway independently owns
the policy deciding which CAS operations it exposes to its callers. A CAS
route being absent from the current Gateway allowlist does not make it an
internal CAS route, and CAS authorization must never rely on Gateway filtering.

The Root Refs write is a stable CAS service API for authenticated callers such
as Doc services, regardless of whether they are deployed in the same stack as
CAS. Because these routes are served by CAS itself, the canonical service path
does not repeat a `/cas` mount segment. Domain reads are stable operator APIs
under the stack-level `admin` namespace; they are not ordinary business-service
reads. Audit is the first admin API family, and the namespace may later contain
other CAS control-plane operations used by a stack administration WebUI. These
are formal, versioned service contracts. Their admin classification does not
determine Gateway exposure or network reachability.

The first path segment selects the authentication plane before resource
matching: `/admin/...` uses the OIDC BFF session and stack membership; all
unprefixed `/stacks/...` routes use stack-issuer tenant JWTs. MVP stack members
have equal control-plane authority, so admin routes do not define a second RBAC
or token-scope system.

### Operator control-plane routes

OIDC-authenticated operators use a global control-plane surface to discover
their identity and self-register stacks:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/admin/me` | Read the current immutable OIDC identity and memberships |
| `GET` | `/admin/stacks` | List stacks visible to the current administrator |
| `POST` | `/admin/stacks` | Register a stack and create the caller's first membership |

Stack registration assigns an opaque, stable, CAS-generated `stackId`. The
administrator chooses only display metadata. Registration creates membership
and does not return a bearer token or automation credential.

OIDC login/callback uses standard provider endpoints. It is a control-plane
authentication protocol rather than a CAS resource route and is not added to
the tenant `CasRoute` union.

### Stack admin routes

After selecting a stack, members manage it through formal top-level admin APIs:

| Resource | Representative routes |
|---|---|
| Stack metadata | `GET/PATCH /admin/stacks/{stackId}` |
| Membership | `GET/DELETE /admin/stacks/{stackId}/members` |
| Member invitation | `POST /admin/stacks/{stackId}/member-invitations`; `POST /admin/member-invitations/{token}/accept` |
| Tenant issuer | `GET/PUT /admin/stacks/{stackId}/issuer` |
| Issuer keys | `GET/POST/DELETE /admin/stacks/{stackId}/issuer/keys` |
| Reference domains | `GET /admin/stacks/{stackId}/ref-domains` (observed audit domains) |
| Root Ref audit | `GET /admin/stacks/{stackId}/root-ref-domains/{refDomain}/...` |
| Control audit | `GET /admin/stacks/{stackId}/audit-events` |

Issuer key rotation supports overlap, proof of private-key possession,
and explicit `active`, `retiring`, and `revoked` states. (Task 2 amendment:
`pending` is removed — the frozen contract has no pending-to-active transition
endpoint, so possession proof on create is the activation gate and keys enter
`active` directly.) Configuration mutations append immutable control-plane
audit events with actor, action, target, timestamp, request/trace ID, and
security context.

### Control-plane mutation contract

Every mutable control-plane resource has an integer `revision` rendered as a
strong ETag. `PATCH`, replacement `PUT`, retirement/revocation, and `DELETE`
require `If-Match`; missing preconditions return `428 PRECONDITION_REQUIRED`
and stale revisions return `412 REVISION_MISMATCH`. Resource mutation and its
control-audit event commit in the same `CAS_CONTROL_DB` transaction.

Creation endpoints accept `Idempotency-Key`, scoped to `(administrator
identity, method, canonical route)`, and retain the response for at least 24
hours. Reuse with another canonical payload returns `409 IDEMPOTENCY_CONFLICT`.
List endpoints use opaque versioned cursors bound to filters and a control-data
snapshot revision; malformed/mismatched cursors return `400 INVALID_CURSOR`.

MVP membership transfer uses invitations because one administrator does not
know another Google account's immutable `sub`:

1. A member creates an invitation, optionally constrained to a normalized
  display email, with a 24-hour expiry.
2. CAS returns a high-entropy one-time invitation URL once and stores only its
  token hash.
3. The invitee signs in through Google OIDC and accepts the invitation; CAS
  atomically consumes it and creates `(stackId, iss, sub)` membership.
4. Any member may then remove the previous member, but deletion that would
  leave zero members returns `409 LAST_MEMBER`.

Stack creation atomically creates the stack and caller membership. The issuer
is a singleton resource with globally unique `iss`; keys are child resources
with unique `kid` and explicit lifecycle state. Ref domains are discovered from
successful audit writes rather than created in the control plane. Stable control-plane errors
include `ADMIN_AUTH_REQUIRED`, `STACK_MEMBERSHIP_REQUIRED`, `NOT_FOUND`,
`LAST_MEMBER`, `ISSUER_CONFLICT`, `KEY_STATE_CONFLICT`,
`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, and (Task 2 amendment) `INVALID_REQUEST`,
mapped consistently to HTTP status.

### Before: current canonical CAS routes

These are all method/route pairs currently recognized by
`@unicas/protocol`. Gateway exposure is intentionally not represented in
this table because it is a separate Gateway policy.

| Method | Route | Operation | Purpose |
|---|---|---|---|
| `GET` | `/tenants/{tenantId}/cas/nodes/{hash}/content` | `readContent` | Read ready node content |
| `GET` | `/tenants/{tenantId}/cas/nodes/{hash}/metadata` | `readMetadata` | Read node metadata and lifecycle state |
| `POST` | `/tenants/{tenantId}/cas/nodes/{hash}` | `leaseNode` | Upload and lease canonical content |
| `POST` | `/tenants/{tenantId}/cas/nodes/{hash}/lease` | `leaseExisting` | Extend an existing node lease |
| `GET` | `/tenants/{tenantId}/cas/usage` | `usage` | Read tenant CAS usage |
| `POST` | `/tenants/{tenantId}/cas/gc` | `gc` | Trigger tenant GC |
| `POST` | `/tenants/{tenantId}/_internal/root-refs` | `rootRefs` | Apply signed Root Ref deltas |
| `POST` | `/tenants/{tenantId}/_internal/root-assignments` | `rootAssignments` | Apply owner-based root assignments |
| `GET` | `/tenants/{tenantId}/_internal/nodes/{hash}` | `readPortableNode` | Read a complete portable CAS node |
| `POST` | `/tenants/{tenantId}/_internal/nodes/{hash}` | `leasePortableNode` | Validate and lease a complete portable CAS node |

The portable-node routes are full-node service transport, not CAS operator or
audit APIs. A repository-wide search found no non-test caller: the
tenant-prefixed contracts are declarations plus matcher tests, while the
tenant-header-only Cloudflare routes are exercised only by CAS server tests.
The target therefore removes both forms without replacement. This does not
remove the independently specified and tested canonical CAS binary codec.
`encodeHeader` and `computeNodeDigest` have non-route production consumers;
full-node parse/concatenate helpers remain codec APIs rather than HTTP APIs.

### After: target middleware routes

| Plane | Method | Route | Operation | Change |
|---|---|---|---|---|
| Tenant | `GET` | `/stacks/{stackId}/tenants/{tenantId}/nodes/{hash}/content` | `readContent` | Add stack scope; remove ingress mount |
| Tenant | `GET` | `/stacks/{stackId}/tenants/{tenantId}/nodes/{hash}/metadata` | `readMetadata` | Add stack scope; remove ingress mount |
| Tenant | `POST` | `/stacks/{stackId}/tenants/{tenantId}/nodes/{hash}` | `leaseNode` | Add stack scope; remove ingress mount |
| Tenant | `POST` | `/stacks/{stackId}/tenants/{tenantId}/nodes/{hash}/lease` | `leaseExisting` | Add stack scope; remove ingress mount |
| Tenant | `GET` | `/stacks/{stackId}/tenants/{tenantId}/usage` | `usage` | Add stack scope; remove ingress mount |
| Tenant | `POST` | `/stacks/{stackId}/tenants/{tenantId}/gc` | `gc` | Add stack scope; remove ingress mount |
| Tenant | `POST` | `/stacks/{stackId}/tenants/{tenantId}/root-refs` | `updateRootRefs` | Canonical Root Refs service API |
| Admin | `GET` | `/admin/stacks/{stackId}/root-ref-domains/{refDomain}/refs` | `listRootDomainRefs` | New OIDC-admin audit API |
| Admin | `GET` | `/admin/stacks/{stackId}/root-ref-domains/{refDomain}/events` | `listRootDomainEvents` | New OIDC-admin audit API |

`POST /tenants/{tenantId}/_internal/root-assignments` is removed rather than
replaced. The new Root Refs write route subsumes root lifecycle changes through
signed deltas but does not emulate owner assignment semantics.

`GET` and `POST /tenants/{tenantId}/_internal/nodes/{hash}` are also removed.
They have no in-repository service consumer and are not renamed or replaced.

### Runtime compatibility routes

Cloudflare CAS currently also accepts tenant-header-only forms that are not
canonical `@unicas/protocol` routes:

| Method | Runtime route | Target disposition |
|---|---|---|
| `POST` | `/_internal/root-refs` | Single-legacy-stack compatibility through rollback window, then remove |
| `POST` | `/_internal/root-assignments` | Remove with owner assignments |
| `GET` | `/_internal/nodes/{hash}` | Remove without replacement |
| `POST` | `/_internal/nodes/{hash}` | Remove without replacement |

Historical `/users/{userId}/cas/...` paths are Gateway ingress compatibility
routes, not CAS service routes. A shared ingress may use `/cas` as its own
service-routing mount, keep stack identity implicit, and map requests to the
canonical stack-scoped CAS path. Its path shape, retention, and removal belong
to that proxy and are intentionally excluded from both canonical CAS matrices.

Tenant routes require the tenant-JWT issuer mapping to produce the path
`stackId` and the token tenant to equal the path tenant. `/admin` routes bypass
the tenant verifier entirely: the OIDC BFF session identity must be a member of
the path stack. These checks occur before storage access. For writes,
`refDomain` comes only from the verified tenant capability. For audit reads,
`refDomain` is an administrator-selected path parameter. A tenant capability
never grants admin access.

The current public CAS proxy policy must not expose Root Refs writes or CAS
admin routes. That allowlist belongs in Gateway-owned code, not
`@unicas/protocol`. `cas-admin-webui` owns the `/admin` BFF/session ingress;
it does not turn admin routes into tenant/public CAS routes.

### Apply signed deltas

The request body remains compatible with `CasRootRefUpdate`:

```ts
export interface CasRootRefUpdate {
  readonly requestId: string;
  readonly changes: Readonly<Record<CasHash, number>>;
}
```

Example:

```http
POST /stacks/stack-a/tenants/tenant-1/root-refs
Authorization: Bearer <cas capability carrying refDomain=doc>
Content-Type: application/json

{
  "requestId": "session:s1:commit:8:roots",
  "changes": {
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": -1,
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 2
  }
}
```

Successful response:

```json
{
  "success": true,
  "idempotent": false,
  "revision": 1843
}
```

Validation requirements:

- `requestId` is non-empty and bounded;
- `changes` is non-empty and bounded;
- hashes are canonical lowercase SHA-256 strings;
- each delta is a non-zero safe integer within a per-request bound;
- duplicate JSON keys are rejected by request parsing or canonical decoding;
- additions and aggregate results cannot overflow safe integer bounds;
- positive targets exist and are ready;
- every referenced hash exists, including negative-only changes;
- no aggregate result becomes negative;
- all validation occurs before any durable mutation.

### Read a stack domain's current audit balance

```http
GET /admin/stacks/stack-a/root-ref-domains/doc/refs?tenantId=tenant-1&limit=500&cursor=...
Cookie: cas_admin_session=<HttpOnly OIDC-backed session>
```

```json
{
  "revision": 1843,
  "refs": [
    { "tenantId": "tenant-1", "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "count": 3 },
    { "tenantId": "tenant-1", "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "count": -1 }
  ],
  "nextCursor": null
}
```

This is the CAS-recorded balance for the operator-selected stack domain, not
proof of the business system's current real-world references. `tenantId` is an
optional exact filter; when omitted, the response scans the domain across all
tenants in the stack. Every row includes `tenantId`. Zero-balance rows are
omitted; negative balances are returned.

Results are ordered by `(tenantId, hash)` and bounded. The first page returns a
stack-domain `revision`; subsequent pages bind their cursor to that revision
and the optional tenant filter. The MVP serves only the mutable current
projection; it does not retain or reconstruct a historical projection for a
cursor revision.

Each page reads the stack-domain revision, queries rows, and reads the revision
again through one primary-consistent D1 session. The first page retries this
sequence a bounded number of times if the revision changes. A subsequent page
requires the current revision to equal the cursor revision before and after its
row query. Any mismatch discards the page and returns
`409 ROOT_REF_SNAPSHOT_CHANGED`, requiring a restart from page one. A write
committed after the final revision check does not invalidate the already-read
page; it advances the revision seen by the next request.

Revisions increase monotonically per `(stackId, refDomain)`, beginning at zero
before the first event. A write for any tenant in that stack domain advances
the revision; writes in another domain or stack do not. `limit` defaults to 200
and cannot exceed 1000. The opaque cursor encodes a version, stack domain,
revision, optional tenant filter, last tenant, and last hash. Malformed cursors
or cursors bound to another path domain/filter return `400`; any well-formed
cursor whose revision is no longer current returns the snapshot-changed `409`.

### Read a stack domain's audit event log

```http
GET /admin/stacks/stack-a/root-ref-domains/doc/events?tenantId=tenant-1&after=1842&limit=500
Cookie: cas_admin_session=<HttpOnly OIDC-backed session>
```

```json
{
  "events": [
    {
      "revision": 1843,
      "tenantId": "tenant-1",
      "requestId": "session:s1:commit:8:roots",
      "changes": {
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": -1,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": 2
      },
      "appliedAt": 1787700000000
    }
  ],
  "latestRevision": 1843,
  "nextAfter": 1843
}
```

Events are returned in increasing stack-domain revision order. `tenantId` is an
optional exact filter and every event includes its affected tenant. Idempotent
retries do not append another event. `after` is exclusive. An empty page still
returns the latest revision known for the selected stack domain, not merely the
latest revision matching the tenant filter.

`after` defaults to zero and must be a non-negative safe integer. Event `limit`
defaults to 200 and cannot exceed 1000. Invalid query values return `400`.
`latestRevision` is read consistently with the page. `nextAfter` is the last
returned revision when events are present. For an empty tenant-filtered page it
is `max(after, latestRevision)`, which certifies that no matching event exists
through that stack-domain watermark and prevents polling from getting stuck on
other tenants' events. Revisions are append-only, so later matching events
cannot appear below that watermark.

## Protocol type changes

Remove:

```text
CasRootAssignment
CasAssignRootsRequest
CasRootAssignmentsRequest
CasRootAssignmentsResponse
CasEndpointContracts.rootAssignments
CasRoute operation "rootAssignments"
TenantCasService.assignRoots()
casRoutes.rootAssignments()
CasPortableNodeContentType
CasReadPortableNodeRequest
CasReadPortableNodeResponse
CasLeasePortableNodeRequest
CasLeasePortableNodeResponse
CasEndpointContracts.readPortableNode
CasEndpointContracts.leasePortableNode
CasRoute operations "readPortableNode" and "leasePortableNode"
casRoutes.portableNode()
protocol-cas isPublicCasRoute()
```

The portable HTTP removal must not delete the canonical binary specification
or its independently tested encoding, parsing, validation, and digest helpers.
Those utilities are not owned by the retired routes; digest construction is
also consumed by ordinary CAS clients and Doc runtimes.

Retain `CasRootRefUpdate` and add the tenant write contract to
`@unicas/protocol`:

```ts
export interface CasStackPath {
  readonly stackId: string;
}

export interface CasTenantPath extends CasStackPath {
  readonly tenantId: string;
}

export interface CasNodePath extends CasTenantPath {
  readonly hash: CasHash;
}

export interface CasUpdateRootRefsRequest {
  readonly path: CasTenantPath;
  readonly body: CasRootRefUpdate;
}

export type CasUpdateRootRefsResponse =
  | { success: true; idempotent: boolean; revision: number }
  | CasErrorResponse;
```

Add stack audit contracts to `@unicas/protocol-admin`:

```ts
export interface CasAdminRootDomainPath {
  readonly stackId: string;
  readonly refDomain: string;
}

export interface CasListRootDomainRefsRequest {
  readonly path: CasAdminRootDomainPath;
  readonly query?: { tenantId?: string; limit?: number; cursor?: string };
}

export interface CasRootRefBalance {
  readonly tenantId: string;
  readonly hash: CasHash;
  readonly count: number;
}

export type CasListRootDomainRefsResponse =
  | { revision: number; refs: readonly CasRootRefBalance[]; nextCursor: string | null }
  | CasErrorResponse;

export interface CasListRootDomainEventsRequest {
  readonly path: CasAdminRootDomainPath;
  readonly query?: { tenantId?: string; after?: number; limit?: number };
}

export interface CasRootRefEvent {
  readonly revision: number;
  readonly tenantId: string;
  readonly requestId: string;
  readonly changes: CasRefChanges;
  readonly appliedAt: number;
}

export type CasListRootDomainEventsResponse =
  | {
      events: readonly CasRootRefEvent[];
      latestRevision: number;
      nextAfter: number;
    }
  | CasErrorResponse;
```

The two protocol packages use distinct operations:

```text
protocol-cas:       updateRootRefs
protocol-cas-admin: listRootDomainRefs, listRootDomainEvents
```

The tenant route matcher never recognizes `/admin`. Remove `isPublicCasRoute()`
from `@unicas/protocol`; Gateway-owned policy matches a tenant `CasRoute`
and applies its own operation allowlist through a Gateway-specific helper such
as `isGatewayExposedCasRoute()`. Every tenant `CasRoute` variant carries
`stackId + tenantId`. The admin matcher recognizes only `/admin` resources and
never returns a tenant operation.

## Storage model

### Control-plane tables

Operator and stack-administration state lives in a dedicated `CAS_CONTROL_DB`
binding with separate migrations, access policy, backup, and audit retention
from tenant node data. Keeping both bindings in one deployable CAS service does
not couple their schemas or authorization paths.

```text
cas_operator_identities
  identity_issuer
  subject
  display_name
  email_for_display
  PRIMARY KEY (identity_issuer, subject)

cas_stacks
  stack_id
  display_name
  status
  created_at
  PRIMARY KEY (stack_id)

cas_stack_members
  stack_id
  identity_issuer
  subject
  PRIMARY KEY (stack_id, identity_issuer, subject)

cas_stack_issuer
  stack_id
  issuer
  audience
  status
  PRIMARY KEY (stack_id)
  UNIQUE (issuer)

cas_stack_issuer_keys
cas_control_audit_events
```

Email is mutable display metadata and never an ownership key. All membership
rows grant the same MVP administrator authority, and deleting the last member
is rejected. OIDC refresh/session material, if retained, is encrypted and
isolated from tenant data. Every control-plane mutation emits an append-only
control audit event; destructive resource changes use soft disable/retire
states where history or recovery requires them.

### Authoritative tables

`cas_nodes.root_ref_count` remains the only authoritative root count consumed
by core CAS behavior. Because current Cloudflare deployments share D1 and R2
bindings across the CAS worker, every tenant-owned storage key must include
the stable stack namespace. Durable Object serialization alone is not a
physical data-isolation boundary.

Existing authoritative keys become:

```text
cas_nodes
  PRIMARY KEY (stack_id, tenant_id, hash)

cas_edges
  PRIMARY KEY (stack_id, tenant_id, parent_hash, ordinal)
  INDEX (stack_id, tenant_id, child_hash)
```

`cas_root_ref_requests` remains part of the command/idempotency path. Migrate
its key to:

```text
(stack_id, tenant_id, ref_domain, request_id)
```

Store `payload_hash`, `revision`, and `applied_at`. Existing request rows need a
reserved migration domain so historical request IDs do not collide with new
domain-scoped requests.

### Audit tables

```text
cas_root_domain_events
  stack_id
  ref_domain
  revision
  tenant_id
  request_id
  payload_hash
  changes_json
  applied_at
  PRIMARY KEY (stack_id, ref_domain, revision)
  UNIQUE (stack_id, tenant_id, ref_domain, request_id)

cas_root_domain_refs
  stack_id
  ref_domain
  tenant_id
  hash
  ref_count
  PRIMARY KEY (stack_id, ref_domain, tenant_id, hash)

cas_root_domain_revisions
  stack_id
  ref_domain
  revision
  PRIMARY KEY (stack_id, ref_domain)
```

The stack-domain revision allocator is required because writes for different
tenants are serialized by different tenant DOs but share one ordered domain
event log. Revision allocation, aggregate mutation, event append, projection
update, and idempotency insert execute in one D1 transactional batch. The
allocator remains audit infrastructure and is not consumed by GC or node
lifecycle logic.

The concurrency and object namespaces become:

```text
Tenant CAS DO:       canonicalComposite(stackId, tenantId)
Root Ref domain DO:  canonicalComposite(stackId, refDomain)
R2 object key:       stacks/{stackId}/tenants/{tenantId}/nodes/{hash}
```

Do not build the DO name through ambiguous delimiter concatenation unless both
components are canonically encoded. The worker forwards verified `stackId` and
`tenantId` to the DO; the DO never accepts arbitrary identity headers from an
external caller.

Root Ref writes use a one-way two-level protocol:

1. The tenant DO holds its normal command queue, preventing GC, lease, or a
  second Root Ref command for that tenant from racing the update.
2. It sends one canonical command to the Root Ref domain DO selected by the
  verified `(stackId, refDomain)` and waits for completion. Domain DOs never
  call tenant DOs, so lock ordering cannot cycle.
3. The domain DO serializes writes from different tenants in that domain and
  executes one D1 transaction that checks idempotency, validates node
  existence/readiness and aggregate results, increments the revision row,
  updates aggregate counts, appends the tenant-bearing event, updates/deletes
  projection rows, and inserts the idempotency result.
4. Only retryable D1 transaction conflicts/transient failures retry the entire
  transaction with bounded exponential backoff and jitter. Validation and
  conflict responses are not retried. Exhaustion fails the command without a
  partial mutation.
5. If commit succeeds but the response is lost, retrying the same request ID
  traverses the same tenant/domain queues and returns the stored revision.

Different domains for one tenant are serialized by the tenant DO. The same
domain across tenants is serialized by the domain DO. Different domains and
different tenants may proceed concurrently. Tests must force each interleaving,
transaction failure point, response loss, and retry exhaustion.

`changes_json` stores the canonical, hash-sorted payload so event replay and
the idempotency hash use the same representation. Zero projection rows should
be deleted to bound current-balance scans.

Inside the domain DO, every successful update performs one atomic D1 unit:

1. Resolve `{ stackId, tenantId, refDomain }` from verified authorization and
  require stack and tenant equality with the path.
2. Canonicalize and hash the request payload.
3. Check domain-scoped idempotency.
4. Validate node readiness and aggregate count results.
5. Atomically allocate the next `(stackId, refDomain)` audit revision.
6. Update `cas_nodes.root_ref_count`.
7. Append one domain event.
8. Apply the same deltas to the domain projection, allowing negative results.
9. Record the idempotency result and revision.

Steps 3-9 commit together; the numbered separation describes logical checks,
not separately committed statements. A retry returns after the idempotency
check and performs no validation or mutation.

## Migration and compatibility

### Expand, migrate, cut over, contract

The stack-key migration is not an in-place primary-key rewrite. It uses a
versioned expand/migrate/contract sequence and one durable cutover record.
Before expansion, operators create and successfully restore-test D1/control
backups and capture an R2 inventory. Every phase records its schema/data
version, binary compatibility range, verification result, and rollback point.

1. **Expand:** create stack-aware v2 node, edge, idempotency, revision, event,
  and projection tables alongside the current tables. Deploy a compatibility
  binary that continues treating the old representation as authoritative for
  one configured legacy stack while shadow-writing v2. Keep static issuer,
  shared-key, owner, and legacy route behavior unchanged. Rolling back to the
  old binary is supported; v2 is disposable/rebuildable at this point.
2. **Migrate:** backfill D1 v2 deterministically and run a resumable copy-only
  R2 migration. Reconcile shadow writes until row counts, grouped counts,
  edge order, aggregate references, payload hashes, and object manifests
  match. No new stack receives tenant traffic.
3. **Cut over legacy stack:** briefly quiesce mutable CAS commands, apply the
  final delta, verify invariants, and atomically advance the durable cutover
  marker so the compatible binary reads v2. It continues writing the old
  representation during the rollback window. A rollback moves the marker
  back and deploys the previous compatible binary; it never attempts a schema
  downgrade.
4. **Close rollback window:** require telemetry showing no old client or route,
  complete another backup/restore test, and obtain operator approval. After
  this gate, old binaries are unsupported and recovery is forward-only or a
  tested backup restore.
5. **Contract and onboard:** stop old shadow writes/fallback reads, make stack
  keys required, disable static/shared-key and retired routes, and later drop
  old tables/objects. Only after contract may a second stack receive tenant
  traffic, because an old binary cannot isolate two stacks with the same
  textual tenant ID.

Every phase is idempotent and restartable. A failed verification pauses before
the marker advances; it never deletes the previous representation. Deployment
automation refuses a binary whose declared compatibility range excludes the
current cutover/schema version.

### Existing root assignments

The target model removes `cas_root_owners` and the root-assignment endpoint.
Before route removal, migrate every in-repo caller from `assignRoots()` to
explicit signed deltas with deterministic request IDs.

Current callers that use owner names to retain deltas/snapshots must instead
emit lifecycle changes:

- committing a retained delta/snapshot emits `+1` for its root hash;
- replacing a retained snapshot emits old `-1` and new `+1` atomically;
- truncating retained history emits the aggregated negative counts;
- deleting a session emits negative counts for all retained roots;
- retrying one lifecycle transition reuses its original request ID.

Do not mechanically translate every assignment to `+1`. The caller must know
whether the operation creates, replaces, or releases a logical root reference.

After all callers are migrated and deployed together:

- remove the `root-assignments` HTTP route and DO action;
- remove owner request/response types and client methods;
- stop writing `cas_root_owners`;
- drop `cas_root_owners` only in a later schema migration after verifying no
  compatibility deployment still reads it.

During compatibility, the owner table may be read only by an explicit
migration/verification procedure. After the final compatibility deployment,
no request-handling path may read or write it. Remove the DO action, worker
route, fresh-schema table/index creation, and tests that require owner storage
before scheduling the later physical table drop. Deployment verification must
show that every active binary version uses signed Root Refs deltas and that no
supported rollback binary requires `cas_root_owners`.

### Audit baseline

Pre-existing aggregate counts have no reliable domain attribution. Migration
must not fabricate one.

At cutover, create audit baseline balances and events under a reserved,
non-callable domain such as `_legacy` for every positive existing
`root_ref_count`. This preserves the diagnostic equality:

```text
aggregate root_ref_count == sum of all audit domain balances
```

Subsequent releases attributed to a real domain may make that domain negative
while `_legacy` remains positive. That is expected until business systems run
an explicit reconciliation. `_legacy` cannot be selected by a normal token.

If the deployment can authoritatively reconstruct per-domain balances before
cutover, it may seed those balances instead, but this is an operational import
with validation and rollback, not an inference from owner strings.

The baseline uses the normal event schema. Process tenants in canonical tenant
order and hashes in canonical hash order, splitting each tenant into
deterministic batches of at most 1000 hash changes. Request IDs derive from the
migration version, stack, tenant, and tenant-local batch ordinal. Allocate the
stack-level `_legacy` revisions in that deterministic global batch order and
persist the corresponding payload hashes. Rerunning the migration must match
the same request IDs and payloads, append no duplicate events, and leave
aggregate counts untouched. A stack with no positive root counts creates no
baseline event and its `_legacy` domain begins at revision zero.

### Existing stackless data

Current D1 rows and R2 keys contain no stack identity. Migration assigns them
only to one operator-configured legacy `stackId` representing the deployment
that created the data; it must not infer stack identity from tenant IDs,
owner strings, or request payloads.

The schema migration builds versioned stack-aware tables for every tenant-keyed
authoritative table, including `cas_nodes`, `cas_edges`, and
`cas_root_ref_requests`. Compatibility owner rows are scoped to the configured
legacy stack while they remain readable. Existing R2 objects move from both
known historical forms, `users/{tenantId}/nodes/{hash}` and
`tenants/{tenantId}/nodes/{hash}`, to
`stacks/{stackId}/tenants/{tenantId}/nodes/{hash}`.

The R2 migration writes an immutable manifest containing source/destination
keys, tenant/hash, size, ETag where available, expected canonical hash, status,
attempt count, and last error. Workers copy but never delete in the migration
phase, then verify destination existence, length, and canonical content digest
before marking an object complete. Progress is resumable and idempotent; abort
leaves source objects untouched. Metrics expose total, copied, verified,
failed, and remaining objects. Old objects are deleted only in a separate
post-contract retention job after manifest completeness and sampled/full
integrity checks pass.

Only the configured legacy stack may temporarily fall back to old stackless R2
keys. A request authenticated for another stack must never probe a stackless
key, because that would turn compatibility behavior into cross-stack data
exposure. Fallback is controlled by the durable cutover marker, instrumented,
and removed before another stack receives traffic.

### Route compatibility

The canonical write route is the stack-and-tenant-prefixed CAS service route:

```text
/stacks/{stackId}/tenants/{tenantId}/root-refs
```

Do not add audit reads to legacy tenant-header-only routes. The shared legacy
credential cannot distinguish Azure and Cloudflare and therefore cannot be
used after multi-stack activation. During expand/migrate/cutover it is accepted
only for the one configured legacy stack and one server-configured migration
domain; caller headers/body cannot select stack or domain. All writers must
move to tenant capabilities before the rollback window closes.

Remove both tenant-prefixed and tenant-header-only portable-node routes without
a replacement endpoint. There is no in-repository caller to migrate. Before
deployment, verify service inventory and route telemetry do not reveal an
external consumer; that operational check does not create a compatibility API
or change the target removal state.

The audit routes have no legacy compatibility form. Root assignment and
portable-node routes remain only as rollback compatibility during the explicit
window and are disabled in contract after caller/service inventory and route
telemetry are zero for the full window.

## Reconciliation workflow

Reconciliation is an operator-assisted workflow; ordinary business-service
credentials cannot browse CAS domain audit data:

1. An authorized operator reads the target domain balance pages at one revision.
2. The business domain independently computes intended `hash -> count` from
  its storage.
3. The operator compares intended and CAS-recorded balances.
4. The operator inspects events after a previously saved revision to locate
  missing, duplicated, or incorrect business operations.
5. The business domain submits an explicit compensating Root Refs update
  through the normal write API with a new deterministic repair request ID.
6. The operator re-reads the domain balance and saves the resulting revision.

CAS does not offer a `PUT` that replaces a domain balance wholesale in this
plan. Such an endpoint could accidentally convert audit state into ownership
state and bypass normal business-operation history.

## Operational readiness gates

The initial production objectives are explicit launch gates, not aspirational
follow-up work:

- tenant data-plane monthly availability SLO: `99.9%`; admin plane: `99.5%`,
  excluding caller 4xx and declared maintenance;
- authority key revocation propagation: at most 60 seconds;
- control/tenant metadata backup RPO: at most 15 minutes and RTO: at most 4
  hours; immutable content disaster-backup RPO: at most 24 hours and RTO: at
  most 8 hours;
- successful restore of control DB, tenant D1, and an R2 manifest/content sample
  before launch and at least quarterly thereafter;
- control audit retention: at least 365 days; Root Ref idempotency/events:
  indefinite until a later checkpoint/retention protocol is implemented;
- load test at two times the documented first-year peak request, Root Ref
  mutation, object-count, and byte-throughput forecast for one hour without
  invariant failures or SLO breach;
- explicit configurable limits for node bytes, child refs, Root Ref batch size,
  tenant requests/mutations, admin reads/mutations, session creation, and OIDC
  callback attempts; limit responses use `429 RATE_LIMITED` and are observable;
- alert ownership and runbooks for 5xx rate above 1% for 5 minutes, D1/R2/DO
  errors, domain-DO queue latency, auth-registry stale/fail-closed events,
  backup/restore failures, audit projection mismatch, R2 migration failures,
  and GC/reference-count invariant violations;
- key-compromise, stack suspension, owner recovery, migration pause/abort,
  forward recovery, and backup restore procedures exercised before launch.

Migration automatically pauses before cutover on any aggregate/audit mismatch,
unverified R2 object, failed backup/restore gate, unknown active client, error
budget burn above the alert threshold, or unresolved security finding. Exact
forecast numbers, alert destinations, and named on-call owners are recorded in
the deployment runbook and reviewed at go-live.

## File map

| Path | Planned change |
|---|---|
| `unicas-packages/edge/` | Add the public custom-domain Worker that dispatches only `/stacks` and `/admin` to private service bindings |
| `unicas-packages/protocol-admin/` | Add top-level `/admin` contracts, route matcher, stable errors, and pagination types without tenant data-plane operations |
| `unicas-packages/control-plane/` | Add cloud-neutral administrator identity, equal membership, single issuer/multi-key, domain, and control-audit service library |
| `unicas-packages/admin-webui/` | Add the `/admin` OIDC/BFF and stack administration WebUI as a separate deployable artifact in the monorepo |
| `packages/{cas-edge,protocol-cas-admin,cas-control-plane,cas-admin-webui}/package.json` | Add workspace names, build/typecheck/test/clean scripts, explicit dependencies, and private/publish settings |
| `packages/{cas-edge,protocol-cas-admin,cas-control-plane,cas-admin-webui}/tsconfig.json` | Add composite TypeScript project configuration and root project references |
| `unicas-packages/protocol/src/types.ts` | Remove assignment types; add balance/event domain types; update `TenantCasService` |
| `unicas-packages/protocol/src/http.ts` | Add stack-scoped tenant paths; split update contracts; remove admin and retired contracts |
| `unicas-packages/protocol/src/routes.ts` | Match only stack-and-tenant service routes; remove admin, retired routes, and Gateway exposure policy |
| `unicas-packages/protocol/src/index.ts` | Remove retired exports and publish the target contracts |
| `unicas-packages/protocol/tests/routes.test.ts` | Cover service and operator routes; remove portable-node and Gateway-policy assertions |
| `packages/protocol-gateway/src/index.ts` | Own the Gateway-exposed CAS operation allowlist |
| `packages/gateway-common/src/gateway-handler.ts` | Apply injected Gateway CAS exposure policy after route matching |
| `unicas-packages/client/src/index.ts` | Add `stackId`, update the write route, and remove assignment/read emulation |
| `unicas-packages/client/tests/cas-client.test.ts` | Verify stack-scoped URLs, responses, auth, and retries |
| `packages/cloudflare-cas/src/worker.ts` | Host the private tenant data plane and audit-reader RPC, verify stack JWTs, dispatch tenant operations, and remove retired routes |
| `packages/cloudflare-cas/src/cas/routes.ts` | Partition tenant commands by stack and tenant; forward Root Refs operations |
| `packages/cloudflare-cas/src/cas/do.ts` | Use stack-scoped D1/R2 keys, implement Root Ref operations, and remove retired handlers |
| `packages/cloudflare-cas/src/cas/schema.ts` | Add `stack_id` to tenant keys and stack-domain audit schema; migrate idempotency; retire owner schema |
| `unicas-packages/edge/wrangler.toml` | Own custom-domain routes and bind private `CAS_TENANT_SERVICE` and `CAS_ADMIN_SERVICE` Workers |
| `packages/cloudflare-cas/wrangler.toml` | Provision private tenant D1/R2/DO, domain DO, read-only authority repository, audit-reader RPC, compatibility, and deployment settings |
| `packages/cloudflare-cas/tests/` | Add cross-stack isolation, migration, and ledger coverage; remove retired API tests |
| `packages/cloudflare-sdk/src/editor-do-svalue.ts` | Replace owner assignments with explicit acquire/release deltas |
| `packages/doctype-server-common/src/` | Preserve exact root lifecycle and rollback behavior for shared Doc runtimes |
| `packages/service-auth/src/claims.ts` | Add and validate tenant, permission, and Root Refs domain claims |
| `packages/service-auth/src/issuer.ts` | Validate domain claims and issue generic stack-authority CAS capabilities |
| `packages/service-auth/src/verifier.ts` | Verify tenant JWT capabilities and preserve stack, tenant, and domain context |
| `unicas-packages/admin-webui/src/server/` | Implement Google OIDC callback, secure session, CSRF, `/admin` BFF routes, and control-plane service calls |
| `unicas-packages/admin-webui/src/ui/` | Implement stack list/detail, members, issuer keys, observed domains, Root Ref audit, control audit, and usage views |
| `unicas-packages/admin-webui/wrangler.toml` | Provision `CAS_CONTROL_DB`, OIDC/session secrets, private audit-reader binding, and control-plane deployment settings |
| `packages/gateway-common/src/capability-authority.ts` | Adapt the current central issuer to the generic stack-authority contract |
| `packages/gateway-common/src/capability-policy.ts` | Define Root Refs write delegation and separate operator audit permission |
| `packages/doctype-server-common/src/doc-type-handler.ts` | Carry the delegated CAS capability through the request-bounded Doc operation |
| `packages/azure-sdk/src/doc-type-service.ts` | Replace shared-key CAS calls with stack-scoped tenant capabilities to the middleware endpoint |
| `packages/azure-gateway/src/main.ts` | Map Azure ingress policy to the independently deployed CAS service without owning CAS trust policy |
| `packages/cloudflare-{gateway,markdown,docx,psd}/wrangler.toml` | Replace shared-key-only CAS wiring with endpoint, stack, audience, and capability configuration |
| `stacks/cloudflare/local/doc-types.mjs` | Configure local middleware, both auth planes, stack registrations, routes, and failure injection |
| `stacks/cloudflare/deploy/` | Provision the independent CAS deployment and control-plane bindings before application stacks |
| `stacks/azure/deploy/deploy.mjs` | Register/configure the Azure stack and remove cross-provider shared-secret alignment |
| `stacks/azure/deploy/{service,gateway,container-app}.bicep` | Project CAS endpoint, stack identity, audiences, and capability configuration into Azure runtimes |
| `tests/integration/` | Cover self-service registration, issuer/key rotation, independent deployment, and Azure/Cloudflare stack onboarding |
| `docs/cas-architecture.md` | Document the ledger and remove portable-node HTTP API guidance |
| `docs/microservice-architecture.md` | Replace live owner/shared-key/embedded-CAS guidance with middleware topology and mark historical behavior |
| `docs/capability-key-operations.md` | Document dynamic issuer registry, key states, cache/revocation behavior, and legacy static-config retirement |
| `scripts/check-cas-contract-docs.mjs` | Fail CI when retired live contracts reappear outside explicitly marked history/migration sections |
| `docs/superpowers/plans/2026-08-21-svalue-sblob-document-protocol.md` | Remove the unimplemented portable-node caller assumption |
| `docs/superpowers/plans/2026-08-25-gateway-issued-capability-authorization.md` | Reconcile superseded root-owner and portable-node contracts |

## Implementation tasks

### Task 1: Freeze middleware and control-plane contracts

- [x] Add `@unicas/protocol-admin` request/response contracts for administrator identity,
  stack registration/listing, membership, one tenant issuer and its keys,
  domains, stack metadata, and control audit.
- [x] Define immutable IDs, lifecycle states, pagination, optimistic
  concurrency, idempotency, and stable error codes for every mutation.
- [x] Freeze equal membership semantics, last-member protection, and management
  transfer through add-member then remove-member.
- [x] Define the platform-operator plane separately from stack ownership;
  stack members cannot grant platform suspension/recovery powers.
- [x] Threat-model OIDC account linking, stack takeover, issuer/JWKS
  substitution, key rotation, confused-deputy paths, WebUI CSRF/session
  theft, and control-audit tampering.
- [x] Prove `/admin` routes are absent from `@unicas/protocol`, tenant
  clients, and the tenant/public CAS proxy; the admin protocol has its own
  matcher and authentication middleware.
- [x] Add package manifests, composite tsconfigs/root references,
  build/typecheck/test/clean scripts, Wrangler compatibility/environment
  configuration, and dependency-boundary tests for all four new packages.
- [x] Enforce dependency direction:
  `cas-admin-webui -> protocol-cas-admin + cas-control-plane`,
  `cas-control-plane -> protocol-cas-admin`, and no dependency from either
  admin package to tenant worker/DO implementation modules.

**Focused validation:** control-plane protocol typecheck and contract tests,
including authorization matrices and negative cross-plane fixtures.

### Task 2: Implement self-service stack control plane

- [x] Implement Google OIDC login through a BFF/session boundary and persist
  immutable `(iss, sub)` identities; keep email as display metadata only.
- [x] Implement self-service stack creation with CAS-generated `stackId`,
  initial membership, stack listing, metadata updates, equal member
  management, last-member rejection, and management transfer.
- [x] Add dedicated `CAS_CONTROL_DB` schema/migrations and append-only control
  audit for every identity/configuration mutation. (Backup/retention policies
  are deployment concerns recorded for Task 9.)
- [x] Implement one tenant issuer/JWKS definition per stack, proof of key possession,
  overlapping rotation, disable/revoke, and controlled JWKS refresh. (Registry
  side complete, including registry-derived JWKS assembly; tenant-side
  verifier caching/refresh lands with Task 4 authorization.)
- [x] Implement registered `refDomain` lifecycle: `active`, `write_disabled`,
  and `retired`; retirement preserves all historical audit data.
- [x] Create `unicas-packages/admin-webui` as a separately deployable package with
  `src/server` for Google OIDC callback, encrypted/rotatable session state,
  CSRF/origin checks, `/admin` BFF handlers, and control-plane calls.
- [x] Build `src/ui` views for My Stacks, stack overview, members, issuer keys,
  reference domains, Root Ref balances/events, control audit, and usage.
  The first screen is the working stack console, not a marketing landing
  page. (Root Ref audit and usage views render documented not-available
  states until Tasks 5–7 wire their data paths.)
- [x] Implement loading, empty, permission/session-expired, validation,
  optimistic-concurrency, key-rotation, retired-domain, and audit pagination
  states across desktop and mobile layouts.
- [x] Prove browser code cannot access Google client secret/session signing
  material, tenant JWTs, D1/R2 bindings, or bypass BFF membership checks.

**Focused validation:** control-plane service, Google OIDC/BFF session,
membership, issuer/key rotation, domain lifecycle, control-audit, and
`cas-admin-webui` component tests. (Playwright integration tests are deferred
to the deploy task by operator decision; jsdom component + BFF handler tests
cover the same states this task's scope requires.)

### Task 3: Freeze tenant and admin CAS protocol behavior

> **Approach (operator-approved):** the canonical `@unicas/protocol` is
> frozen to the stack-scoped protocol; the pre-stack tenant surface is
> quarantined verbatim in the migration-only `@unicas/protocol-legacy`
> package, consumed only by the legacy runtime packages (cloudflare-cas,
> cas-client, gateways) until Task 9/10 retire them. A new
> `@unicas/server-cloudflare` package hosts the canonical stack protocol
> implementation (Tasks 4–7 land there); the old runtime keeps serving
> unchanged during the compatibility window.

- [x] Add failing route tests for POST
  `/stacks/{stackId}/tenants/{tenantId}/root-refs` and GET domain
  refs/events under `/admin/stacks/{stackId}/root-ref-domains/{refDomain}`.
- [x] Add `CasStackPath`, make every tenant/node path stack-scoped, and prove
  every tenant service route carries `stackId + tenantId`.
- [x] Make top-level path dispatch select authentication middleware before
  resource matching: `/admin` uses OIDC BFF session/membership; `/stacks`
  uses tenant JWT verification. (Matchers are disjoint and the admin session
  plane is enforced; the `/stacks` tenant-JWT verification itself is Task 4
  worker authorization on `cas-server-cloudflare`.)
- [x] Add response/request type tests or compile fixtures for update, balance,
      event, cursor, and revision contracts.
- [x] Remove `isPublicCasRoute()` from `@unicas/protocol`; move the
      Gateway-exposed CAS operation allowlist into Gateway-owned policy.
- [x] Prove the current Gateway policy excludes Root Refs writes and all CAS
      audit operations without treating that exclusion as a CAS route property.
- [x] Keep `cas-admin-webui` admin ingress separate from the public CAS proxy
  and prove it owns `/admin` while tenant/public proxies cannot reach it.
- [x] Remove assignment protocol types, routes, contracts, and exports.
- [x] Remove portable-node constants, request/response contracts, endpoint
  entries, route operations, builder, exports, and protocol route tests.
- [x] Use explicit `updateRootRefs`, `listRootDomainRefs`, and
  `listRootDomainEvents` operation names.

**Focused validation:**

```text
pnpm --filter @unicas/protocol test
pnpm --filter @unicas/protocol typecheck
pnpm --filter @unicas/protocol-admin test
pnpm --filter @unicas/protocol-admin typecheck
pnpm --filter @unidocs/protocol-gateway test
```

All green, plus repo-wide typecheck, the workspace dependency guard (160), and
a full local-runtime smoke (gateway → CAS proxy, doc worker, admin BFF) with
the legacy surface untouched.

### Task 4: Add trusted stack and domain authorization

- [x] Add tenant JWT issuer configuration mapping `(iss, kid)` verification to a
  stable `stackId`, expected CAS audience, allowed algorithms, and
  registered `refDomain` values. Enforce one unique issuer per stack and
  multiple rotation keys selected by `kid`.
- [x] Select issuer and key only from static or controlled configuration; never
  trust or dynamically fetch an issuer or JWKS URL supplied by the token.
- [x] Extend capability claim/input types, central stack-authority adapters,
  service-to-CAS delegation, `CasClient` configuration, CAS worker, and DO
  forwarding with stack, tenant, and signed `refDomain` context. (Claims,
  issuer, verifier, and the canonical worker are done; the legacy-surface
  `CasClient`/delegation/DO forwarding migrated in Task 8/9 — stack mode is
  now the default and the client/DO routes are canonical.)
- [x] Remove Gateway/doc subject-prefix interpretation from CAS; treat `sub` as
  opaque audit identity and authorize only verified issuer/stack, tenant,
  exact operation permission, and domain claims. (Canonical worker; the
  legacy runtime keeps its checks until Task 10 retires it.)
- [x] Replace tenant `cas:admin` with `cas:usage:read` and `cas:gc:trigger` and
  encode exact permission matrices in protocol/policy tests.
- [x] Implement the controlled authority-repository lookup, 30-second cache,
  60-second hard stale/revocation bound, fail-closed behavior, telemetry,
  and static-config bootstrap/cutover described above.
- [x] Keep tenant JWT verification unavailable to `/admin`; admin OIDC
      session/membership verification is implemented only by
      `cas-admin-webui` and `cas-control-plane`.
- [x] Add a validated `refDomain` claim to the CAS capability shape used by
  Root Refs writes.
- [x] Register stable domain names at capability issuance; do not derive them
      from instance IDs or caller input. (Registry + worker enforce
      registration; the gateway's per-doc-type domain issuance is wired in
      stack mode — it signs delegated CAS capabilities with the registered
      `refDomain` claim.)
- [x] Update Cloudflare SDK and applicable Azure/other runtime adapters to
  forward the request-bounded delegated capability for Root Refs instead of
  using `CAS_ACCESS_KEY` as the only credential. (Stack mode is the default:
  SDK/doc workers forward `X-UniDocs-CAS-Capability`; `CAS_ACCESS_KEY` is
  only a compatibility binding.)
- [x] Require issuer-derived stack equality and token tenant equality on every
  tenant service route.
- [x] Keep ordinary `cas:write` credentials from selecting or reading audit
      domains; audit domain selection is restricted to operator credentials.
- [x] Reject missing, unknown, reserved, or caller-overridden domains on the
      write path. Permit authorized operators to inspect reserved audit domains
      such as `_legacy`.
- [x] Add confused-deputy tests proving a writer cannot attribute changes to
      another domain and cannot gain audit access through its write capability.
- [x] Prove tenant JWTs are rejected by `/admin` regardless of claims, and OIDC
      admin sessions are rejected by tenant routes regardless of membership.
- [x] Add tests proving two trusted stacks may use the same `tenantId` without
  sharing nodes, counts, idempotency, audit records, leases, usage, or GC.
  (Authorization-level isolation is proven now; storage-level isolation is
  proven by Task 5 stack-scoped keys/DO and live cross-stack probes.)
- [x] Reject unknown issuers, unknown `kid`, wrong audience, path-stack
  mismatch, tenant mismatch, disallowed domains, and reserved write domains
  before any DO, D1, or R2 access.

**Focused validation:** service-auth (68), `cas-server-cloudflare` stack
authorization (15: matrix, fail-closed, cache/stale bound, static bootstrap,
cross-stack, confused-deputy, worker end-to-end), `cas-control-plane`
authority repository (38), gateway-common policy suites (45), repo-wide
typecheck, dependency guard (160).

### Task 5: Add audit schema and baseline migration

> **Option A remap:** the stack-scoped target schema, audit tables, DO
> partitioning, `_legacy` baseline, R2 migration, and cutover machinery land
> in `cas-server-cloudflare` (the canonical server) as its fresh target
> schema. The legacy runtime was retired on 2026-08-26 (its package deleted
> and the local runtimes reduced to stack mode only), so the in-place
> v1→v2 shadow-write/dual-write phases are eliminated; historical data moves
> through the R2 copy job + `_legacy` baseline instead. Focused validation
> remaps from `cloudflare-cas` to `cas-server-cloudflare` (the legacy
> runtime's schema tests were removed with the retired package).

- [x] Add versioned stack-aware tables alongside every tenant-owned current
      table; do not rewrite primary keys in place. Add the durable
      schema/cutover compatibility record.
- [x] Implement legacy-authoritative shadow writes, deterministic backfill,
      v2-read cutover, rollback-marker reversal, rollback-window dual writes,
      and post-window contract as separate idempotent migration phases.
      (Deterministic `_legacy` backfill, durable cutover marker with rollback
      reversal, and post-window contract are implemented; the in-place
      shadow/dual-write phases were eliminated by Option A — the legacy
      runtime retired on 2026-08-26 rather than evolving.)
- [x] Partition Durable Objects by canonical `(stackId, tenantId)` and move R2
  objects to `stacks/{stackId}/tenants/{tenantId}/nodes/{hash}`.
- [x] Add domain event, domain projection, and required stack-domain revision
  allocator schema.
- [x] Migrate idempotency keys to include `stack_id` and `ref_domain` and store
  revision. (Fresh schema with the target key + payload_hash/revision/
  applied_at; no historical rows to migrate under Option A.)
- [x] Add the reserved `_legacy` baseline migration for existing aggregate
      counts without changing those aggregate counts.
- [x] Make migrations idempotent and safe for partially upgraded local/test
      databases.
- [x] Require one configured legacy `stackId` for stackless data; never infer
  stack from tenant IDs or owner/request strings.
- [x] Build the immutable R2 migration manifest and resumable copy-only,
  length/digest verification, metrics, abort/restart, cutover fallback, and
  post-contract deletion jobs for both historical key formats.
- [x] Restrict temporary stackless R2 fallback to that legacy stack and the
  durable cutover phase; verify manifest completeness before deleting old
  objects or fallback code.
- [x] Keep `cas_root_owners` readable during the compatibility phase but stop
      treating it as the target model. (The legacy runtime keeps its owner
      table untouched; the canonical schema has no owner table.)
- [x] Test fresh schema, old `user_id` schema, current stackless tenant schema,
  every phase/rollback point, partially completed reruns, R2 copy/cutover,
  baseline totals, and the gate that blocks second-stack traffic until
  contract. (Fresh schema, phases, rollback, reruns, R2, baseline, and the
  gate are tested here; the legacy schema shapes remain covered by the
  unchanged `cloudflare-cas` schema tests.)

**Focused validation (remapped):** `pnpm --filter @unicas/server-cloudflare
test` (35: schema/cutover, DO names, `_legacy` baseline, R2 migration)
plus the unchanged `cloudflare-cas` schema suite; repo-wide typecheck and the
dependency guard (160).

### Task 6: Implement atomic update and audit writes

> **Option A remap:** the tenant CAS DO and the `RootRefDomainDurableObject`
> land in `cas-server-cloudflare` (canonical server); the legacy runtime keeps
> its own DO paths until Task 9/10. The other tenant node operations (read,
> lease, usage, GC) return 501 here until their storage dispatch follow-on.

- [x] Add `RootRefDomainDurableObject` keyed by canonical
  `(stackId, refDomain)` and enforce one-way tenant-DO-to-domain-DO calls.
- [x] Refactor `handleUpdateRootRefs()` around one canonical payload and one
  domain-DO D1 transaction/batch.
- [x] Scope idempotency to stack, tenant, and authenticated domain.
- [x] Return the original revision on idempotent retries.
- [x] Append exactly one event per newly accepted request.
- [x] Update the domain projection by the same deltas, allow negative domain
      balances, and remove zero rows.
- [x] Preserve aggregate non-negative, readiness, overflow, and all-or-nothing
      validation.
- [x] Prove audit write failure rolls back aggregate changes and idempotency.
- [x] Prove update validation and GC do not query audit tables.
- [x] Force same-domain/different-tenant, different-domain/same-tenant, and
  independent-writer interleavings; inject every transaction failure,
  response loss, retryable conflict, bounded-backoff exhaustion, and
  duplicate request path.

**Focused validation (remapped):** `cas-server-cloudflare` root-refs + DO
suites (54 total incl. auth/storage/migration); the legacy `cloudflare-cas`
DO root-ref/GC tests remain green unchanged.

### Task 7: Implement audit reads

> **Option A remap:** the audit-read repository and the private reader RPC land
> in `cas-server-cloudflare`; `cas-admin-webui` reads audit through the
> `CAS_TENANT_AUDIT_READER` binding (wired at deployment in Task 9). The RPC
> path `/_internal/audit/*` is never matched by the tenant matcher and never
> dispatched by cas-edge.

- [x] Implement `(tenantId, hash)`-ordered, bounded current-balance pages for
  the operator-selected stack domain, with optional exact `tenantId`
  filtering and `tenantId` in every row.
- [x] Bind cursors to a revision and reject mixed-revision pagination.
- [x] Implement current-projection revision-before/query/revision-after guards;
  do not imply historical projection snapshots or replay.
- [x] Implement per-`(stackId, refDomain)` monotonic revisions, default/max
  limits of 200/1000, versioned opaque cursors bound to the optional tenant
  filter, non-negative safe-integer `after`, and the specified
  `400`/`409 ROOT_REF_SNAPSHOT_CHANGED` errors.
- [x] Return positive and negative non-zero balances.
- [x] Implement stack-domain ordered event pages with `tenantId`, exclusive
  `after`, optional exact tenant filtering, bounded `limit`,
  `latestRevision`, and `nextAfter`.
- [x] Advance empty tenant-filtered pages to the consistently read
  stack-domain watermark so polling cannot stick on other tenants' events.
- [x] Ensure idempotent retries never duplicate events.
- [x] Reject cross-stack reads, missing stack membership, missing stacks,
  malformed domains, and cursor/path-domain/filter mismatches before audit
  database access.

**Focused validation:** `cas-admin-webui` BFF membership + audit pagination
(36 incl. reader RPC passthrough, membership gate, malformed/reserved
domains), `cas-server-cloudflare` audit-reads + reader-RPC suites (70), and
`cas-edge` boundary proving `/_internal` is never dispatched (3).

### Task 8: Migrate clients and business callers

- [x] Add stable `stackId` to `CasClient` configuration and update
  `updateRootRefs()` to use the canonical stack-and-tenant route and typed
  revision response. (Client surface done in Task 9 round 1: `stackId` config
  variants, canonical `/stacks/...` routes for every node op, typed
  `{success, idempotent, revision}` response. Stack mode is the default, so
  editors bind to the middleware worker via the canonical routes.)
- [x] Keep current-balance and event-log reads out of the ordinary `CasClient`;
  expose them only through `cas-admin-webui` BFF handlers after OIDC session
  and stack membership checks. (Wired at deployment: the private
  `CAS_TENANT_AUDIT_READER` binding + BFF handlers + membership gate are
  live; the audit-reader RPC is unreachable through cas-edge.)
- [x] Remove `CasClient.assignRoots()` and its incorrect assignment-to-`+1`
      compatibility conversion.
- [x] Convert SValue delta and snapshot retention to explicit acquire, replace,
      truncate, and delete deltas.
- [x] Enumerate every current assignment call, including pending-version
  recovery and `#ensureCurrentSnapshot()`. For each path, document the
  exact durable row transition that acquires, replaces, or releases delta
  and snapshot roots.
- [x] Preserve deterministic request IDs across retries and pending-outbox
      recovery.
- [x] Prove partially completed acquire/release operations recover to one
  logical application after restart without leaking or undercounting roots.
- [x] Preserve Doc rollback semantics when a root update fails.
- [x] Update local failure injection to recognize the canonical POST route.
      (Done: the fault worker intercepts both `/_internal/root-refs` and
      `/stacks/{stackId}/tenants/{tenantId}/root-refs`, and in stack mode it
      wraps the middleware instead of the legacy worker.)

**Focused validation:** CAS client, Cloudflare SDK, doctype-server-common, and
local integration tests covering commit, retry, rollback, truncation, snapshot
replacement, pending recovery, snapshot repair, clone, and session deletion.
Tests assert both aggregate counts and emitted domain deltas.

### Task 9: Deploy middleware and onboard UniDocs stacks

- [x] Produce the tenant CAS runtime and `cas-admin-webui` OIDC/BFF as
  independently versioned/deployable artifacts from the existing monorepo;
  both are routed under one CAS service domain by path. (wrangler.toml
  complete with real D1 ids, DO exports, private bindings, audit-reader
  binding, and the edge route; both backing workers are DEPLOYED and private.
  Live smoke through https://unicas.shazhou.work passes: lease/read/
  metadata/root-refs revision/usage/gc plus cross-stack 403 isolation.)
- [x] Deploy `cas-edge` as the only custom-domain Worker, bind private tenant
  and admin Workers, enforce prefix/header/cookie isolation, and expose
  independent edge/tenant/admin readiness checks. (Dispatch, header
  isolation, and readiness are implemented and proven end-to-end locally and
  LIVE: cas-edge serves unicas.shazhou.work/* with the tenant/admin service
  bindings, /health 200, /_internal/health 404, /admin 302/401.)
- [x] Expose a narrow private tenant audit-reader RPC to `cas-admin-webui`; prove
  it is unreachable through `cas-edge` and the service call graph is
  acyclic.
- [x] Publish/test the edge-tenant-admin compatibility version and deploy
  backing Workers first/edge second, with reverse-order rollback and
  retained prior Worker versions. (Deploy order followed: tenant → admin →
  edge, all versioned; wrangler retains prior versions for rollback. A live
  rollback+restore drill was executed 2026-08-26 on the admin worker:
  `wrangler rollback` moved traffic to the retained prior version, the BFF
  still answered correctly through the edge, and `wrangler deploy` restored
  the current version — reverse-order rollback across all three workers
  remains an ops-gate exercise, documented in `docs/cas-operations.md`.)
- [x] Provision the middleware endpoint, `CAS_CONTROL_DB`, tenant D1/R2/DO
  bindings, DNS/TLS, OIDC configuration, secrets, backups, observability,
  SLOs, alerts, and migration/rollback procedures independently of either
  application stack. (Endpoint, D1s, R2, DOs, DNS/TLS, real Google OIDC, and
  secrets are live. Backups were verified 2026-08-26 via live `d1 export`
  of both databases; the D1 export command, restore procedure, SLO table,
  alerting rules, deploy/rollback/rotation/compromise runbooks, and pending
  ops items are documented in `docs/cas-operations.md`. Remaining: a
  scheduled backup job, a throwaway-D1 destructive restore drill, alert
  delivery integration, and analytics/logpush consumption.)
- [~] Register stable `unidocs-cloudflare` and `unidocs-azure` stacks through
  the self-service control plane; configure equal administrator memberships,
  one tenant issuer plus rotation keys and audiences.
  (Both stacks are registered in the PRODUCTION CAS_CONTROL_DB via the
  bootstrap script — issuer and ES256 rotation key
  verified with d1 execute; the deployed tenant worker authorizes the
  provisioned cloudflare stack's capabilities. Console-based possession-proof
  registration and memberships land with the admin onboarding round.)
- [x] Migrate Cloudflare Workers from shared `CAS_ACCESS_KEY` service-binding
  calls to stack-scoped tenant capabilities against the middleware service.
  (Stack mode is implemented and green locally: the gateway signs delegated
  CAS capabilities with the registered `unidocs-cloudflare` stack key
  (carrying the refDomain claim), the editor DO routes canonical
  `/stacks/{stackId}/tenants/{tenantId}/...` to the middleware, and the
  markdown doc flow passes end-to-end. `startLocalMiddleware` wraps the
  standalone middleware for the dev command and the Azure round. The
  application-stack WRANGLER configs were rewritten to stack mode with real
  production values (stack issuer/kid/audience, CAS_SERVICE →
  `unidocs-cas-server-cloudflare`, `[exports.*]` DO declarations) and all
  four parse via `wrangler deploy --dry-run` — these are handed off as the
  deployable starting point. PRODUCTION DEPLOYMENT of the application stack
  (including the gateway's missing production identity/auth mechanism) is
  explicitly OUT OF SCOPE here: how the full UniDocs application stack is
  organized is a separate plan.)
- [x] Migrate Azure Gateway and document services from a manually aligned
  remote CAS URL/shared key to the registered Azure stack identity,
  capability issuance, and middleware endpoint. (Azure stack mode is green:
  `startAzureRuntime({ internalAuthMode: "stack" })` embeds the local
  middleware via `startLocalMiddleware` (registered `unidocs-azure`,
  independent ports so it coexists with `pnpm dev`), the azure gateway signs
  delegated/gateway CAS capabilities with the azure stack key (refDomain
  claim, canonical /stacks passthrough), and the azure doc services'
  CasClient carries stackId to the middleware. `azure-docx-image` (blob lease
  + retained root) and `azure-stack-mode` prove the storage path
  end-to-end; the transitional cf legacy-CAS dependency is gone. Full azure
  suite 29 green; also fixed Windows `run()` pnpm .cmd spawning and the
  cf-runtime default admin/cas port clashes with a running `pnpm dev`.)
- [x] Inventory provenance of current stackless CAS data. Assign it to exactly
  one configured legacy stack or perform an explicit validated import; do
  not duplicate ambiguous rows into both stacks. (No stackless data exists —
  the legacy runtime (`cloudflare-cas`) was never deployed, so there is
  nothing to inventory or import; the baseline/R2-migration/cutover machinery
  remains unit-tested for the `_legacy` path.)
- [x] Verify both stacks can use identical textual tenant IDs without sharing
  nodes, references, events, usage, GC, issuer keys, or memberships.
  (Proven at unit, local-e2e, and LIVE-deployed levels: a shared tenant id
  leases and reads only its own stack's nodes, usage counts per stack,
  cross-stack tokens are 403, and cross-stack GC never touches the other
  stack. Issuer keys and memberships are control-plane rows keyed per
  stack.)
- [x] Run compatibility-phase telemetry until no supported binary uses
  shared-key, tenantless, root-assignment, or portable-node routes; then
  disable those paths after the rollback window. (Retired EARLY on
  2026-08-26 by decision: the legacy runtime package `cloudflare-cas` was
  deleted and the local runtimes (Cloudflare + Azure) now support stack mode
  only, so the shared-key/tenantless/root-assignment/portable-node
  implementation surfaces are gone. `protocol-legacy` keeps the frozen
  contracts for the remaining legacy-compatible gateway/cas-client paths
  until the rollback window closes.)
- [~] Meet every operational-readiness gate: availability/load SLO, rate limits,
      revocation bound, backup/restore drill, migration pause criteria, alerts,
      runbooks, named ownership, and key-compromise exercise. (SLO table,
      alerting rules, deploy/rollback/backup/rotation/compromise runbooks are
      documented in `docs/cas-operations.md`; the backup export drill and a
      live issuer key-rotation drill ran 2026-08-26 (the latter surfaced and
      fixed the authority-cache hard-stale fail-closed defect, since
      redeployed). Remaining: scheduled backups, a destructive restore drill,
      alert delivery wiring, and analytics consumption.)

> **Handed off on 2026-08-26:** how the full UniDocs application stack is
> organized and deployed is a separate plan —
> `docs/superpowers/plans/2026-08-26-app-stack-organization-todo.md`.
> Handed items include the application-stack production identity/auth,
> deployment, independent deploy/rollback drills (former bullet 12), and
> package-organization decisions. This plan keeps only the independently
> deployable CAS middleware itself.

**Focused validation:** provision an isolated CAS environment, self-register
both UniDocs stacks, run Cloudflare and Azure integration suites against the
same middleware endpoint, rotate issuer keys, and verify cross-stack isolation
plus independent deployment/rollback.

### Task 10: Remove retired APIs

> The retired API *implementations* were removed on 2026-08-26 by deleting
> the legacy runtime package (`packages/cloudflare-cas`) along with the
> legacy/dual/capability local-runtime modes. What remains below is the
> original checklist; the frozen contracts still live in
> `@unicas/protocol-legacy` (consumed by the remaining legacy-compatible
> gateway/cas-client paths) and are removed when the rollback window closes.

- [x] Delete worker and DO `assignRoots` dispatch and implementation.
- [x] Delete all owner-assignment tests and replace their intended lifecycle
      coverage with signed-delta tests.
- [x] Delete `/_internal/nodes/{hash}` GET/POST dispatch, portable-node route
      forwarding, DO actions and handlers, and API-specific tests.
- [x] Keep canonical binary encode/parse/validation/digest helpers and their
      non-route tests; remove only symbols owned by the portable HTTP surface.
- [x] Verify no source, generated declaration, route, fixture, or document
      references `CasAssignRootsRequest`, `CasRootAssignment`,
      `rootAssignments`, `cas_root_owners`, `readPortableNode`,
      `leasePortableNode`, portable HTTP contract types, or
      `/_internal/nodes/{hash}` as a live API. (Legacy *implementation*
      references are gone with the deleted package; the frozen
      `@unicas/protocol-legacy` contract symbols remain by design until the
      rollback window closes.)
- [x] Stop creating the owner table on fresh databases. (The canonical
  stack-scoped schema has no owner table; the legacy runtime that created it
  was deleted.)
- [x] Schedule physical owner-table removal only after compatibility deployment
      verification; do not couple destructive cleanup to the API cutover.
      (No owner table exists in any deployed database — the legacy runtime
      was never deployed — so there is no physical table to remove.)

**Focused validation:** repository search plus protocol, CAS, client, and SDK
test suites.

### Task 11: Documentation and full validation

> Documentation delivered so far: `docs/cas-architecture.md` (canonical
> topology + stack dispatch), `docs/capability-key-operations.md` (stack-mode
> capability keys), `docs/cas-operations.md` (SLOs, alerts, runbooks), and
> the README package tree (`unicas-packages/` + `@unicas` org). The remaining
> items below are ongoing documentation maintenance (historical-plan
> amendments are intentionally left untouched as records) and the
> contract-docs CI script.

- [ ] Update `docs/cas-architecture.md` with the authoritative-vs-audit boundary,
  exact HTTP contracts, CAS-versus-Gateway API ownership, idempotency, and
  reconciliation flow.
- [ ] Document stack as the top-level namespace, issuer-to-stack mapping,
      tenant/refDomain orthogonality, native CAS versus ingress paths, shared
      storage keys, and stack migration.
- [ ] Amend plans that currently call owner assignments canonical so they point
      to this superseding decision rather than leaving contradictory guidance.
- [ ] Update `docs/microservice-architecture.md`,
  `docs/capability-key-operations.md`, deployment docs, integration plans,
  and historical plans; mark retained historical behavior explicitly as
  superseded/migration-only.
- [ ] Remove architecture and authorization-plan guidance that presents
  portable-node HTTP transport as a supported or planned API.
- [ ] Document that audit balances are CAS-recorded history, not guaranteed
      business truth.
- [ ] Add `scripts/check-cas-contract-docs.mjs` to CI so retired owner,
  portable-route, shared-key, tenantless, and stale admin-route guidance is
  rejected outside marked historical/migration sections.
- [x] Run package typechecks and unit tests, then local integration tests.
      (2026-08-26: `pnpm typecheck`, `pnpm test` (workspace), `pnpm test:local`
      (368: unit + Cloudflare integration + shared), `pnpm test:azure` (17),
      and the dependency guard (155) all green; the live edge smoke passes
      twice 70 s apart.)

**Full validation:**

```text
pnpm typecheck
pnpm test
pnpm test:local
```

## Deferred beyond MVP

- stack-scoped automation credentials and CI/CD admin access tokens;
- control-plane roles or per-member grants beyond equal membership;
- multiple tenant issuer identities per stack and online issuer-ID migration;
- additional OIDC identity providers beyond Google;
- editable quota policy and quota-management UI beyond read-only usage;
- platform billing and marketplace integration.

These are explicit future protocol changes. The MVP schema and API do not
pretend to implement them through hidden optional fields.

## Acceptance criteria

- CAS is deployed and operated as a service independent of any UniDocs
  application stack, with its own endpoint, storage, control plane, WebUI,
  release lifecycle, observability, backup, and incident procedures.
- Azure and Cloudflare UniDocs deployments are registered as distinct stacks
  and consume the same CAS middleware deployment without sharing stack-scoped
  state or credentials.
- Administrators can sign in through Google OIDC, list only stacks they belong
  to, self-register a stack, add/remove equal members, and transfer management
  without using tenant identities. Deleting the final member is rejected.
- Authorized stack members can configure the stack's single tenant issuer,
  rotate its multiple keys, retire domains, inspect Root Ref audit, and inspect
  immutable control-plane audit; every mutation records its actor and target.
- Stack members cannot grant themselves CAS platform-operator powers, and
  platform operations do not silently impersonate stack owners.
- CAS source remains in the UniDocs pnpm monorepo, while build artifacts and
  runtime dependencies preserve independent deployment and operations.
- `cas-edge` is the only public Worker and dispatches `/stacks` and `/admin`
  through separate private bindings; prefix/header/cookie isolation, acyclic
  audit-reader RPC, and edge/tenant/admin versioned deployment/rollback are
  tested.
- `cas-edge`, `protocol-cas-admin`, `cas-control-plane`, and `cas-admin-webui` have complete
  package/build/test/deployment registration and obey the declared dependency
  direction.
- Tenant service routes use `/stacks/{stackId}/tenants/{tenantId}/...`; all
  control-plane routes use top-level `/admin/...`. Native CAS routes do not
  repeat a `/cas` ingress mount.
- CAS trusts configured issuers and keys, maps verified `iss` to stable
  `stackId`, and knows no Gateway-specific authentication concept.
- Exactly one globally unique issuer maps to each stack; multiple `kid` keys
  rotate without downtime. Registry caching fails closed after 60 seconds and
  key revocation reaches tenant verification within that bound.
- Tenant routes accept only stack-issuer JWT capabilities for the CAS data
  plane. Admin routes accept only Google OIDC-backed BFF sessions and stack
  membership; each authentication plane rejects the other credential class.
- `unicas-packages/admin-webui` is independently deployable, owns the `/admin`
  OIDC/BFF boundary and management UI, and exposes no Google secret, session
  signing material, tenant JWT, or storage binding to browser code.
- Control-plane creates are idempotent, mutable resources require ETag
  preconditions, invitation acceptance binds immutable OIDC identity, final
  membership cannot be deleted, and every mutation commits its control-audit
  event atomically.
- Stack, tenant, and domain remain structured dimensions; no persistent or
  protocol identity is encoded as an `issuer:domain` string.
- Two stacks with the same `tenantId` are isolated across DO, D1, R2, nodes,
  references, leases, usage, GC, idempotency, and audit data.
- Only signed `hash -> delta` updates can change root counts.
- No production API or schema concept models individual logical root refs or
  owners.
- Every newly accepted update has exactly one domain event and an updated
  domain projection in the same commit.
- Tenant and Root Ref domain DO lock ordering is one-way and deadlock-free; all
  aggregate, revision, event, projection, and idempotency changes survive or
  roll back as one D1 transaction under forced concurrency/failure tests.
- Audit revisions are monotonic per `(stackId, refDomain)`; every event and
  balance row records the affected `tenantId`.
- Idempotent retries create no duplicate count change or event.
- Balance pagination never mixes revisions: current-projection pages use the
  before/after guard and stale cursors return `ROOT_REF_SNAPSHOT_CHANGED`.
  Tenant-filtered event polling advances across nonmatching tenant events.
- Ordinary business-service credentials cannot browse domain audit data;
  authorized operators can select a domain and read its CAS-recorded balance
  and ordered history, including reserved migration domains.
- Aggregate counts may never become negative; audit domain balances may.
- GC and all node lifecycle decisions operate correctly if audit reads are
  unavailable and never query audit tables.
- Existing aggregate counts survive migration unchanged and receive an
  explicit non-callable audit baseline.
- Stack migration passes expand/backfill/cutover/rollback/contract gates, R2
  manifest verification and restore drills. A second stack receives no tenant
  traffic until stackless fallback and old-binary rollback support are closed.
- `rootAssignments` and its client emulation are removed after callers emit
  complete lifecycle deltas.
- Portable-node HTTP routes, contracts, handlers, exports, and API-specific
  tests are removed without replacement; shared canonical binary utilities
  remain as an independently specified codec, with digest construction still
  used by non-route consumers.
- Root Refs write and audit routes are complete CAS contracts independent of
  deployment topology. Gateway owns their exposure policy, and its current
  allowlist exposes neither operation class.
- All operational-readiness SLO, RPO/RTO, load, rate-limit, alert, runbook,
  key-compromise, migration-pause, and named-ownership gates pass before
  production traffic is enabled.