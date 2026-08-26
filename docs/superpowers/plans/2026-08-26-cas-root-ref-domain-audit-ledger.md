# CAS Root Reference Domain Audit Ledger Implementation Plan

> **Status:** Proposed. This plan records the agreed target behavior; no
> implementation tasks are complete.
>
> **For agentic workers:** Implement one task at a time and keep the checkboxes
> current. Do not reintroduce owner/ref assignment semantics while migrating
> callers. Coordinate the authorization changes with
> `2026-08-25-gateway-issued-capability-authorization.md`.

**Goal:** Replace the two competing CAS root APIs with one signed-count Root
Refs service API, add operator-facing domain balance and event-log reads for
audit/reconciliation, remove root-owner assignments from the CAS model, and
delete the unused portable-node HTTP surface.

**Architecture:** CAS uses a stable `stackId` as its top-level trust and data
namespace. Within a stack, `tenantId` identifies data ownership and
`refDomain` independently identifies Root Ref audit attribution. The
authoritative CAS lifecycle state remains the `(stackId, tenantId)`-scoped
aggregate `root_ref_count` on each node. CAS maps a validated JWT issuer to its
configured `stackId`, takes `refDomain` from the signed capability, and
atomically writes an append-only domain event plus a domain balance projection
with every successful aggregate count update. The domain tables are audit data
only: root validation, leasing, GC, and repair must never consume them as
authoritative state.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, D1, R2,
stack-issued JWT capability tokens, Vitest.

## Scope

This plan covers:

- the `@unidocs/protocol-cas` Root Refs HTTP contracts and route matcher;
- CAS client write methods and separate operator audit tooling;
- Cloudflare CAS routing, storage, transactions, and migrations;
- tenant JWT issuer configuration, independent admin access-token
  authentication, stable stack identity, `refDomain` derivation, and
  authorization;
- ownership of CAS route matching versus Gateway exposure policy;
- migration away from `rootAssignments` and `cas_root_owners`;
- removal of the unused portable-node HTTP contracts and handlers while
  retaining the shared canonical binary format;
- current-balance and event-log query behavior;
- caller migration, tests, and architecture documentation.

This plan does not:

- model individual business references inside CAS;
- allow callers to assign a stable owner/ref ID to a hash;
- make domain balances authoritative for GC or node lifecycle;
- require Gateway to expose any particular CAS operation;
- define automatic correction from audit data;
- solve end-user identity or introduce user/account concepts into CAS.

## Fixed decisions

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
data namespace. CAS maintains an explicit trusted-issuer configuration that
maps each accepted issuer to one stable `stackId`. Multiple issuers or keys may
map to the same stack during rotation or authority migration, without changing
CAS paths or storage keys. CAS does not recognize a Gateway product identity;
Gateway is only one possible implementation of a stack's central issuer.

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
the calling service. Each trusted stack configuration declares which domains
its issuers may mint. A writer cannot select another domain.

The existing shared `CAS_ACCESS_KEY` cannot prove domain attribution. The
trusted write-attribution path therefore depends on the capability migration.
A local test adapter may inject a validated authorization context, but no
compatibility path may trust an arbitrary caller-supplied domain header.

For tenant service APIs, the stack authority signs `tenantId`, permissions, and
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
  credential: independent short-lived admin access token
  verifier: admin authority/key or introspection configuration
  audience: CAS admin plane
  authority: explicit allowed stack set + fine-grained admin permissions
```

The two verifier configurations and trust roots are disjoint. A tenant JWT is
never accepted by an admin route even if it contains an admin-looking scope;
an admin access token is never accepted by a tenant route. Production admin
access must not use a long-lived shared bearer secret. A WebUI obtains a
short-lived, stack-scoped admin token through its control-plane backend or
token exchange rather than embedding a broad credential in browser code.

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

The admin namespace does not imply one broad administrator credential. Each
operation requires a dedicated least-privilege admin access-token permission;
these Root Ref audit reads require `cas:root-audit:read`.

### Before: current canonical CAS routes

These are all method/route pairs currently recognized by
`@unidocs/protocol-cas`. Gateway exposure is intentionally not represented in
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

### After: target canonical CAS routes

| Method | Route | Operation | Change |
|---|---|---|---|
| `GET` | `/stacks/{stackId}/tenants/{tenantId}/nodes/{hash}/content` | `readContent` | Add stack scope; remove ingress mount |
| `GET` | `/stacks/{stackId}/tenants/{tenantId}/nodes/{hash}/metadata` | `readMetadata` | Add stack scope; remove ingress mount |
| `POST` | `/stacks/{stackId}/tenants/{tenantId}/nodes/{hash}` | `leaseNode` | Add stack scope; remove ingress mount |
| `POST` | `/stacks/{stackId}/tenants/{tenantId}/nodes/{hash}/lease` | `leaseExisting` | Add stack scope; remove ingress mount |
| `GET` | `/stacks/{stackId}/tenants/{tenantId}/usage` | `usage` | Add stack scope; remove ingress mount |
| `POST` | `/stacks/{stackId}/tenants/{tenantId}/gc` | `gc` | Add stack scope; remove ingress mount |
| `POST` | `/stacks/{stackId}/tenants/{tenantId}/root-refs` | `updateRootRefs` | Canonical Root Refs service API |
| `GET` | `/stacks/{stackId}/admin/root-ref-domains/{refDomain}/refs` | `listRootDomainRefs` | New stack-level admin audit API |
| `GET` | `/stacks/{stackId}/admin/root-ref-domains/{refDomain}/events` | `listRootDomainEvents` | New stack-level admin audit API |

`POST /tenants/{tenantId}/_internal/root-assignments` is removed rather than
replaced. The new Root Refs write route subsumes root lifecycle changes through
signed deltas but does not emulate owner assignment semantics.

`GET` and `POST /tenants/{tenantId}/_internal/nodes/{hash}` are also removed.
They have no in-repository service consumer and are not renamed or replaced.

### Runtime compatibility routes

Cloudflare CAS currently also accepts tenant-header-only forms that are not
canonical `@unidocs/protocol-cas` routes:

| Method | Runtime route | Target disposition |
|---|---|---|
| `POST` | `/_internal/root-refs` | Temporary dual-mode write only, then remove |
| `POST` | `/_internal/root-assignments` | Remove with owner assignments |
| `GET` | `/_internal/nodes/{hash}` | Remove without replacement |
| `POST` | `/_internal/nodes/{hash}` | Remove without replacement |

Historical `/users/{userId}/cas/...` paths are Gateway ingress compatibility
routes, not CAS service routes. A shared ingress may use `/cas` as its own
service-routing mount, keep stack identity implicit, and map requests to the
canonical stack-scoped CAS path. Its path shape, retention, and removal belong
to that proxy and are intentionally excluded from both canonical CAS matrices.

Tenant routes require the tenant-JWT issuer mapping to produce the path
`stackId` and the token tenant to equal the path tenant. Admin routes bypass
the tenant verifier entirely: the independent admin verifier must authorize the
path stack and required admin permission. These checks occur before storage
access. For writes, `refDomain` comes only from the verified tenant capability.
For audit reads, `refDomain` is an admin-selected path parameter. A tenant
capability never grants admin access.

The current public CAS proxy policy must not expose Root Refs writes or CAS
admin routes. That allowlist belongs in Gateway-owned code, not
`@unidocs/protocol-cas`. A future WebUI-facing admin ingress is a separate
control-plane policy that forwards the independent admin access token; it does
not turn admin routes into tenant/public CAS routes or require CAS to rename
them.

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
GET /stacks/stack-a/admin/root-ref-domains/doc/refs?tenantId=tenant-1&limit=500&cursor=...
Authorization: Bearer <CAS admin access token carrying cas:root-audit:read>
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
and the optional tenant filter. If a write changes the domain before pagination
completes and the implementation cannot serve the original snapshot, it
returns `409` with a restart-required error instead of silently mixing
revisions.

Revisions increase monotonically per `(stackId, refDomain)`, beginning at zero
before the first event. A write for any tenant in that stack domain advances
the revision; writes in another domain or stack do not. `limit` defaults to 200
and cannot exceed 1000. The opaque cursor encodes a version, stack domain,
revision, optional tenant filter, last tenant, and last hash. Malformed cursors
or cursors bound to another path domain/filter return `400`, while a well-formed
cursor for an unavailable revision returns `409 ROOT_REF_SNAPSHOT_CHANGED`.

### Read a stack domain's audit event log

```http
GET /stacks/stack-a/admin/root-ref-domains/doc/events?tenantId=tenant-1&after=1842&limit=500
Authorization: Bearer <CAS admin access token carrying cas:root-audit:read>
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
`nextAfter` is the last returned revision, or the requested `after` value when
the page is empty.

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

Retain `CasRootRefUpdate` and add explicit method-specific contracts:

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

export interface CasRootDomainPath extends CasStackPath {
  readonly refDomain: string;
}

export interface CasListRootDomainRefsRequest {
  readonly path: CasRootDomainPath;
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
  readonly path: CasRootDomainPath;
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

`CasEndpointContracts` and `CasRoute` use distinct operations:

```text
updateRootRefs
listRootDomainRefs
listRootDomainEvents
```

The route matcher recognizes all three CAS operations but does not decide
whether Gateway exposes them. Remove `isPublicCasRoute()` from
`@unidocs/protocol-cas`; Gateway-owned policy matches a `CasRoute` and applies
its own operation allowlist through a Gateway-specific helper such as
`isGatewayExposedCasRoute()`. Every `CasRoute` variant carries `stackId`;
tenant service operations additionally carry `tenantId`, while stack-level
audit operations carry `refDomain` without a path tenant.

## Storage model

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
Durable Object name: canonicalComposite(stackId, tenantId)
R2 object key:       stacks/{stackId}/tenants/{tenantId}/nodes/{hash}
```

Do not build the DO name through ambiguous delimiter concatenation unless both
components are canonically encoded. The worker forwards verified `stackId` and
`tenantId` to the DO; the DO never accepts arbitrary identity headers from an
external caller.

`changes_json` stores the canonical, hash-sorted payload so event replay and
the idempotency hash use the same representation. Zero projection rows should
be deleted to bound current-balance scans.

Every successful update performs one atomic unit:

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

Steps 6-9 commit together. A retry returns after step 3 and performs none of
steps 4-9.

## Migration and compatibility

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

The schema migration rebuilds every tenant-keyed authoritative table with
`stack_id`, including `cas_nodes`, `cas_edges`, and
`cas_root_ref_requests`. Compatibility owner rows are either removed in the
same coordinated cutover or scoped to the configured legacy stack while they
remain readable. Existing R2 objects move from
`tenants/{tenantId}/nodes/{hash}` to
`stacks/{stackId}/tenants/{tenantId}/nodes/{hash}` using an idempotent,
verifiable copy-and-cutover procedure.

Only the configured legacy stack may temporarily fall back to old stackless R2
keys. A request authenticated for another stack must never probe a stackless
key, because that would turn compatibility behavior into cross-stack data
exposure. Migration completion is verified before removing the fallback and
old objects.

### Route compatibility

The canonical write route is the stack-and-tenant-prefixed CAS service route:

```text
/stacks/{stackId}/tenants/{tenantId}/root-refs
```

Do not add audit reads to legacy tenant-header-only routes. Remove legacy
`/_internal/root-refs` handling when the capability migration switches writers
to the canonical service route. If a short compatibility window is
unavoidable, it may support POST only and must still obtain a trusted domain
from auth; it must not expose audit data.

Remove both tenant-prefixed and tenant-header-only portable-node routes without
a replacement endpoint. There is no in-repository caller to migrate. Before
deployment, verify service inventory and route telemetry do not reveal an
external consumer; that operational check does not create a compatibility API
or change the target removal state.

Use an explicit rollout sequence:

1. Deploy capability-aware CAS verification and callers in `dual` mode.
2. Switch every Root Refs writer to delegated capabilities and the canonical
   CAS service route; deploy operator audit tooling separately.
3. Verify telemetry shows no tenantless/shared-key Root Refs requests and no
  root-assignment requests for the rollback window.
4. Disable tenantless Root Refs routes, shared-key Root Refs writes, and root
   assignments.

In `dual` mode, any unavoidable legacy POST is attributed only to a reserved
migration domain and legacy `stackId` selected by trusted server configuration.
It cannot carry a caller-selected stack or domain. The audit routes have no
legacy compatibility form.

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

## File map

| Path | Planned change |
|---|---|
| `packages/protocol-cas/src/types.ts` | Remove assignment types; add balance/event domain types; update `TenantCasService` |
| `packages/protocol-cas/src/http.ts` | Add stack/admin paths; split update/list/event contracts; remove retired contracts |
| `packages/protocol-cas/src/routes.ts` | Match stack-and-tenant service routes plus stack admin routes; remove retired routes and Gateway exposure policy |
| `packages/protocol-cas/src/index.ts` | Remove retired exports and publish the target contracts |
| `packages/protocol-cas/tests/routes.test.ts` | Cover service and operator routes; remove portable-node and Gateway-policy assertions |
| `packages/protocol-gateway/src/index.ts` | Own the Gateway-exposed CAS operation allowlist |
| `packages/gateway-common/src/gateway-handler.ts` | Apply injected Gateway CAS exposure policy after route matching |
| `packages/cas-client/src/index.ts` | Add `stackId`, update the write route, and remove assignment/read emulation |
| `packages/cas-client/tests/cas-client.test.ts` | Verify stack-scoped URLs, responses, auth, and retries |
| `packages/cloudflare-cas/src/worker.ts` | Resolve issuer to stack, enforce path scope, dispatch target operations, and remove retired routes |
| `packages/cloudflare-cas/src/cas/routes.ts` | Partition tenant commands by stack and tenant; forward Root Refs operations |
| `packages/cloudflare-cas/src/cas/do.ts` | Use stack-scoped D1/R2 keys, implement Root Ref operations, and remove retired handlers |
| `packages/cloudflare-cas/src/cas/schema.ts` | Add `stack_id` to tenant keys and stack-domain audit schema; migrate idempotency; retire owner schema |
| `packages/cloudflare-cas/tests/` | Add cross-stack isolation, migration, and ledger coverage; remove retired API tests |
| `packages/cloudflare-sdk/src/editor-do-svalue.ts` | Replace owner assignments with explicit acquire/release deltas |
| `packages/doctype-server-common/src/` | Preserve exact root lifecycle and rollback behavior for shared Doc runtimes |
| `packages/service-auth/src/claims.ts` | Add and validate tenant, permission, and Root Refs domain claims |
| `packages/service-auth/src/issuer.ts` | Accept registered domains and issue generic stack-authority CAS capabilities |
| `packages/service-auth/src/verifier.ts` | Verify tenant JWT capabilities and preserve stack, tenant, and domain context |
| `packages/service-auth/src/` | Add an independent admin access-token verifier with separate trust and audience configuration |
| `packages/gateway-common/src/capability-authority.ts` | Adapt the current central issuer to the generic stack-authority contract |
| `packages/gateway-common/src/capability-policy.ts` | Define Root Refs write delegation and separate operator audit permission |
| `packages/doctype-server-common/src/doc-type-handler.ts` | Carry the delegated CAS capability through the request-bounded Doc operation |
| `stacks/cloudflare/local/doc-types.mjs` | Configure local `stackId`, trusted issuer fixtures, routes, and failure injection |
| `docs/cas-architecture.md` | Document the ledger and remove portable-node HTTP API guidance |
| `docs/superpowers/plans/2026-08-21-svalue-sblob-document-protocol.md` | Remove the unimplemented portable-node caller assumption |
| `docs/superpowers/plans/2026-08-25-gateway-issued-capability-authorization.md` | Reconcile superseded root-owner and portable-node contracts |

## Implementation tasks

### Task 1: Freeze protocol behavior with tests

- [ ] Add failing route tests for POST
  `/stacks/{stackId}/tenants/{tenantId}/root-refs` and GET domain
  refs/events under `/stacks/{stackId}/admin/root-ref-domains/{refDomain}`.
- [ ] Add `CasStackPath`, make every tenant/node path stack-scoped, and prove
  tenant service routes carry `stackId + tenantId` while admin routes carry
  `stackId + refDomain` without a path tenant.
- [ ] Add response/request type tests or compile fixtures for update, balance,
      event, cursor, and revision contracts.
- [ ] Remove `isPublicCasRoute()` from `@unidocs/protocol-cas`; move the
      Gateway-exposed CAS operation allowlist into Gateway-owned policy.
- [ ] Prove the current Gateway policy excludes Root Refs writes and all CAS
      audit operations without treating that exclusion as a CAS route property.
- [ ] Keep a future WebUI admin ingress separate from the public CAS proxy and
  prove it forwards only admin access tokens to `/stacks/{stackId}/admin`.
- [ ] Remove assignment protocol types, routes, contracts, and exports.
- [ ] Remove portable-node constants, request/response contracts, endpoint
  entries, route operations, builder, exports, and protocol route tests.
- [ ] Use explicit `updateRootRefs`, `listRootDomainRefs`, and
  `listRootDomainEvents` operation names.

**Focused validation:**

```text
pnpm --filter @unidocs/protocol-cas test
pnpm --filter @unidocs/protocol-cas typecheck
pnpm --filter @unidocs/protocol-gateway test
```

### Task 2: Add trusted stack and domain authorization

- [ ] Add tenant JWT issuer configuration mapping `(iss, kid)` verification to a
  stable `stackId`, expected CAS audience, allowed algorithms, and
  registered `refDomain` values. Support multiple issuers per stack and
  multiple rotation keys per issuer.
- [ ] Select issuer and key only from static or controlled configuration; never
  trust or dynamically fetch an issuer or JWKS URL supplied by the token.
- [ ] Extend capability claim/input types, central stack-authority adapters,
  service-to-CAS delegation, `CasClient` configuration, CAS worker, and DO
  forwarding with stack, tenant, and signed `refDomain` context.
- [ ] Add a separate admin access-token verifier with independent issuer/key or
  introspection configuration, admin audience, stack grants, expiry, and
  fine-grained permissions. Do not share tenant JWT trust configuration.
- [ ] Route `/stacks/{stackId}/admin/...` exclusively through the admin verifier
  and all tenant service paths exclusively through the tenant verifier.
- [ ] Add a validated `refDomain` claim to the CAS capability shape used by
  Root Refs writes.
- [ ] Register stable domain names at capability issuance; do not derive them
      from instance IDs or caller input.
- [ ] Update Cloudflare SDK and applicable Azure/other runtime adapters to
  forward the request-bounded delegated capability for Root Refs instead of
  using `CAS_ACCESS_KEY` as the only credential.
- [ ] Require issuer-derived stack equality for every route. Require token
  tenant equality on tenant service routes; require stack-level
  `cas:root-audit:read` on Root Ref admin reads.
- [ ] Keep ordinary `cas:write` credentials from selecting or reading audit
      domains; audit domain selection is restricted to operator credentials.
- [ ] Reject missing, unknown, reserved, or caller-overridden domains on the
      write path. Permit authorized operators to inspect reserved audit domains
      such as `_legacy`.
- [ ] Add confused-deputy tests proving a writer cannot attribute changes to
      another domain and cannot gain audit access through its write capability.
- [ ] Prove tenant JWTs are rejected by admin routes regardless of claims, and
  admin access tokens are rejected by tenant routes regardless of grants.
- [ ] Add WebUI/BFF tests for short-lived stack-scoped admin token acquisition;
  no long-lived broad admin bearer credential is embedded in browser code.
- [ ] Add tests proving two trusted stacks may use the same `tenantId` without
  sharing nodes, counts, idempotency, audit records, leases, usage, or GC.
- [ ] Reject unknown issuers, unknown `kid`, wrong audience, path-stack
  mismatch, tenant mismatch, disallowed domains, and reserved write domains
  before any DO, D1, or R2 access.

**Focused validation:** service-auth, gateway-common capability-policy, and CAS
worker authorization suites.

### Task 3: Add audit schema and baseline migration

- [ ] Add `stack_id` to every tenant-owned D1 primary key and index, including
  nodes, edges, idempotency, audit tables, and any compatibility owner rows.
- [ ] Partition Durable Objects by canonical `(stackId, tenantId)` and move R2
  objects to `stacks/{stackId}/tenants/{tenantId}/nodes/{hash}`.
- [ ] Add domain event, domain projection, and required stack-domain revision
  allocator schema.
- [ ] Migrate idempotency keys to include `stack_id` and `ref_domain` and store
  revision.
- [ ] Add the reserved `_legacy` baseline migration for existing aggregate
      counts without changing those aggregate counts.
- [ ] Make migrations idempotent and safe for partially upgraded local/test
      databases.
- [ ] Require one configured legacy `stackId` for stackless data; never infer
  stack from tenant IDs or owner/request strings.
- [ ] Restrict temporary stackless R2 fallback to that legacy stack and verify
  copy completeness before deleting old objects and fallback code.
- [ ] Keep `cas_root_owners` readable during the compatibility phase but stop
      treating it as the target model.
- [ ] Test fresh schema, old `user_id` schema, current stackless tenant schema,
      same-tenant cross-stack isolation, reruns, R2 copy/cutover, and baseline
      totals.

**Focused validation:** `pnpm --filter @unidocs/cloudflare-cas test` with schema
tests selected first.

### Task 4: Implement atomic update and audit writes

- [ ] Refactor `handleUpdateRootRefs()` around one canonical payload and one
      transaction/batch.
- [ ] Scope idempotency to stack, tenant, and authenticated domain.
- [ ] Return the original revision on idempotent retries.
- [ ] Append exactly one event per newly accepted request.
- [ ] Update the domain projection by the same deltas, allow negative domain
      balances, and remove zero rows.
- [ ] Preserve aggregate non-negative, readiness, overflow, and all-or-nothing
      validation.
- [ ] Prove audit write failure rolls back aggregate changes and idempotency.
- [ ] Prove update validation and GC do not query audit tables.

**Focused validation:** focused `cloudflare-cas` DO root-ref and GC tests.

### Task 5: Implement audit reads

- [ ] Implement `(tenantId, hash)`-ordered, bounded current-balance pages for
  the operator-selected stack domain, with optional exact `tenantId`
  filtering and `tenantId` in every row.
- [ ] Bind cursors to a revision and reject mixed-revision pagination.
- [ ] Implement per-`(stackId, refDomain)` monotonic revisions, default/max
  limits of 200/1000, versioned opaque cursors bound to the optional tenant
  filter, non-negative safe-integer `after`, and the specified
  `400`/`409 ROOT_REF_SNAPSHOT_CHANGED` errors.
- [ ] Return positive and negative non-zero balances.
- [ ] Implement stack-domain ordered event pages with `tenantId`, exclusive
  `after`, optional exact tenant filtering, bounded `limit`,
  `latestRevision`, and `nextAfter`.
- [ ] Ensure idempotent retries never duplicate events.
- [ ] Reject cross-stack reads, missing admin audit permission, malformed
  domains, and cursor/path-domain/filter mismatches before database access.

**Focused validation:** focused CAS worker/DO route and pagination tests.

### Task 6: Migrate clients and business callers

- [ ] Add stable `stackId` to `CasClient` configuration and update
  `updateRootRefs()` to use the canonical stack-and-tenant route and typed
  revision response.
- [ ] Keep current-balance and event-log reads out of the ordinary `CasClient`;
  expose them through a dedicated `CasAdminClient` or operator tooling that
  accepts only admin access tokens.
- [ ] Remove `CasClient.assignRoots()` and its incorrect assignment-to-`+1`
      compatibility conversion.
- [ ] Convert SValue delta and snapshot retention to explicit acquire, replace,
      truncate, and delete deltas.
- [ ] Enumerate every current assignment call, including pending-version
  recovery and `#ensureCurrentSnapshot()`. For each path, document the
  exact durable row transition that acquires, replaces, or releases delta
  and snapshot roots.
- [ ] Preserve deterministic request IDs across retries and pending-outbox
      recovery.
- [ ] Prove partially completed acquire/release operations recover to one
  logical application after restart without leaking or undercounting roots.
- [ ] Preserve Doc rollback semantics when a root update fails.
- [ ] Update local failure injection to recognize the canonical POST route.

**Focused validation:** CAS client, Cloudflare SDK, doctype-server-common, and
local integration tests covering commit, retry, rollback, truncation, snapshot
replacement, pending recovery, snapshot repair, clone, and session deletion.
Tests assert both aggregate counts and emitted domain deltas.

### Task 7: Remove retired APIs

- [ ] Delete worker and DO `assignRoots` dispatch and implementation.
- [ ] Delete all owner-assignment tests and replace their intended lifecycle
      coverage with signed-delta tests.
- [ ] Delete `/_internal/nodes/{hash}` GET/POST dispatch, portable-node route
      forwarding, DO actions and handlers, and API-specific tests.
- [ ] Keep canonical binary encode/parse/validation/digest helpers and their
      non-route tests; remove only symbols owned by the portable HTTP surface.
- [ ] Verify no source, generated declaration, route, fixture, or document
      references `CasAssignRootsRequest`, `CasRootAssignment`,
      `rootAssignments`, `cas_root_owners`, `readPortableNode`,
      `leasePortableNode`, portable HTTP contract types, or
      `/_internal/nodes/{hash}` as a live API.
- [ ] Stop creating the owner table on fresh databases.
- [ ] Schedule physical owner-table removal only after compatibility deployment
      verification; do not couple destructive cleanup to the API cutover.

**Focused validation:** repository search plus protocol, CAS, client, and SDK
test suites.

### Task 8: Documentation and full validation

- [ ] Update `docs/cas-architecture.md` with the authoritative-vs-audit boundary,
  exact HTTP contracts, CAS-versus-Gateway API ownership, idempotency, and
  reconciliation flow.
- [ ] Document stack as the top-level namespace, issuer-to-stack mapping,
      tenant/refDomain orthogonality, native CAS versus ingress paths, shared
      storage keys, and stack migration.
- [ ] Amend plans that currently call owner assignments canonical so they point
      to this superseding decision rather than leaving contradictory guidance.
- [ ] Remove architecture and authorization-plan guidance that presents
  portable-node HTTP transport as a supported or planned API.
- [ ] Document that audit balances are CAS-recorded history, not guaranteed
      business truth.
- [ ] Run package typechecks and unit tests, then local integration tests.

**Full validation:**

```text
pnpm typecheck
pnpm test
pnpm test:local
```

## Acceptance criteria

- Tenant service routes use `/stacks/{stackId}/tenants/{tenantId}/...`; formal
  stack control-plane routes use `/stacks/{stackId}/admin/...`. Native CAS
  routes do not repeat a `/cas` ingress mount.
- CAS trusts configured issuers and keys, maps verified `iss` to stable
  `stackId`, and knows no Gateway-specific authentication concept.
- Tenant routes accept only stack-issuer JWT capabilities for the CAS data
  plane. Admin routes accept only independent short-lived admin access tokens
  for the CAS admin plane; each verifier rejects the other credential class.
- Admin WebUI code contains no long-lived broad bearer secret and reaches CAS
  through a dedicated admin client/control-plane ingress.
- Stack, tenant, and domain remain structured dimensions; no persistent or
  protocol identity is encoded as an `issuer:domain` string.
- Two stacks with the same `tenantId` are isolated across DO, D1, R2, nodes,
  references, leases, usage, GC, idempotency, and audit data.
- Only signed `hash -> delta` updates can change root counts.
- No production API or schema concept models individual logical root refs or
  owners.
- Every newly accepted update has exactly one domain event and an updated
  domain projection in the same commit.
- Audit revisions are monotonic per `(stackId, refDomain)`; every event and
  balance row records the affected `tenantId`.
- Idempotent retries create no duplicate count change or event.
- Ordinary business-service credentials cannot browse domain audit data;
  authorized operators can select a domain and read its CAS-recorded balance
  and ordered history, including reserved migration domains.
- Aggregate counts may never become negative; audit domain balances may.
- GC and all node lifecycle decisions operate correctly if audit reads are
  unavailable and never query audit tables.
- Existing aggregate counts survive migration unchanged and receive an
  explicit non-callable audit baseline.
- `rootAssignments` and its client emulation are removed after callers emit
  complete lifecycle deltas.
- Portable-node HTTP routes, contracts, handlers, exports, and API-specific
  tests are removed without replacement; shared canonical binary utilities
  remain as an independently specified codec, with digest construction still
  used by non-route consumers.
- Root Refs write and audit routes are complete CAS contracts independent of
  deployment topology. Gateway owns their exposure policy, and its current
  allowlist exposes neither operation class.