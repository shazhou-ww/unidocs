# SValue, SBlob, and CAS-Native Document Protocol Plan

> **Superseded CAS contract (2026-08-26):** This is a historical implementation
> record. Owner assignments, portable-node HTTP, shared keys, tenantless routes,
> and tenant-only CAS namespaces are not current guidance. See
> [CAS Middleware](./2026-08-26-cas-middleware.md) and
> [CAS Architecture](../../cas-architecture.md).

Status: core implementation complete; production migration/retention tooling pending (2026-08-21)

This plan supersedes the `DocumentType` integration, query-value, delta, and
snapshot model in sections 12-15 of
[CAS Architecture](../../cas-architecture.md) once accepted and implemented.

## Goal

Hide CAS behind stored-blob values, require document state and protocol values
to be serializable, and let the runtime derive all Blob references without
doctype-specific `refsFromOp` or `refsFromSnapshot` functions.

The durable model is deliberately redundant:

- every delta stores and retains a CAS SValue root containing `TOp[]`;
- selected versions store and retain an independent CAS SValue root containing
  `TDoc`;
- both roots retain their own directly referenced SBlobs through normal CAS
  child edges;
- snapshots never form a version chain.

A delta root makes replay inputs durable between snapshots. A snapshot root
makes recovery faster and provides a safe history-truncation boundary.

## Agreed decisions

1. `SBlob` has a module-private symbol brand in memory. User properties cannot
   impersonate or overwrite the marker.
2. UniDocs owns an `SValue <-> Uint8Array` codec. The proposed format is a
   strict deterministic profile of RFC 8949 CBOR.
3. Core defines `Context -> DocumentType`. Optional doctype configuration is an
   outer doctype-owned function: `Options -> Context -> DocumentType`.
4. `makeSBlob(hash, loadData)` checks the expected hash first and calls
   `loadData` only when CAS needs the content.
5. `TDoc`, `TQuery`, and `TOp` extend `SValue`; query results are also SValue.
6. `load` and `save` become external format import/export operations. They are
   not snapshot hooks.
7. DOCX `TDoc` is an OpenXML package manifest mapping paths to file SBlobs.
   Ariadng state is a document-scoped cache.
8. DOCX export must be semantically valid, not byte-identical or deterministic.
9. A doctype may expose multiple named import/export formats.
10. Version 1 keeps periodic snapshots rather than storing a TDoc snapshot for
    every delta.
11. `DocumentType` has no `snapshotFormat`. A snapshot is always the canonical
  SValue serialization of TDoc; named formats are never persistence codecs.
12. A doctype whose editing model is not an SValue exposes a separate stored
  TDoc and keeps the editing model in a scoped cache. PSD therefore uses
  `PsdStoredDoc` as TDoc and treats `PsdDoc` only as a materialized model.

## 1. Core contract

The target contract is conceptually:

```ts
declare const sBlobSignature: unique symbol;

export interface SBlob {
  readonly [sBlobSignature]: true;
  readonly hash: string;
}

export interface SBlobData {
  readonly data: Uint8Array;
  readonly contentType: string;
}

export type SPrimitive = string | number | boolean | null | SBlob;
export type SValue =
  | SPrimitive
  | readonly SValue[]
  | { readonly [key: string]: SValue };

export type SValueShape<T> =
  T extends SPrimitive ? T
    : T extends (...args: never[]) => unknown ? never
      : T extends readonly unknown[] ? { readonly [K in keyof T]: SValueShape<T[K]> }
        : T extends object ? { readonly [K in keyof T]: SValueShape<T[K]> }
          : never;

export interface MakeSBlob {
  (hash: string, loadData: () => Promise<SBlobData>): Promise<SBlob>;
  (data: SBlobData): Promise<SBlob>;
}

export interface DocumentTypeContext {
  readonly makeSBlob: MakeSBlob;
  readonly readSBlob: (blob: SBlob) => Promise<SBlobData>;
}

export type SValueType<T> = T extends SValueShape<T> ? T : never;

export interface DocumentFormat<TDoc> {
  readonly mediaTypes: readonly string[];
  readonly extensions: readonly string[];
  load(data: Uint8Array): Promise<SValueType<TDoc>>;
  save(doc: SValueType<TDoc>): Promise<Uint8Array>;
}

export interface DocumentType<
  TDoc,
  TQuery,
  TOp,
> {
  init(): Promise<SValueType<TDoc>>;
  query(query: SValueType<TQuery>, doc: SValueType<TDoc>): Promise<SValue>;
  apply(
    operations: readonly SValueType<TOp>[],
    doc: SValueType<TDoc>,
  ): Promise<SValueType<TDoc>>;

  readonly formats: Readonly<Record<string, DocumentFormat<TDoc>>>;
  readonly defaultFormat: string;
}

export type DocumentTypeFactory<
  TDoc,
  TQuery,
  TOp,
> = (context: DocumentTypeContext) => DocumentType<TDoc, TQuery, TOp>;
```

The eager `makeSBlob(data)` overload is only a convenience for bytes already in
memory. The hash-first overload remains the lazy primitive.

Core has no `TOptions` generic. A configured doctype owns the outer function:

```ts
function createDocxDocumentType(
  options: DocxOptions,
): DocumentTypeFactory<DocxDoc, DocxQuery, DocxOperation> {
  return context => ({ /* implementation */ });
}
```

A doctype with no options exports a `DocumentTypeFactory` directly and does not
invent an empty options type.

### Runtime invariants

- A real SBlob is frozen, has a valid full lowercase SHA-256 hash, and carries
  the private symbol.
- `isSBlob` checks both brand and hash. The brand prevents accidental collision;
  it is not authorization.
- Decoded SValues are recursively frozen before doctype code receives them.
- Validation accepts primitives, dense arrays, and plain own-data string
  properties only. It rejects accessors, class instances, inherited data,
  functions, symbol keys, cycles, and sparse arrays.
- `undefined` is not an SValue. Existing `payload: undefined` fields become
  omitted fields or `payload: null`.
- Doctype outputs are validated and frozen before persistence or response.
- SValues cross durable boundaries as codec bytes or CAS hashes, never by
  assuming structured clone preserves symbols.

## 2. SValue codec version 1

Use base `cborg`, not `cborg/extended`, behind UniDocs-owned APIs:

```ts
encodeSValue(value: SValue): Uint8Array;
decodeSValue(data: Uint8Array): SValue;
```

The exact media type is:

```text
application/vnd.unidocs.svalue+cbor;version=1
```

An incompatible encoding gets a new version and never changes version 1 bytes.

### SBlob wire form

An SBlob encodes as:

```text
CBOR tag 65536(byte string containing exactly 32 hash bytes)
```

Tag 65536 was unassigned when this plan was written. It is profile-local until
registered. The tag must be frozen or replaced before production version 1 data
is written; afterward it is immutable.

Only the private symbol produces this tag during encoding. Only this tag creates
a branded SBlob during decoding. Untagged byte strings and unknown tags are not
SValue and are rejected, so ordinary object properties cannot collide with it.

### Deterministic rules

The encoder follows RFC 8949 core deterministic encoding:

- definite lengths only;
- shortest integer, length, tag, and exact floating-point forms;
- map keys sorted by bytewise lexical order of their encoded bytes;
- string map keys only;
- exactly one top-level value with no trailing bytes.

Additional SValue rules:

- numbers are finite;
- integral numbers are safe integers and encode as CBOR integers;
- fractional numbers use the shortest exact IEEE 754 representation;
- negative zero normalizes to positive zero;
- `NaN`, infinities, bigint, CBOR undefined, and other simple values reject;
- strings and keys contain Unicode scalar values; isolated UTF-16 surrogates
  reject instead of being replaced by `TextEncoder`;
- Unicode is not normalized;
- duplicate map keys and unknown tags reject.

`cborg` cannot enforce shortest floats or map order while decoding. Therefore a
strict decode is followed by deterministic re-encoding and byte-for-byte input
comparison. A mismatch rejects the value. This prevents semantically equal data
from acquiring multiple CAS identities.

### Generic reference derivation

The internal encoder returns both bytes and direct references in one canonical
traversal:

```ts
interface EncodedSValue {
  readonly data: Uint8Array;
  readonly refs: readonly string[];
}
```

Each SBlob tag contributes one direct child hash in encoded preorder. Ordered
duplicates remain because CAS identity and `childRefCount` treat each occurrence
as significant.

This one mechanism handles both durable roots:

```text
encode TOp[] -> delta root bytes + referenced Blob hashes
encode TDoc  -> snapshot root bytes + referenced Blob hashes
```

No doctype understands CAS reference counts or walks its own schema.

Decoding derives the same ref sequence. For an SValue CAS node, that sequence
must exactly match immutable CAS metadata or the node is corrupt.

### Defensive limits and vectors

All codec entry points have explicit limits for bytes, depth, decoded values,
map entries, array entries, string bytes, and direct refs. Declared lengths are
checked before large allocation.

Fixed vectors cover primitives, maps in different insertion orders, SBlobs,
duplicate refs, malformed/non-canonical forms, duplicate keys, invalid UTF-8,
isolated surrogates, deep nesting, oversize declarations, trailing bytes,
cycles, sparse arrays, getters, and prototype-sensitive keys.

## 3. SBlob runtime

`DocumentTypeContext` is bound to one authenticated user and one document. It
does not expose a user ID, CAS client, HTTP, lease duration, or root counts.

### makeSBlob

For `makeSBlob(expectedHash, loadData)`:

1. Validate the expected full CAS hash.
2. Call `leaseExisting(expectedHash)`.
3. If ready, return a frozen SBlob without calling `loadData`.
4. If missing or not ready, call `loadData` exactly once.
5. Validate content type and size.
6. For the exact SValue version 1 content type, strictly decode and derive
   ordered direct refs. Every other content type is a leaf with no refs.
7. Lease each distinct direct child. Keep duplicates in metadata but avoid
   duplicate lease calls.
8. Recompute the complete CAS logical-node digest from content type, refs, and
   bytes. Reject a mismatch with `expectedHash`.
9. Create/lease the node with the derived descriptor and content.
10. Return only after CAS reports ready.

If the parent already exists, its child edges already protect descendants, so
recursive child leasing is unnecessary. For a missing parent, direct-child
leases close the GC race before parent edges commit. Ready children protect
their own descendants.

The eager overload derives the expected hash locally and follows the same path.
The lazy overload avoids loading or transmitting known content, but cannot avoid
reading new local content that must first be hashed.

### readSBlob

`readSBlob` returns verified `SBlobData` or throws a typed not-found, not-ready,
authorization, integrity, limit, or transport error. It does not return `null`:
a stored handle disappearing is exceptional, not document data.

The adapter verifies immutable metadata, byte length, full logical digest, and
SValue refs when applicable. It does not recursively load children.

Immutable content and in-flight reads may be cached, but caches are bounded and
scoped to the authenticated context. A global hash-only cache could leak user B's
content to user A. Negative results are not cached long-term because a missing
hash may be uploaded later.

### Active transient TDoc

Version 1 does not persist a new TDoc snapshot for every delta. The current TDoc
and doctype model are in-memory caches between snapshots. New SBlobs created by
`apply` receive leases from `makeSBlob`; they are pinned only when a later
snapshot references them.

Before invoking a doctype method, the runtime refreshes leases for direct SBlobs
in the current TDoc. If a transient child has already been collected, the
runtime discards current caches and reconstructs state from the latest retained
snapshot plus retained deltas. It then retries the method once. This is repair,
not a normal null result from `readSBlob`.

A document with expensive replay may take an opportunistic snapshot, but this
does not change the protocol or turn every delta into a snapshot.

## 4. CAS root ownership

The current root API stores aggregate signed counts but no owner. Once deltas
and snapshots are generic roots, ownerless counts make lost decrements,
duplicate increments, and document deletion hard to repair.

Add owner-bound root assignment:

```ts
interface CasRootAssignment {
  readonly owner: string;
  readonly hash: string | null;
}

interface CasAssignRootsRequest {
  readonly requestId: string;
  readonly assignments: readonly CasRootAssignment[];
}
```

CAS stores `(user_id, owner, hash)` and transactionally derives count changes
from old and new assignments. Callers never submit count deltas. New hashes must
be ready. Repeating one request is a no-op; reusing its ID with another payload
conflicts.

Owner names are deterministic:

```text
doc:{docId}:delta:{version}
doc:{docId}:snapshot:{version}
```

Every committed delta has one delta owner. Snapshot versions additionally have
one snapshot owner. The two may retain overlapping Blob descendants, which is
intentional redundant protection. Removing history assigns `null` to the
corresponding owners.

CAS also needs owner-prefix list/cleanup and a repair assertion:

```text
node.root_ref_count == count(root-owner rows for user and node)
```

The old signed-count API remains only for migration and is then removed.

## 5. Editor persistence and transactions

The local durable model records:

- committed deltas with version, SValue root hash, timestamp, and description;
- retained snapshots with version and TDoc root hash;
- at most one pending commit/outbox record;
- the latest committed version and snapshot version.

There is no per-delta durable TDoc head in version 1. Normal restart loads the
latest standalone snapshot and replays later delta roots.

### Apply

1. Authenticate the request user and require it to equal the stored document
   owner before creating a context.
2. Settle an older pending commit, then check `baseVersion`.
3. Decode, validate, and freeze `TOp[]`.
4. Encode and `makeSBlob` the delta root. This derives and leases every SBlob
   referenced by operations.
5. Ensure the current TDoc's transient refs are ready or rebuild current state.
6. Run `DocumentType.apply`; validate and freeze the returned TDoc.
7. If snapshot policy triggers, encode and `makeSBlob` the TDoc snapshot root.
8. In one local transaction, insert a pending version containing delta hash and
   optional snapshot hash.
9. In one idempotent CAS request, assign the delta owner and optional snapshot
   owner.
10. In one local transaction, mark the version and snapshot committed.
11. Only then publish the new in-memory TDoc/cache and return success.

If CAS assignment fails transiently, the pending row stays invisible and is
retried. If local finalization fails after CAS success, retrying CAS is
idempotent and recovery finishes the local commit. Permanently invalid pending
work is aborted; unpinned nodes expire after their leases.

This removes the current residual failure where delta insertion succeeds, root
updates fail, and compensating deletion also fails.

Initial snapshot cadence is every 10 deltas and configurable. Snapshot cadence
is policy, not part of the codec or stored schema.

### Recovery and replay

1. Instantiate one context-curried doctype after loading stored user identity.
2. Settle any pending commit.
3. Load and decode the nearest retained snapshot.
4. Load and decode each later delta root in version order.
5. Apply operations to reconstruct current TDoc and populate the doctype cache.
6. Treat a missing/corrupt retained root as repair-required; never continue with
   partial history.

### Rollback

An empty synthetic delta cannot replay a rollback. Runtime history events are:

```ts
type StoredDelta<TOp extends SValue> =
  | { readonly kind: "apply"; readonly operations: readonly TOp[] }
  | { readonly kind: "restore"; readonly doc: SBlob };
```

Rollback reconstructs the target, stores a standalone TDoc root, and commits a
`restore` delta root that references it. Replay jumps to that doc when it sees
the restore event. The restore delta owner protects its target even if snapshot
retention later changes.

### Truncation, deletion, and clone

History truncation first creates a standalone snapshot at the surviving
boundary, then clears removed delta/snapshot owners through an idempotent pending
operation, then deletes local rows.

Document deletion clears all root owners before deleting the local owner ledger.
Owner-prefix repair handles damaged local state without permanent root leaks.

Same-user clone assigns a retained snapshot root to a new document snapshot
owner. Cross-user clone cannot treat a hash as a global capability; version 1
rejects it until an authorized recursive DAG-copy operation exists.

## 6. HTTP and agent-tool boundaries

It is not sufficient to add TypeScript constraints while continuing to cast
`request.json()` to `TQuery` or `TOp`. JSON loses the symbol and cannot represent
the SBlob tag.

Query, apply, history, and stored-state payloads use the SValue media type.
Runtime envelopes such as `baseVersion` and `description` are SValue maps. A
temporary JSON adapter may accept values containing no SBlob, but it validates
the same restricted model and is removed after SDK migration.

Raw import remains multipart/binary. Raw export uses the selected external
format media type.

LLM tool arguments remain JSON and are not themselves `TOp`. A blob-taking tool
accepts an explicit hash string. A separate context-bound `DocumentAgent`
handler resolves it through Editor and constructs the branded operation. Strict
document `/apply` accepts only canonical `TOp`; there is no globally magical
JSON property.

Agent parameters and structured results use a strict `JsonValue` type. A tool
may additionally return provider-neutral multimodal content whose image/file
parts reference internal SBlobs:

```ts
interface DocumentAgent {
  readonly tools: Readonly<Record<string, AgentToolDefinition>>;
  readonly instructions: string;
  toolCall(name: string, parameters: JsonValue): Promise<AgentToolResult>;
}

interface AgentToolResult {
  readonly structuredContent?: JsonValue;
  readonly content?: readonly AgentContentPart[];
}
```

SBlob is never sent directly to the model. The provider adapter receives the
result plus an authorized `readBlob` capability and converts media to that
provider's image block, file ID, or temporary URL format. The default renderer
supports JSON and text only and rejects image/file parts explicitly.

The old `QueryValue` inline `Uint8Array`/base64 layer is removed. Binary query
data is an existing SBlob or a format download, not an inline SValue primitive.

## 7. DOCX OpenXML Merkle state

```ts
export interface DocxDoc {
  readonly kind: "openxml-package";
  readonly files: Readonly<Record<string, SBlob>>;
}
```

Keys are canonical OPC part names with one leading slash. Reject backslashes,
`.`/`..`, empty segments, query/fragment, trailing slash, and duplicate
canonical paths. ZIP directory entries are not state.

Each file is a leaf SBlob. Resolve its content type deterministically from
`[Content_Types].xml`, including package metadata parts. This lets an embedded
PNG/JPEG reuse an uploaded source node when bytes and content type match. Missing
or ambiguous declarations reject import.

Canonical CBOR key order makes the package root independent of ZIP entry order.

### Import and export

Import enforces entry-count, path-length, compressed-size, uncompressed-size,
compression-ratio, and total-size limits. It rejects encryption, unsupported ZIP
features, duplicate paths, CRC errors, and malformed OPC metadata. It stores
each part through `makeSBlob` and returns the immutable manifest.

Export reads leaves and assembles a valid OpenXML ZIP. Entry order, compression,
and timestamps may vary; exported bytes are not persisted as state.

### Ariadng cache and apply

One document-scoped doctype instance caches `{ value, document }`. Immutable
object identity determines a match. A query/apply reuses the model when input
matches; otherwise it rebuilds from package leaves.

Apply creates a working copy and never mutates the canonical cache. After the
batch, enumerate or save/unzip the package, resolve content types, reuse prior
SBlobs for unchanged path/hash/type tuples, create changed/new leaves, omit
deleted paths, and return a new manifest. Publish the new cache only after the
Editor commits the delta.

A prerequisite spike determines whether Ariadng has stable package and dirty
part APIs. If not, use the correct fallback: manifest -> ZIP -> `Document.open`,
then `Document.save` -> ZIP -> manifest. Isolate all `_internal()` use behind one
adapter with version-pinned tests.

Changed parts are produced by successful apply so the returned TDoc is valid,
but they are not retained as a historical snapshot until snapshot policy fires.
The delta root independently retains only SBlobs carried by its operations.

### Fanout and read amplification

A two-level root may contain many refs. The current comma-separated
`X-CAS-Refs` header is not an unbounded transport. Internal node creation uses
the canonical portable full-node body, which carries refs outside HTTP headers.
If legitimate packages exceed the limit, introduce sharded manifests rather
than truncating refs.

Content reads should return stored content type and refs with bytes. DOCX starts
bounded concurrent reads and lets the context coalesce them, avoiding two HTTP
calls per part where possible.

## 8. Multiple formats

Replace top-level `contentType/load/save` with named formats and a default:

```ts
formats: {
  docx: {
    mediaTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    extensions: [".docx"],
    load,
    save,
  },
},
defaultFormat: "docx",
```

Selection order is explicit format, unambiguous media type, then unambiguous
extension. Conflict or ambiguity is an error. A future Excel doctype can expose
`xlsx`, `xls`, and `xlsb` without changing TDoc snapshot semantics.

## 9. Correctness gaps closed by this plan

| Gap | Resolution |
|---|---|
| Symbol disappears through JSON/structured clone | Use the codec at typed HTTP and durable boundaries. |
| Snapshot-between deltas lose operation Blobs | Store and retain every TOp delta root. |
| Snapshot and delta reference sets overlap | Retain both independent roots; CAS edges account for overlap. |
| Ownerless root counters drift | Use owner-bound idempotent root assignment and repair. |
| Current unsnapshotted TDoc has expiring output leaves | Refresh active leases; replay retained roots if a leaf is gone. |
| Empty rollback delta cannot replay | Store a restore delta referencing a TDoc root. |
| CAS metadata can lie about SValue refs | Derive refs from tagged content on write and verify on read. |
| Caller treats hash as SHA-256 of raw bytes | Define and verify the full CAS logical-node digest. |
| Generic CBOR permits equivalent encodings | Decode, deterministic re-encode, and compare bytes. |
| JS Unicode replacement is non-injective | Reject isolated UTF-16 surrogates. |
| `readonly` does not enforce immutability | Validate and recursively freeze every boundary value. |
| Hash-only cache crosses users | Scope caches to authenticated context. |
| Request user differs from stored owner | Compare before context/factory creation and every dispatch. |
| LLM JSON cannot carry branded SBlob | Explicit hash DTO -> user-scoped SBlob adapter. |
| Multimodal providers use incompatible media blocks | Return provider-neutral SBlob content parts; render at the provider boundary. |
| DOCX ZIP bomb/path alias | Bounded ZIP/OPC validation and canonical paths. |
| Ref headers and per-part reads do not scale | Internal descriptor body, limits, metadata-with-content, coalescing. |
| Cross-user clone assumes global hashes | Reject in v1; later copy the DAG into destination scope. |
| Codec changes invalidate hashes | Freeze media type, tag, vectors, and dependency behavior first. |
| Legacy 16-hex snapshot IDs look like CAS IDs | Re-import bytes and create full CAS roots during migration. |

## 10. Implementation tasks

### Task 1: Core codec and contract

- [x] Spike `cborg` in Node and a Worker bundle.
- [x] Verify custom tags, RFC 8949 sorting, shortest numbers, duplicate-key
  rejection, strict limits, and re-encode equality.
- [ ] Freeze/register tag 65536 before production vectors.
- [x] Implement SBlob construction, validation/freezing, codec, and
  encode-with-refs.
- [x] Add fixed vectors and hostile-input tests.
- [x] Replace core types with SValue, context-curried factory, and named formats.

Verify `@unidocs/core` tests and typecheck.

### Task 2: CAS roots and SValue integrity

- [x] Add root-owner schema and bounded idempotent `assignRoots`.
- [x] Derive counts inside the per-user CAS transaction.
- [ ] Add owner-prefix cleanup and count-repair diagnostics.
- [x] Add internal node creation without ref headers.
- [x] Derive SValue refs from content.
- [x] Return metadata with content reads.
- [x] Keep signed root deltas only for legacy migration.

Test retries/conflicts, overlapping descendants, missing content, corruption,
owner replacement/removal, repair, and GC races.

### Task 3: SBlob context adapter

- [x] Hide `CasClient` behind both `makeSBlob` overloads and `readSBlob`.
- [x] Test loader invocation count, missing/not-ready recovery, digest mismatch,
  duplicate child refs, bounded caches, and user isolation.
- [x] Implement active-TDoc lease refresh and replay-on-missing once.

### Task 4: Editor delta/snapshot state machine

- [x] Accept a configured `DocumentTypeFactory`, instantiate per document/user.
- [x] Persist full hashes, delta roots, snapshot roots, and one pending outbox.
- [x] Implement pending -> assign owners -> committed recovery.
- [x] Replay latest snapshot plus later delta roots on startup.
- [ ] Implement apply/restore events, periodic snapshot, rollback, truncation,
  deletion, and same-user clone.
- [ ] Inject failure after every local/CAS step and prove convergence.

### Task 5: SValue HTTP and SDK transport

- [x] Add media-type encode/decode helpers for query/apply/history.
- [x] Validate external values instead of casting JSON.
- [x] Add temporary no-SBlob JSON compatibility.
- [x] Add explicit tool hash-to-SBlob adapters.
- [x] Separate `DocumentAgent.toolCall(JSON)` and provider-rendered multimodal
  results from `DocumentType`.
- [x] Remove `QueryValue`, `CasRef`, `refsFromOp`, and `refsFromSnapshot`.

### Task 6: Markdown first migration

- [x] Remove undefined payloads and empty options.
- [x] Add context-curried factory and named Markdown format.
- [x] Use Markdown for first recovery, rollback, clone, and history E2E tests.

### Task 7: DOCX package spike and migration

- [x] Prove Ariadng package enumeration/cloning or the ZIP fallback.
- [x] Reuse/test Ariadng's Worker-safe ZIP implementation and import limits.
- [x] Replace `{ bytes, document }` with the path manifest.
- [x] Implement content-type resolution, immutable cache/apply, part reuse, and
  nondeterministic export.
- [x] Convert image domain operations to SBlob; keep hash only in tool DTOs.
- [ ] Test unchanged hashes, failed batches, headers/footers, tables, images,
  large part counts, and bounded reads.

### Task 8: Formats, migration, and cleanup

- [x] Route named import/export formats through Gateway and SDK.
- [ ] Add a two-format test doctype.
- [ ] Lazily migrate legacy KV/R2 snapshots to full SValue CAS roots.
- [ ] Convert old image-hash deltas and reconcile direct root counts exactly once.
- [ ] Test interruption at each migration step with dual readers.
- [ ] Remove legacy snapshot R2, old contexts/hooks, and JSON delta persistence.
- [ ] Update CAS architecture/binary docs and treespec fixtures.

## 11. Acceptance criteria

- Equal SValues encode identically regardless of object insertion order;
  non-canonical bytes reject.
- Ordinary data cannot become SBlob accidentally in memory or on the wire.
- Existing `makeSBlob` hashes call no loader and upload no content.
- Each committed version owns one retained delta root; selected versions also
  own independent snapshot roots.
- Snapshot-between replay assets remain protected through delta roots.
- A doctype imports no CAS package and computes no reference map.
- Editor/CAS failures recover without visible partial versions or count drift.
- Restart reconstructs from the latest snapshot plus deltas; rollback remains
  replayable after another restart.
- DOCX snapshots reuse unchanged part hashes and export valid Office files.
- User A cannot read user B's content through a guessed hash or shared cache.
- Truncation/deletion release exactly their owned roots and repair reports no
  mismatch.

## Delivery rule

Implement tasks in order with focused tests after each. Codec vectors and
root-owner transaction tests are protocol gates. Do not combine the codec, CAS
lifecycle migration, Editor state machine, and DOCX package rewrite into one
change.

## Decision log

### 2026-08-21: Codec spike decisions

- Use `cborg@^6.1.1` base mode with `rfc8949EncodeOptions`; do not use records,
  packing, structured clone, or `cborg/extended`.
- Keep tag `65536` as the implementation-phase SBlob tag. Registration or a
  final replacement remains a release gate before version 1 production data.
- Decode CBOR maps into `Map` first, then materialize recursively frozen
  null-prototype records. This avoids `__proto__` setter behavior while keeping
  normal property lookup for doctype code.
- Derive refs in RFC 8949 encoded map order, retaining duplicates. The codec
  exposes detailed encode/decode helpers internally while the package root
  initially exports only value encode/decode.
- Enforce canonical decode by deterministic re-encoding and byte comparison,
  because `cborg` strict mode does not verify float width or map order.
- Normalize negative zero to positive zero when encoding and reject a negative
  zero wire representation as non-canonical.
- Reject isolated UTF-16 surrogates before UTF-8 conversion. The first focused
  tests caught and fixed the end-of-string `charCodeAt()`/`NaN` edge case.
- Initial default codec limits are 16 MiB encoded bytes, depth 100, 100,000
  array/map/ref entries, 32 bytes per byte string, 1 MiB per UTF-8 string, and
  1,000,000 total values. Runtime endpoints may provide stricter limits.

### 2026-08-21: Type-system compatibility

- Direct `T extends SValue` constraints reject ordinary named interfaces because
  TypeScript requires an index signature for assignment to the SValue record
  arm. Core therefore uses recursive `SValueShape<T>` and `SValueType<T>` types.
  A named interface is accepted when every reachable field is serializable;
  functions and unsupported leaves resolve the contract to `never`.
- Runtime codec validation remains authoritative. Static recursive types do not
  replace validation, freezing, depth limits, or hostile-input checks.

### 2026-08-21: Root ownership and SValue integrity

- Add `POST /_internal/root-assignments` while retaining legacy
  `/_internal/root-refs` for migration. One idempotent D1 batch moves owner rows,
  derives aggregate count changes, and records the request hash.
- Root assignment payload hashes include an operation discriminator. Legacy and
  owner-bound requests share the idempotency table but cannot be mistaken for
  each other.
- The CAS Worker imports only `@unidocs/core/internal` codec functions. This is a
  code dependency, not a Worker service dependency, and keeps SValue validation
  centralized without exposing CAS to doctypes.
- Content labelled with the exact SValue version 1 media type is decoded by CAS,
  and caller refs must exactly match the ordered tags. Public upload metadata is
  never trusted for SValue nodes.

### 2026-08-21: SBlob context adapter

- Hash-first `makeSBlob` treats only CAS 404 and not-ready 409 as reasons to call
  the loader. Transport, authorization, and other errors do not load or upload.
- Concurrent makes for one expected hash share one promise. Duplicate direct
  refs remain in immutable metadata but issue one child lease per distinct hash.
- Read cache entries are scoped to one user/document context. Only verified
  bytes enter the cache, and every doctype read receives a byte copy so mutation
  cannot poison cached content.
- Fetch and Response bodies use owned `ArrayBuffer` copies. This satisfies
  workerd BodyInit types and prevents caller mutation during transport.
- Callers must not send an arbitrary view's `.buffer` directly: it may be a
  larger pooled backing buffer. `encodeSValue` normalizes output to an offset-0,
  exact-size plain Uint8Array, and SDK transport copies arbitrary inputs with
  `Uint8Array.from`; an E2E test caught the original issue as trailing pooled
  bytes decoded as an unsafe CBOR integer.

### 2026-08-21: Editor state machine

- New state uses parallel `svalue_deltas`, `svalue_snapshots`, and
  `svalue_pending` tables instead of mutating the legacy schema in place. This
  keeps migration explicit and avoids interpreting old JSON rows as CAS roots.
- Pending rows contain canonical root bytes as well as hashes. Recovery can
  re-ensure leased content, retry idempotent owner assignment, and finalize
  local rows after a timeout at any external CAS call.
- Version 1 has no per-delta TDoc head. Startup reconstructs the latest retained
  snapshot plus later retained delta roots. A restore delta points to a
  standalone TDoc SBlob and is replayable.
- The first snapshot is retained and later snapshots default to every 10
  deltas. `GET snapshot` may add an opportunistic snapshot at the current
  version without creating a document version.
- JSON remains a temporary adapter only for SValues with no SBlob. Responses
  containing SBlob require the SValue media type and otherwise return 406.
- Worker `File` handling uses a structural uploaded-file guard because workerd's
  type surface does not guarantee a global `File` constructor.
- Local Worker bundle directories are scoped by gateway port. Script-level E2E
  files run without file parallelism so multiple cold Miniflare runtimes cannot
  overwrite one shared bundle or starve each other's startup timeout.
- `OperatorConfig` contains only the tools/instructions its runtime consumes.
  Doctypes export this static metadata separately, so Operator setup never
  constructs a document type or fabricates an SBlob context.

### 2026-08-21: Portable internal CAS nodes

- Internal document workers GET and POST the existing canonical full-node bytes
  under `/_internal/nodes/{hash}`. This reuses the CAS binary specification
  instead of inventing another descriptor envelope.
- Internal POST carries ordered refs in the body and has no `X-CAS-Refs` header.
  Public leaf upload remains unchanged. Both paths share one lazy lease core, so
  public known-node uploads still cancel the body without reading it.
- Internal GET replaces metadata + content double fetches. The SDK validates the
  portable header and the SBlob runtime still recomputes the complete digest.

### 2026-08-21: OpenXML adapter

- Reuse `@ariadng/office@0.3.0` public `ZipReader`, `ZipWriter`, `OpcPackage`,
  and `Document.open/save`; add no ZIP dependency. `_internal()` remains isolated
  to existing low-level image operations.
- Persistent DOCX state contains every non-directory ZIP entry, including
  `[Content_Types].xml` and relationship parts. Manifest keys must be absolute
  canonical OPC paths and unique under ASCII case-insensitive equivalence.
- Import limits the whole central directory, compressed ratio, total expanded
  bytes, individual part bytes, and UTF-8 path bytes. Content types are resolved
  from OPC metadata; infrastructure parts use fixed deterministic types.
- A document-scoped WeakMap caches Ariadng models by immutable TDoc identity.
  Apply clones a working model; failed/uncommitted states cannot replace the
  cache entry for the old TDoc.

### 2026-08-21: Agent tool handler and multimodal results

- Remove `DocumentType.prepareOperation` and all `query_`/`apply_` interpretation
  from the generic Operator. `DocumentType` now owns only document behavior and
  named formats.
- Each doctype exports a context-bound `DocumentAgentFactory`. Its single
  `toolCall(name, parameters)` accepts JSON and may internally issue typed query,
  apply, `resolveBlob`, and `readBlob` calls through Editor.
- Strict Editor `/apply` never accepts an uploaded hash in place of SBlob. DOCX
  hash-to-SBlob conversion exists only in its agent handler; an E2E test verifies
  that the same JSON DTO is rejected at direct apply.
- `AgentToolResult.structuredContent` is JSON. Optional text/image/file content
  is provider-neutral; image/file parts may carry SBlob internally. The Operator
  passes them to an optional provider renderer with an authorized blob reader.
- The default renderer serializes JSON/text and explicitly rejects multimodal
  content. It never degrades SBlob into `{hash}` or base64 inside JSON.
- Operator Editor stubs are selected from runtime env by stored user and
  document identity. Agent query updates optimistic-lock version; subsequent
  agent apply uses that version and persists canonical `TOp` only.
- `JsonValue` is enforced at runtime, not only in TypeScript. The boundary
  rejects SBlob, non-finite numbers, undefined, class instances, accessors,
  symbols, sparse arrays, extra array properties, and cycles; it copies objects
  to null-prototype records.
- One Operator DO binds permanently to the first authenticated user/document
  identity it sees. Later mismatched headers return `403` rather than redirecting
  its conversation or Editor capability.
- DOCX `query_getImage` is the first built-in multimodal tool. Its internal
  document query returns image metadata plus the exact package-part SBlob. The
  agent removes SBlob from structured JSON and emits an image content part;
  only the provider renderer reads bytes.