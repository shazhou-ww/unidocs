# CAS Architecture

Status: accepted design, not yet fully implemented

Date: 2026-08-19

This document defines the target content-addressed storage (CAS) architecture for UniDocs. The current snapshot-only R2/D1 implementation predates this design and will be migrated incrementally.

The node encoding referenced below is defined in [CAS Binary Format](./cas-binary-format.md).

## 1. Goals

The CAS stores a user-scoped Merkle DAG for persistent document assets and custom snapshot formats.

The design must provide:

- immutable, content-addressed nodes;
- user isolation and authenticated access;
- deduplication within one user partition;
- child references between nodes;
- leases that protect uncommitted nodes from garbage collection;
- separate child and business-root reference counts;
- transactional reference updates inside D1;
- idempotent root-reference updates;
- deterministic reference extraction from document operations and snapshots;
- read-only CAS access from document-type implementations.

The CAS does not attempt to provide a distributed transaction spanning a document Durable Object, D1, and R2. Cross-system failures are handled with ordering, rollback, retry, and business-level compensation.

## 2. User isolation and execution model

Each user has an independent CAS address space.

- D1 keys include `(user_id, digest)`.
- R2 objects use `users/{user_id}/nodes/{digest}`.
- Identical content owned by different users is stored independently.
- Storage usage and GC are calculated per user.
- Public HTTP APIs are namespaced under `/users/{userId}/`. The path userId is the current identity. Future Bearer authentication must bind to that userId.

A user-scoped CAS Durable Object serializes all mutable operations for that user:

- lease claims and extensions;
- upload completion;
- child-reference creation;
- root-reference count updates;
- garbage collection.

D1 and R2 remain the durable stores. The Durable Object is the concurrency boundary that prevents a lease claim from racing a GC deletion decision.

## 3. Node model

A logical node consists of three storage classes.

### 3.1 Immutable content

The node's own content bytes are immutable and stored in R2.

```text
users/{userId}/nodes/{sha256Digest}
```

R2 stores only the content bytes, not mutable lifecycle state.

### 3.2 Immutable metadata

D1 stores metadata that participates in node identity:

```ts
export type CasHash = string; // 64 lowercase hexadecimal SHA-256 characters

export interface CasNodeMetadata {
  readonly hash: CasHash;
  /** Byte length of this node's own R2 content. */
  readonly size: number;
  readonly contentType: string;
  /** Ordered child references. Duplicates are significant. */
  readonly refs: readonly CasHash[];
}
```

The ordered `refs` list is part of the Merkle identity. Each occurrence contributes one child reference. D1 must retain ordering, even if it also maintains a grouped edge-count index.

### 3.3 Mutable state

D1 stores lifecycle state that does not participate in the digest:

```ts
export interface CasNodeState {
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
  readonly childRefCount: number;
  readonly rootRefCount: number;
}
```

All fields default to `0`.

- `childRefCount` counts references from immutable metadata of other CAS nodes.
- `rootRefCount` counts references held by document deltas, retained custom snapshots, or other business roots.
- Both counts must remain non-negative.
- GC requires both counts to equal zero.

## 4. Node readiness

No explicit status column is used. D1/R2 presence defines readiness.

| D1 row | R2 content | Meaning |
|---|---|---|
| absent | absent | unknown |
| present | absent | not ready |
| present | present | ready |

The canonical R2 key is written only after the service has verified content length and the complete logical-node digest. Consequently, presence at the canonical key is the durable proof that upload validation completed. Failed or interrupted uploads must never write unverified bytes to the canonical key; implementations may buffer a bounded node or use a temporary R2 key while validating.

A node must be ready before it can:

- be read;
- receive a root reference;
- be referenced by a newly inserted node;
- be used by a document operation.

A D1 row without R2 content is a valid recoverable state. A later lease claim can request the content again.

## 5. Digest and identity

Node addresses use the complete 256-bit SHA-256 digest.

```text
sha256(canonical logical node bytes)
```

The canonical logical bytes include:

1. binary format/version and immutable flags;
2. own content size;
3. content type;
4. ordered child digests;
5. own content bytes.

Mutable lease and reference-count fields are excluded.

The binary preimage format is specified in [CAS Binary Format](./cas-binary-format.md). The service validates that supplied metadata and uploaded content reproduce the requested digest.

## 6. Lease semantics

A lease guarantees that CAS GC will not delete the node before `leaseExpiresAt`.

It does not guarantee that:

- the node is ready;
- the node will be deleted immediately after expiration;
- an expired upload attempt can still complete.

The state represents the most recent uninterrupted lease period:

```text
leaseStartedAt = start of the current uninterrupted lease period
leaseExpiresAt = current guaranteed protection deadline
```

When no lease has ever existed, both are `0`.

A claim requests a duration, but the service chooses the actual expiry. It may extend continuous leases more aggressively to reduce D1 write frequency.

```ts
export interface CasLeaseResult {
  readonly hash: CasHash;
  readonly ready: true;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
}
```

Rules:

- A ready node renews or extends its lease without re-uploading content.
- HTTP upload is a lease that carries content. The server never returns `uploadRequired` or an upload token.
- Leases are not explicitly released.
- Lease state is stored directly on the node row; there is no separate lease table.

## 7. Node creation

A node is created or leased through its expected hash and immutable metadata.

```ts
export interface CasNodeDescriptor {
  readonly hash: CasHash;
  readonly size: number;
  readonly contentType: string;
  readonly refs: readonly CasHash[];
}
```

Creation proceeds inside the user CAS queue:

1. Validate descriptor syntax and canonical constraints from URL and headers. Do not read the body yet.
2. If the D1 row exists and R2 content is present, require immutable metadata to match, cancel the body, extend the lease, and return ready.
3. If inserting a row, verify every child is ready.
4. Read the body. Verify content length and the complete canonical SHA-256 digest.
5. Store validated content at the canonical R2 key (idempotent).
6. In one D1 transaction:
   - insert immutable metadata and default mutable state, or update the lease on a not-ready row;
   - insert ordered child edges on first insert;
   - increment each child's `childRefCount` once per occurrence on first insert;
   - persist `leaseStartedAt` and `leaseExpiresAt`.

R2 is published before the D1 row. A crash after R2 and before D1 leaves an orphan object; retry is idempotent and completes the row. A D1 row is never committed without canonical R2 content.

No operation may add a reference to a parent that is not ready.

## 8. Garbage collection

A node is eligible when:

```text
childRefCount == 0
AND rootRefCount == 0
AND leaseExpiresAt <= now
```

GC runs through the same user CAS queue as lease and reference operations.

For each eligible node:

1. Re-check eligibility while holding the per-user queue.
2. Delete the R2 object. R2 deletion is idempotent; missing content is allowed.
3. In one D1 transaction:
   - re-check both reference counts and lease expiry;
   - delete ordered edge rows;
   - decrement each child's `childRefCount` by edge occurrence count;
   - reject and roll back if any child count would become negative;
   - delete the node row.
4. Newly zero-referenced children become candidates for a later GC pass.

If R2 deletion succeeds but the D1 transaction fails, the row remains as a not-ready node. A future lease can require re-upload, or a later GC pass can retry deletion and metadata cleanup.

The user-level queue closes the lease/GC race: a lease cannot be granted between GC's eligibility decision and R2 deletion.

## 9. Reference-count updates

### 9.1 Child references

Child references are immutable node metadata.

- They are incremented transactionally when a node row is first inserted.
- They are decremented transactionally when that node row is collected.
- Duplicate child hashes count as multiple references.
- A child must be ready when the parent row is inserted.

### 9.2 Root references

Business systems update root references in a batch:

```ts
export type CasReferences = Readonly<Record<CasHash, number>>;
export type CasRefChanges = Readonly<Record<CasHash, number>>;

export interface CasRootRefUpdate {
  readonly requestId: string;
  readonly changes: CasRefChanges; // signed non-zero integer deltas
}
```

The internal update operation:

1. validates a non-empty, bounded request ID;
2. canonicalizes and hashes the change set;
3. checks the idempotency table;
4. if the same request ID and payload already succeeded, returns success;
5. if the same request ID has a different payload, returns conflict;
6. verifies every positively referenced target is ready;
7. verifies every resulting `rootRefCount` is non-negative;
8. applies all changes in one D1 transaction;
9. records the successful request ID and payload hash in that transaction.

Every hash in `changes` must identify an existing D1 node, including hashes with negative deltas. Each delta must be a non-zero safe integer within configured per-request bounds. The service checks addition overflow before applying it. Empty change sets, unknown hashes, non-integer values, overflow, and results below zero reject the entire batch.

This API is internal and is not exposed through the public HTTP surface.

A deterministic request ID is recommended, for example:

```text
doc:{documentId}:version:{version}:add-refs
doc:{documentId}:truncate:{firstVersion}-{lastVersion}:remove-refs
snapshot:{documentId}:{version}:add-refs
```

Idempotency is required for timeout and retry safety. It does not introduce an owner model; aggregate root counts remain scoped only by user and hash.

## 10. Service-side TypeScript API

```ts
export interface UserCasService {
  read(hash: CasHash): Promise<Uint8Array>;
  metadata(hash: CasHash): Promise<CasNodeMetadata>;

  lease(
    descriptor: CasNodeDescriptor,
    requestedDurationMs: number,
    provideContent: () => Promise<Uint8Array>,
  ): Promise<CasLeaseResult>;

  /** Extend a known node's lease; rejects unless it is ready. */
  leaseExisting(
    hash: CasHash,
    requestedDurationMs: number,
  ): Promise<CasLeaseResult>;

  updateRootRefs(update: CasRootRefUpdate): Promise<void>;

  usage(): Promise<CasUsage>;
  triggerGc(options?: { maxNodes?: number }): Promise<CasGcResult>;
}

export interface CasUsage {
  readonly nodeCount: number;
  readonly readyContentBytes: number;
  readonly notReadyNodeCount: number;
  readonly leasedNodeCount: number;
}

export interface CasGcResult {
  readonly examined: number;
  readonly deleted: number;
  readonly reclaimedContentBytes: number;
}
```

`lease()` calls `provideContent()` only when the node is not ready. This avoids retransmitting content that already exists.

`leaseExisting()` is used by document apply flows. It has no descriptor or content callback: the node must already have matching D1 metadata and canonical R2 content. A not-ready node is rejected so the client can complete a lease-with-content request first.

## 11. Authenticated HTTP API

Public CAS endpoints live under `/users/{userId}/cas/`. Document APIs live under `/users/{userId}/docs/{docType}/`. The path `userId` is the current identity. Future Bearer tokens must bind to that userId; a mismatch will be rejected.

HTTP upload is a lease that carries content. Extending a ready node uses a separate path with no body.

### 11.1 Read content

```http
GET /users/{userId}/cas/nodes/{sha256}/content
Authorization: Bearer ...
```

Responses:

- `200` with binary content for a ready node;
- `404` for unknown or not-ready nodes.

### 11.2 Read metadata

```http
GET /users/{userId}/cas/nodes/{sha256}/metadata
Authorization: Bearer ...
```

Returns immutable metadata and mutable state. Unknown nodes return `404`.

### 11.3 Lease with content

```http
POST /users/{userId}/cas/nodes/{sha256}
Authorization: Bearer ...
Content-Type: image/png
Content-Length: 12345
X-CAS-Refs: <hash>[,<hash>...]
X-CAS-Lease-Duration: 900000

<raw bytes>
```

`X-CAS-Refs` may be omitted for a leaf node. `X-CAS-Lease-Duration` may be omitted (default 15 minutes, clamped to 1 minute … 24 hours).

If the node is already ready and immutable metadata matches, the service cancels the body, extends the lease, and returns success. Otherwise it reads the body, verifies the digest, writes R2, then commits the D1 row.

```json
{
  "hash": "...",
  "ready": true,
  "leaseStartedAt": 1787100000000,
  "leaseExpiresAt": 1787100900000
}
```

### 11.4 Extend an existing lease

```http
POST /users/{userId}/cas/nodes/{sha256}/lease
Authorization: Bearer ...
X-CAS-Lease-Duration: 900000
```

No body. Missing nodes return `404`. A not-ready node returns `409`; the caller must use lease-with-content.

A successful response is the same lease result as 11.3.

### 11.5 User control plane

```http
GET  /users/{userId}/cas/usage
POST /users/{userId}/cas/gc
Authorization: Bearer ...
```

GC is advisory. Triggering it does not guarantee that every eligible node is removed in one call.

## 12. DocumentType integration

Document types receive read-only, user-scoped CAS access.

```ts
export interface CasRef {
  readonly kind: "cas";
  readonly hash: CasHash;
}

export interface CasReadContext {
  read(ref: CasRef): Promise<Uint8Array>;
  metadata(ref: CasRef): Promise<CasNodeMetadata>;
}

export interface DocumentTypeContext {
  readonly cas: CasReadContext;
  readonly signal?: AbortSignal;
}
```

The context already contains the authenticated user scope. A document type neither receives nor selects a user ID.

Every lifecycle method receives the context:

```ts
export interface DocumentType<TDoc, TQuery, TOp> {
  refsFromSnapshot(data: Uint8Array): CasReferences;
  refsFromOp(operation: TOp): CasReferences;

  init(context: DocumentTypeContext): Promise<TDoc>;
  query(query: TQuery, doc: TDoc, context: DocumentTypeContext): Promise<QueryValue>;
  apply(
    operations: readonly TOp[],
    doc: TDoc,
    context: DocumentTypeContext,
  ): Promise<TDoc>;
  load(data: Uint8Array, context: DocumentTypeContext): Promise<TDoc>;
  save(doc: TDoc, context: DocumentTypeContext): Promise<Uint8Array>;

  contentType: string;
  tools: Record<string, AgentToolDefinition>;
  instructions: string;
}
```

Reference extractors are synchronous pure functions:

- no CAS access;
- no I/O;
- no mutation;
- no hidden persistence;
- positive safe-integer counts only; zero entries are omitted.

`refsFromSnapshot` remains synchronous by design. It is intended for custom snapshot formats that explicitly encode UniDocs CAS references. Ordinary self-contained formats return an empty map.

For DOCX:

```ts
refsFromSnapshot: () => ({});
```

DOCX snapshots contain embedded image bytes and therefore do not retain the source image CAS nodes.

## 13. Delta transaction flow

For an apply request, the SDK:

1. aggregates references using `refsFromOp` for every operation;
2. calls `leaseExisting` to extend leases and verify every referenced node is ready;
3. runs `DocumentType.apply()` against a working document;
4. serializes the resulting document;
5. writes the Delta to DO SQLite;
6. calls idempotent `updateRootRefs()` with positive deltas;
7. only after root-reference success commits in-memory document/version and KV snapshot state.

If step 6 fails, the SDK deletes the newly inserted Delta and discards the working document.

`refsFromOp()` never creates nodes and never supplies upload content. Clients create nodes through the CAS lease-with-content API before submitting a Delta. If `leaseExisting` finds a not-ready reference, apply fails and the client must complete a lease-with-content request before retrying.

The accepted residual failure is:

```text
Delta insert succeeds
-> root-reference update fails
-> compensating Delta delete also fails
```

This can leave one document history entry whose referenced CAS content may later disappear. The probability is considered low; document-level repair/compensation will handle this case. The design deliberately does not add a cross-storage owner/outbox model in the first version.

## 14. Snapshot and history lifecycle

Persisting a custom snapshot:

1. serialize snapshot bytes;
2. store the snapshot itself as a CAS node;
3. call `refsFromSnapshot(snapshotBytes)`;
4. increment root counts for any external CAS refs returned by the custom format;
5. record the snapshot index only after required reference updates succeed.

For self-contained DOCX and Markdown snapshots, `refsFromSnapshot()` is empty.

When history truncation is introduced:

1. aggregate `refsFromOp()` for removed Deltas;
2. remove or mark the history range unavailable;
3. decrement root counts with an idempotent request ID;
4. compensate at the business layer if the cross-storage sequence partially fails.

Loading, replaying, rolling back, querying, and cloning must never change root reference counts. Reference changes are tied only to persistence or retention lifecycle events.

## 15. Query values

`TQuery` remains transient and does not automatically accept CAS refs.

`QueryValue` continues to support `Uint8Array`. Runtime adapters may encode binary values as tagged base64 JSON. Query execution must not persist temporary results into CAS.

A query may return a `CasRef` only when that ref already exists as part of persistent document state. It must not create a new CAS node merely to return query data.

## 16. First implementation scope

The first implementation should include:

- user-scoped CAS Durable Object queue;
- D1 node/edge tables and both non-negative ref counts;
- R2 content storage;
- lease with content and authenticated lease extension;
- ready checks for reads and references;
- idempotent batched root-reference updates;
- GC for zero-referenced, expired nodes;
- usage and manual GC endpoints;
- read-only `DocumentTypeContext`;
- synchronous `refsFromSnapshot` and `refsFromOp` hooks.

Deferred work:

- automatic GC scheduling policy refinements;
- storage quotas and billing policy;
- repair tooling for rare cross-storage Delta corruption;
- CAS-backed DOCX image operations;
- historical compaction and reference release.
