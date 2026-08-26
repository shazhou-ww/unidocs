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

**Architecture:** The authoritative CAS lifecycle state remains the
tenant-scoped aggregate `root_ref_count` on each node. A trusted business
`refDomain`, derived from the authenticated capability rather than the request
body, attributes each accepted change to a business domain such as `doc` or
`gateway`. CAS atomically writes an append-only domain event and updates a
domain balance projection with every successful aggregate count update. The
domain tables are audit data only: root validation, leasing, GC, and repair
must never consume them as authoritative state.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, D1, R2,
Gateway-issued capability tokens, Vitest.

## Scope

This plan covers:

- the `@unidocs/protocol-cas` Root Refs HTTP contracts and route matcher;
- CAS client write methods and separate operator audit tooling;
- Cloudflare CAS routing, storage, transactions, and migrations;
- trusted `refDomain` derivation and authorization;
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

### Core root model

The root model is a tenant-level signed-count ledger:

```text
(tenantId, hash) -> rootRefCount
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
gateway
```

If deployment topology requires stronger attribution, registered stable names
such as `doc:markdown` and `doc:docx` may be used. Ephemeral instance IDs must
not be used because restarts and scale-out must retain one continuous ledger.

Root Refs write requests do not carry `refDomain` in their path, query,
headers, or body. CAS derives it from a validated capability claim issued for
the calling service. The issuer must only mint registered domains. A writer
cannot select another domain.

The existing shared `CAS_ACCESS_KEY` cannot prove domain attribution. The
trusted write-attribution path therefore depends on the capability migration.
A local test adapter may inject a validated authorization context, but no
compatibility path may trust an arbitrary caller-supplied domain header.

The domain must travel end to end as a signed capability claim: capability
claim and input types, Gateway issuance, Doc verification/delegation, CAS
client configuration, CAS verification, and tenant-DO forwarding. Root Refs
write operations in capability mode use that verified claim as their sole
domain source. The current `X-Tenant-Id`, request body, query parameters, and
arbitrary headers cannot supply or override it. Runtime adapters must forward
the delegated CAS capability instead of authenticating Root Refs only with the
shared access key.

Audit reads are different: an operator with dedicated audit-read permission
selects a domain as an explicit query target. That path parameter is a filter
over audit data, not the attribution source for a Root Refs write.

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

Idempotency is scoped to `(tenantId, refDomain, requestId)`.

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
CAS. Domain reads are stable operator audit APIs under the `cas/audit`
namespace; they are not ordinary business-service reads.

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
| `GET` | `/tenants/{tenantId}/cas/nodes/{hash}/content` | `readContent` | Unchanged |
| `GET` | `/tenants/{tenantId}/cas/nodes/{hash}/metadata` | `readMetadata` | Unchanged |
| `POST` | `/tenants/{tenantId}/cas/nodes/{hash}` | `leaseNode` | Unchanged |
| `POST` | `/tenants/{tenantId}/cas/nodes/{hash}/lease` | `leaseExisting` | Unchanged |
| `GET` | `/tenants/{tenantId}/cas/usage` | `usage` | Unchanged |
| `POST` | `/tenants/{tenantId}/cas/gc` | `gc` | Unchanged |
| `POST` | `/tenants/{tenantId}/cas/root-refs` | `updateRootRefs` | Canonical Root Refs service API |
| `GET` | `/tenants/{tenantId}/cas/audit/root-ref-domains/{refDomain}/refs` | `listRootDomainRefs` | New operator audit API |
| `GET` | `/tenants/{tenantId}/cas/audit/root-ref-domains/{refDomain}/events` | `listRootDomainEvents` | New operator audit API |

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
routes, not CAS service routes. Their retention or removal belongs to Gateway
and is intentionally excluded from both canonical CAS matrices.

The token tenant must equal the path tenant for every route. For writes,
`refDomain` comes only from the verified capability. For audit reads,
`refDomain` is an operator-selected path parameter and the dedicated audit
permission authorizes that selection. A normal `cas:write` capability does not
grant audit-read access.

The current Gateway policy must not expose Root Refs writes or CAS audit
routes. That allowlist belongs in Gateway-owned code, not
`@unidocs/protocol-cas`; a future Gateway policy change must not require CAS to
rename or reclassify these routes.

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
POST /tenants/tenant-1/cas/root-refs
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

### Read a domain's current audit balance

```http
GET /tenants/tenant-1/cas/audit/root-ref-domains/doc/refs?limit=500&cursor=...
Authorization: Bearer <operator capability carrying cas:root-audit:read>
```

```json
{
  "revision": 1843,
  "refs": [
    { "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "count": 3 },
    { "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "count": -1 }
  ],
  "nextCursor": null
}
```

This is the CAS-recorded balance for the operator-selected domain, not proof of
the business system's current real-world references. Zero-balance rows are
omitted; negative balances are returned.

Results are ordered by hash and bounded. The first page returns a domain
`revision`; subsequent pages bind their cursor to that revision. If a write
changes the domain before pagination completes and the implementation cannot
serve the original snapshot, it returns `409` with a restart-required error
instead of silently mixing revisions.

Revisions increase monotonically per `(tenantId, refDomain)`, beginning at
zero before the first event. A write in another domain does not invalidate the
current domain's cursor. `limit` defaults to 200 and cannot exceed 1000. The
opaque cursor encodes a version, domain, revision, and last hash; malformed
cursors or cursors bound to another path domain return `400`, while a
well-formed cursor for an unavailable revision returns
`409 ROOT_REF_SNAPSHOT_CHANGED`.

### Read a domain's audit event log

```http
GET /tenants/tenant-1/cas/audit/root-ref-domains/doc/events?after=1842&limit=500
Authorization: Bearer <operator capability carrying cas:root-audit:read>
```

```json
{
  "events": [
    {
      "revision": 1843,
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

Events are returned in increasing revision order. Idempotent retries do not
append another event. `after` is exclusive. An empty page still returns the
latest revision known for the selected domain.

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
export interface CasUpdateRootRefsRequest {
  readonly path: CasTenantPath;
  readonly body: CasRootRefUpdate;
}

export type CasUpdateRootRefsResponse =
  | { success: true; idempotent: boolean; revision: number }
  | CasErrorResponse;

export interface CasRootDomainPath extends CasTenantPath {
  readonly refDomain: string;
}

export interface CasListRootDomainRefsRequest {
  readonly path: CasRootDomainPath;
  readonly query?: { limit?: number; cursor?: string };
}

export interface CasRootRefBalance {
  readonly hash: CasHash;
  readonly count: number;
}

export type CasListRootDomainRefsResponse =
  | { revision: number; refs: readonly CasRootRefBalance[]; nextCursor: string | null }
  | CasErrorResponse;

export interface CasListRootDomainEventsRequest {
  readonly path: CasRootDomainPath;
  readonly query?: { after?: number; limit?: number };
}

export interface CasRootRefEvent {
  readonly revision: number;
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
`isGatewayExposedCasRoute()`.

## Storage model

### Authoritative tables

`cas_nodes.root_ref_count` remains the only authoritative root count consumed
by core CAS behavior.

`cas_root_ref_requests` remains part of the command/idempotency path. Migrate
its key to:

```text
(tenant_id, ref_domain, request_id)
```

Store `payload_hash`, `revision`, and `applied_at`. Existing request rows need a
reserved migration domain so historical request IDs do not collide with new
domain-scoped requests.

### Audit tables

```text
cas_root_domain_events
  tenant_id
  ref_domain
  revision
  request_id
  payload_hash
  changes_json
  applied_at
  PRIMARY KEY (tenant_id, ref_domain, revision)
  UNIQUE (tenant_id, ref_domain, request_id)

cas_root_domain_refs
  tenant_id
  ref_domain
  hash
  ref_count
  PRIMARY KEY (tenant_id, ref_domain, hash)
```

The implementation may add an audit-only per-domain revision allocator if D1
cannot safely produce the next revision inside the serialized tenant command.
That allocator remains audit infrastructure and is not consumed by GC or node
lifecycle logic.

`changes_json` stores the canonical, hash-sorted payload so event replay and
the idempotency hash use the same representation. Zero projection rows should
be deleted to bound current-balance scans.

Every successful update performs one atomic unit:

1. Resolve and validate `{ tenantId, refDomain }` from authorization.
2. Canonicalize and hash the request payload.
3. Check domain-scoped idempotency.
4. Validate node readiness and aggregate count results.
5. Allocate the next domain audit revision.
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

The baseline uses the normal event schema and canonical hash ordering. Split it
into deterministic batches of at most 1000 hash changes, with deterministic
request IDs derived from the migration version, tenant, and batch ordinal.
Allocate `_legacy` revisions in batch order and persist the corresponding
payload hashes. Rerunning the migration must match the same request IDs and
payloads, append no duplicate events, and leave aggregate counts untouched.
Tenants with no positive root counts create no baseline event and begin at
revision zero.

### Route compatibility

The canonical write route is the tenant-prefixed CAS service route:

```text
/tenants/{tenantId}/cas/root-refs
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
migration domain selected by trusted server configuration. It cannot carry a
caller-selected domain. The audit routes have no legacy compatibility form.

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
| `packages/protocol-cas/src/http.ts` | Split update/list/event contracts; remove assignment and portable-node contracts |
| `packages/protocol-cas/src/routes.ts` | Match the Root Refs service and audit routes; remove assignments, portable-node routes, and Gateway exposure policy |
| `packages/protocol-cas/src/index.ts` | Remove retired exports and publish the target contracts |
| `packages/protocol-cas/tests/routes.test.ts` | Cover service and operator routes; remove portable-node and Gateway-policy assertions |
| `packages/protocol-gateway/src/index.ts` | Own the Gateway-exposed CAS operation allowlist |
| `packages/gateway-common/src/gateway-handler.ts` | Apply injected Gateway CAS exposure policy after route matching |
| `packages/cas-client/src/index.ts` | Update the write method and remove assignment/read emulation |
| `packages/cas-client/tests/cas-client.test.ts` | Verify the write URL, response, auth, and retries |
| `packages/cloudflare-cas/src/worker.ts` | Dispatch the three target operations; remove portable-node runtime routes |
| `packages/cloudflare-cas/src/cas/routes.ts` | Forward Root Refs operations; remove portable-node forwarding |
| `packages/cloudflare-cas/src/cas/do.ts` | Implement Root Ref writes/reads; remove portable-node dispatch and handlers |
| `packages/cloudflare-cas/src/cas/schema.ts` | Add domain audit schema and migrate idempotency; retire owner schema |
| `packages/cloudflare-cas/tests/` | Add ledger coverage and remove portable-node API tests |
| `packages/cloudflare-sdk/src/editor-do-svalue.ts` | Replace owner assignments with explicit acquire/release deltas |
| `packages/doctype-server-common/src/` | Preserve exact root lifecycle and rollback behavior for shared Doc runtimes |
| `packages/service-auth/src/claims.ts` | Add and validate the signed Root Refs domain claim |
| `packages/service-auth/src/issuer.ts` | Accept registered domains and include them in issued CAS capabilities |
| `packages/service-auth/src/verifier.ts` | Preserve the verified domain in CAS authorization context |
| `packages/gateway-common/src/capability-authority.ts` | Issue delegated CAS credentials with the target service's registered domain |
| `packages/gateway-common/src/capability-policy.ts` | Define Root Refs write delegation and separate operator audit permission |
| `packages/doctype-server-common/src/doc-type-handler.ts` | Carry the delegated CAS capability through the request-bounded Doc operation |
| `stacks/cloudflare/local/doc-types.mjs` | Update route/failure injection and local auth fixtures |
| `docs/cas-architecture.md` | Document the ledger and remove portable-node HTTP API guidance |
| `docs/superpowers/plans/2026-08-21-svalue-sblob-document-protocol.md` | Remove the unimplemented portable-node caller assumption |
| `docs/superpowers/plans/2026-08-25-gateway-issued-capability-authorization.md` | Reconcile superseded root-owner and portable-node contracts |

## Implementation tasks

### Task 1: Freeze protocol behavior with tests

- [ ] Add failing route tests for POST `/cas/root-refs` and GET domain
  refs/events under `/cas/audit/root-ref-domains/{refDomain}`.
- [ ] Add response/request type tests or compile fixtures for update, balance,
      event, cursor, and revision contracts.
- [ ] Remove `isPublicCasRoute()` from `@unidocs/protocol-cas`; move the
      Gateway-exposed CAS operation allowlist into Gateway-owned policy.
- [ ] Prove the current Gateway policy excludes Root Refs writes and all CAS
      audit operations without treating that exclusion as a CAS route property.
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

### Task 2: Add trusted domain authorization

- [ ] Extend capability claim/input types, issuer, verifier, Gateway authority,
  Doc-to-CAS delegation, `CasClient` configuration, CAS worker, and tenant-DO
  forwarding with the signed `refDomain`.
- [ ] Add a validated `refDomain` claim to the CAS capability shape used by
  Root Refs writes.
- [ ] Register stable domain names at capability issuance; do not derive them
      from instance IDs or caller input.
- [ ] Update Cloudflare SDK and applicable Azure/other runtime adapters to
  forward the request-bounded delegated capability for Root Refs instead of
  using `CAS_ACCESS_KEY` as the only credential.
- [ ] Require path tenant equality on all three routes, a trusted capability
      domain on writes, and `cas:root-audit:read` on audit reads.
- [ ] Keep ordinary `cas:write` credentials from selecting or reading audit
      domains; audit domain selection is restricted to operator credentials.
- [ ] Reject missing, unknown, reserved, or caller-overridden domains on the
      write path. Permit authorized operators to inspect reserved audit domains
      such as `_legacy`.
- [ ] Add confused-deputy tests proving a writer cannot attribute changes to
      another domain and cannot gain audit access through its write capability.

**Focused validation:** service-auth, gateway-common capability-policy, and CAS
worker authorization suites.

### Task 3: Add audit schema and baseline migration

- [ ] Add domain event, domain projection, and revision-allocation schema.
- [ ] Migrate idempotency keys to include `ref_domain` and store revision.
- [ ] Add the reserved `_legacy` baseline migration for existing aggregate
      counts without changing those aggregate counts.
- [ ] Make migrations idempotent and safe for partially upgraded local/test
      databases.
- [ ] Keep `cas_root_owners` readable during the compatibility phase but stop
      treating it as the target model.
- [ ] Test fresh schema, old `user_id` schema, current tenant schema, reruns,
      and baseline totals.

**Focused validation:** `pnpm --filter @unidocs/cloudflare-cas test` with schema
tests selected first.

### Task 4: Implement atomic update and audit writes

- [ ] Refactor `handleUpdateRootRefs()` around one canonical payload and one
      transaction/batch.
- [ ] Scope idempotency to tenant plus authenticated domain.
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

- [ ] Implement hash-ordered, bounded current-balance pages for the
  operator-selected domain.
- [ ] Bind cursors to a revision and reject mixed-revision pagination.
- [ ] Implement per-domain monotonic revisions, default/max limits of 200/1000,
  versioned opaque cursors, non-negative safe-integer `after`, and the
  specified `400`/`409 ROOT_REF_SNAPSHOT_CHANGED` errors.
- [ ] Return positive and negative non-zero balances.
- [ ] Implement ordered event pages with exclusive `after`, bounded `limit`,
      `latestRevision`, and `nextAfter`.
- [ ] Ensure idempotent retries never duplicate events.
- [ ] Reject cross-tenant reads, missing audit permission, malformed domains,
      and cursor/path-domain mismatches before database access.

**Focused validation:** focused CAS worker/DO route and pagination tests.

### Task 6: Migrate clients and business callers

- [ ] Update `CasClient.updateRootRefs()` to use the canonical tenant-prefixed
      route and typed revision response.
- [ ] Keep current-balance and event-log reads out of the ordinary `CasClient`;
  expose them only through dedicated operator tooling or an audit client.
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

- Only signed `hash -> delta` updates can change root counts.
- No production API or schema concept models individual logical root refs or
  owners.
- Every newly accepted update has exactly one domain event and an updated
  domain projection in the same commit.
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