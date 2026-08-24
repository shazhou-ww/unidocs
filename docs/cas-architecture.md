# CAS Architecture

Status: SValue/SBlob core implemented; legacy migration and retention tooling pending

Date: 2026-08-21

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

A dedicated CAS worker owns `CasDurableObject`, D1 `CAS_DB`, and R2 `CAS_R2`. The Gateway allowlist-proxies only the public routes in this section to service binding `CAS_SERVICE`, injecting `X-Internal-Token` and `X-User-Id` from the path. Unknown `/users/{userId}/cas/...` paths, including `root-refs`, are not proxied.

CAS requires `X-Internal-Token` on every request and never reads an end-user Bearer. Document Editors call the same CAS worker through `CAS_SERVICE`; they do not HTTP-hairpin through the Gateway.

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

### 11.6 Internal root ownership

Editors assign durable roots by stable owner, not by caller-computed count deltas:

```http
POST /_internal/root-assignments
X-Internal-Token: ...
X-User-Id: {userId}
Content-Type: application/json

{
  "requestId": "doc:documentId:version:7:roots",
  "assignments": [
    { "owner": "doc:documentId:delta:7", "hash": "..." },
    { "owner": "doc:documentId:snapshot:7", "hash": "..." }
  ]
}
```

CAS stores `(user_id, owner, hash)`. In one idempotent D1 batch it reads prior
assignments, derives aggregate count changes, updates `rootRefCount`, replaces
owner rows, and records the request hash. Assigning `hash: null` releases an
owner. Two owners of the same hash count independently.

The legacy `/_internal/root-refs` route remains only for migration of old
operation roots. Neither internal route is Gateway-proxied.

### 11.7 Internal portable nodes

Document workers exchange the canonical full-node representation from
[CAS Binary Format](./cas-binary-format.md):

```http
GET  /_internal/nodes/{hash}
POST /_internal/nodes/{hash}
X-Internal-Token: ...
X-User-Id: {userId}
Content-Type: application/vnd.unidocs.cas-node
```

GET returns header, content type, ordered child hashes, and own content in one
response. POST accepts the same bytes and avoids an unbounded child-ref HTTP
header. CAS validates the header, refs, children, content length, SValue tags,
and complete digest before publishing the node.

Public leaf upload and content/metadata endpoints remain compatible.

## 12. SValue and SBlob

All document states, queries, operations, and query results use the restricted
`SValue` model. Binary values are stored nodes represented by branded `SBlob`
handles:

```ts
interface SBlob {
  readonly [privateSignature]: true;
  readonly hash: string;
}

type SValue =
  | string | number | boolean | null | SBlob
  | readonly SValue[]
  | { readonly [key: string]: SValue };
```

SValue version 1 is deterministic RFC 8949 CBOR with media type:

```text
application/vnd.unidocs.svalue+cbor;version=1
```

SBlob is CBOR tag 65536 around exactly 32 hash bytes. Encoding walks values in
deterministic order and returns both bytes and ordered direct child refs.
Duplicate handles remain duplicate refs. Decoding uses strict limits, a bounded
pre-allocation tokenizer, deterministic re-encoding, and byte equality.

For this reserved content type, CAS derives refs from tags and rejects
caller-supplied metadata that differs. Doctypes never implement reference
extractors.

## 13. DocumentType integration

The runtime binds one authenticated SBlob context per document and curries it
into the doctype factory:

```ts
interface DocumentTypeContext {
  makeSBlob(
    hash: string,
    loadData: () => Promise<SBlobData>,
  ): Promise<SBlob>;
  makeSBlob(data: SBlobData): Promise<SBlob>;
  readSBlob(blob: SBlob): Promise<SBlobData>;
}

type DocumentTypeFactory<TDoc, TQuery, TOp> =
  (context: DocumentTypeContext) => DocumentType<TDoc, TQuery, TOp>;
```

The hash-first overload leases an existing node without invoking `loadData`.
For a missing node it calls the callback once, derives SValue refs when needed,
leases distinct children, verifies the complete logical digest, and uploads.

`readSBlob` verifies metadata, content length, SValue refs, and digest. Reads and
in-flight promises use a bounded context-scoped cache; returned bytes are copies.
The doctype sees no user ID, HTTP, lease, root-count, or CAS metadata API.

Core defines only `Context -> DocumentType`. A doctype that needs options owns
an outer `Options -> Factory` function.

```ts
interface DocumentType<TDoc, TQuery, TOp> {
  init(): Promise<TDoc>;
  query(query: TQuery, doc: TDoc): Promise<SValue>;
  apply(operations: readonly TOp[], doc: TDoc): Promise<TDoc>;

  formats: Readonly<Record<string, DocumentFormat<TDoc>>>;
  defaultFormat: string;
}
```

Named formats perform external import/export only. TDoc itself is the snapshot
shape. Agent tools are a separate contract:

```ts
interface DocumentAgent {
  tools: Readonly<Record<string, AgentToolDefinition>>;
  instructions: string;
  toolCall(name: string, parameters: JsonValue): Promise<AgentToolResult>;
}
```

The context-bound handler converts JSON DTOs such as `{hash}` to typed domain
operations containing SBlob. Provider-neutral result content may reference an
SBlob internally; a provider renderer reads it and emits the model vendor's
media representation. SBlob never appears in JSON or directly on the provider
wire.

## 14. Delta transaction flow

Each committed version stores a retained SValue delta root. Selected versions
also store an independent retained TDoc snapshot root.

Apply is an outbox state machine:

1. authenticate the request user against the stored document owner;
2. settle an older pending version and check `baseVersion`;
3. decode and validate already-canonical operations;
4. store the operation batch as an SValue delta root;
5. run doctype apply against immutable current state;
6. optionally store the resulting TDoc as a snapshot root;
7. write one local `svalue_pending` row containing hashes and canonical bytes;
8. idempotently assign delta and optional snapshot root owners in CAS;
9. insert local committed rows and delete the pending row;
10. publish the new in-memory state and return success.

If CAS times out, pending bytes allow recovery to re-ensure nodes. If local
finalization fails after CAS success, owner assignment is idempotent and the
pending row is finalized on restart. There is no compensating-delete window.

Version 1 does not persist a TDoc head on every delta. Active SBlob leases protect
the in-memory state between snapshots. Normal startup loads the latest standalone
snapshot and replays retained delta roots. Default snapshot cadence is 10 deltas;
the snapshot endpoint may retain the current version opportunistically.

## 15. Snapshot and history lifecycle

- Delta owner: `doc:{docId}:delta:{version}`.
- Snapshot owner: `doc:{docId}:snapshot:{version}`.
- Delta and snapshot roots may share descendants; redundant protection is
  intentional.
- A restore is a retained delta containing `{kind: "restore", doc: SBlob}`;
  replay jumps to that standalone state instead of recording an empty operation.
- Same-user clone retains the source snapshot DAG in the destination partition.
  Cross-user clone is rejected until recursive authorized DAG copy exists.
- Before future history truncation, the surviving boundary receives a standalone
  snapshot; removed owner rows are then released idempotently.

DOCX TDoc is a two-level OpenXML Merkle manifest:

```ts
interface DocxDoc {
  readonly kind: "openxml-package";
  readonly files: Readonly<Record<AbsoluteOpcPath, SBlob>>;
}
```

The doctype uses public Ariadng `ZipReader`, `ZipWriter`, and `Document.open/save`
to convert between the manifest and a cached in-memory Document. Apply clones a
working document and stores changed package leaves; unchanged hashes reuse nodes.
ZIP paths, content types, CRC, entry count, compression ratio, part size, and
total size are bounded and validated.

## 16. Query and transport values

Query results are SValue. Inline `Uint8Array` and the old base64 `QueryValue`
escape layer are removed. Binary query state is an existing SBlob or a named
format download.

Query/apply/history accept SValue CBOR. A temporary JSON adapter remains for
values with no SBlob. Responses containing SBlob require an SValue `Accept`
header and return `406` to JSON-only callers.

Implemented validation includes unit vectors, CAS/SDK tests, Markdown and DOCX
restart recovery, rollback, same-user and cross-user clone behavior, native
SValue image operations, JSON agent tool-hash conversion, provider-rendered
multimodal SBlob results, and independent delta plus snapshot retention of
shared image blobs.

Deferred operational work:

- automatic GC scheduling and quotas;
- owner-prefix cleanup and count-repair tooling;
- production migration and reconciliation of legacy snapshot R2/root counts;
- history truncation and document deletion APIs;
- CBOR tag registration before version 1 production persistence.
