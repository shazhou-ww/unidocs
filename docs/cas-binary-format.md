# UniDocs CAS Binary Format

Status: version 1 design specification  
Date: 2026-08-19  
Magic: `CAS\x02`

This specification defines the canonical byte representation used to identify UniDocs CAS nodes. It is derived from the design principles in [CASFA Binary Format v2.2](https://github.com/shazhou-ww/casfa/blob/main/docs/tech-details/cas-binary-format.md), with these intentional changes:

- full 256-bit SHA-256 digests instead of a truncated 128-bit digest;
- 32-byte child references;
- no digest-byte size flag;
- a generic Merkle DAG node core rather than mandatory d-node/f-node/s-node types;
- variable-length content type strings;
- physical separation of immutable metadata in D1 and content bytes in R2;
- canonical logical node bytes used as the SHA-256 preimage.

The lifecycle, lease, reference-count, and GC behavior is specified in [CAS Architecture](./cas-architecture.md).

## 1. Terminology

| Term | Meaning |
|---|---|
| Node | One immutable Merkle DAG node identified by SHA-256 |
| Hash | Full 32-byte SHA-256 digest of canonical logical node bytes |
| CAS key | 64 lowercase hexadecimal characters encoding the hash |
| Own content | Bytes stored directly for this node in R2 |
| Child ref | One ordered 32-byte hash embedded in immutable metadata |
| Logical node bytes | Canonical header + content type + child refs + own content |
| Ready node | A node with matching immutable D1 metadata and R2 own content |
| Node limit | Maximum canonical logical node size for a profile, default 1 MiB |
| Sequential file profile | An informative Merkle-tree layout whose preorder content concatenation reconstructs a file |
| Directory profile | A canonical named child list modeled after CASFA d-nodes |

## 2. Core identity

A node hash is:

```text
SHA256(header || contentTypeUtf8 || childHashes || ownContent)
```

Where:

- `header` is the 24-byte canonical header defined below;
- `contentTypeUtf8` is the exact validated UTF-8 byte sequence;
- `childHashes` is the ordered concatenation of 32-byte raw SHA-256 digests;
- `ownContent` is the exact R2 object body.

The lowercase hexadecimal representation is the external CAS key:

```text
hexLower(SHA256(canonicalNodeBytes))
```

No mutable state participates in identity. Specifically excluded:

- `leaseStartedAt`;
- `leaseExpiresAt`;
- `childRefCount`;
- `rootRefCount`;
- creation/access timestamps;
- user ID;
- R2 object metadata.

The same canonical node bytes in two user partitions have the same digest, but remain physically isolated and independently accounted.

## 3. Integer and string conventions

- All multi-byte integers are unsigned little-endian.
- `u16`, `u32`, and `u64` have their normal fixed widths.
- Services implemented in JavaScript reject sizes above `Number.MAX_SAFE_INTEGER`, even though the binary field is `u64`.
- Content type is UTF-8 without a byte-order mark.
- Content type must be valid UTF-8, contain no NUL, and use printable ASCII bytes `0x20` through `0x7e` in version 1.
- Content type length must be between 1 and 1024 bytes.
- Hash strings in JSON and URLs are exactly 64 lowercase hexadecimal characters.
- Raw hashes in the binary format are exactly 32 bytes.

Content type bytes are identity-sensitive. Version 1 performs no case folding or MIME parameter reordering. Callers should use normalized lowercase media types when practical.

## 4. Canonical header

Every logical node starts with a 24-byte header.

```text
Offset  Size  Field               Type     Version 1 value
0       4     magic               bytes    43 41 53 02 ("CAS\x02")
4       4     flags               u32 LE   0
8       8     contentSize         u64 LE   own R2 content byte length
16      4     refCount            u32 LE   ordered child hash count
20      2     contentTypeLength   u16 LE   UTF-8 content type byte length
22      2     reserved            u16 LE   0
```

Version 1 requires `flags == 0` and `reserved == 0`. Decoders must reject unknown non-zero bits rather than silently ignoring them.

The canonical logical node length is:

```text
24
+ contentTypeLength
+ refCount * 32
+ contentSize
```

This value must not overflow the implementation's safe integer range.

## 5. Canonical layout

```text
+-------------------------------+
| Header (24 bytes)             |
+-------------------------------+
| Content-Type (variable UTF-8) |
+-------------------------------+
| Child hashes (count * 32)     |
+-------------------------------+
| Own content (contentSize)     |
+-------------------------------+
```

There is no padding between regions.

Child refs are ordered and duplicates are significant:

```text
[A, B] != [B, A]
[A]    != [A, A]
```

A D1 implementation must preserve this order, typically with an `ordinal` column.

## 6. Physical Cloudflare storage

The canonical layout is the digest preimage and portable interchange representation. The production Cloudflare adapter physically splits it.

### 6.1 R2

R2 stores only `ownContent`:

```text
users/{userId}/nodes/{hash}
```

The R2 object length must equal `contentSize`.

Only validated content is published at the canonical key. The adapter must verify length and the complete logical-node SHA-256 digest before writing that key. For bounded nodes it may buffer and validate before `put`; a streaming implementation uses a temporary key and promotes only validated content. Unverified or partially uploaded bytes must never make canonical-key presence appear ready.

### 6.2 D1 nodes

D1 stores canonical immutable metadata plus mutable lifecycle state:

```sql
CREATE TABLE cas_nodes (
  user_id TEXT NOT NULL,
  hash TEXT NOT NULL,

  content_size INTEGER NOT NULL,
  content_type TEXT NOT NULL,

  lease_started_at INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  child_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (child_ref_count >= 0),
  root_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (root_ref_count >= 0),

  PRIMARY KEY (user_id, hash)
);
```

The fixed version-1 header fields `magic`, `flags`, and `reserved` need not be stored because they are implied by the schema/version. If future versions allow non-zero immutable flags, they must be stored explicitly.

### 6.3 D1 ordered edges

```sql
CREATE TABLE cas_edges (
  user_id TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  child_hash TEXT NOT NULL,

  PRIMARY KEY (user_id, parent_hash, ordinal),
  FOREIGN KEY (user_id, parent_hash)
    REFERENCES cas_nodes(user_id, hash),
  FOREIGN KEY (user_id, child_hash)
    REFERENCES cas_nodes(user_id, hash)
);

CREATE INDEX cas_edges_by_child
  ON cas_edges(user_id, child_hash);
```

Duplicate child hashes use different ordinals. Their contribution to `childRefCount` is the number of occurrences.

`refs` is reconstructed by selecting all edge rows for `(user_id, parent_hash)` ordered by `ordinal ASC`. Ordinals must be exactly the contiguous range `0..refCount-1`, where `refCount` is the number encoded in the canonical header and derived from the immutable edge set. Missing, duplicate, negative, or non-contiguous ordinals make metadata invalid; reads fail rather than returning a partial reference list.

For a newly inserted node, the initial lease values and all ordered edge rows are committed in the same D1 transaction as the node row. This prevents a crash from exposing an immediately GC-eligible parent while its child counts have already been incremented.

### 6.4 Idempotent root-reference requests

```sql
CREATE TABLE cas_root_ref_requests (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  applied_at INTEGER NOT NULL,

  PRIMARY KEY (user_id, request_id)
);
```

`payload_hash` is SHA-256 over the canonical sorted root-reference change map. Reusing a request ID with different changes is an error.

## 7. Streaming hash computation

The server need not concatenate an entire node in memory. It computes SHA-256 incrementally:

```text
hasher.update(encodeHeader(metadata))
hasher.update(utf8(metadata.contentType))
for ref in metadata.refs:
  hasher.update(decodeHex32(ref))
stream R2/request content chunks into hasher
assert digest == expected hash
```

Content length is counted while streaming and must exactly equal `contentSize`.

A metadata-only read cannot prove full node integrity because R2 content is required for the final digest. It can still validate header fields, content type, ref syntax, and edge ordering.

## 8. Validation rules

### 8.1 Hash and URL

- exactly 64 characters;
- lowercase `0-9a-f` only;
- decodes to exactly 32 bytes.

### 8.2 Header

- magic equals `CAS\x02`;
- flags equal zero;
- reserved equals zero;
- content type length is within version-1 limits;
- ref count is within configured limits;
- computed total length does not overflow;
- content size is a safe non-negative integer in TypeScript implementations.

### 8.3 Content type

- exact byte count matches `contentTypeLength`;
- valid UTF-8;
- version 1 allows printable ASCII only;
- no NUL;
- non-empty.

### 8.4 Child refs

- exactly `refCount` hashes;
- each hash is 32 bytes;
- every child belongs to the same user partition;
- every child must be ready before inserting the parent metadata row;
- duplicate refs are permitted and counted separately;
- cycles are cryptographically impractical to construct when a parent digest includes child digests, but implementations may still enforce traversal depth and visited-node limits for hostile or corrupt stores.

### 8.5 Content

- R2/request body length equals `contentSize`;
- reconstructed canonical digest equals the node key;
- content-specific validation is outside the generic CAS core.

## 9. Generic node TypeScript representation

```ts
export type CasHash = string;

export interface CasNodeMetadata {
  readonly hash: CasHash;
  readonly size: number;
  readonly contentType: string;
  readonly refs: readonly CasHash[];
}

export interface CasNode {
  readonly metadata: CasNodeMetadata;
  readonly content: Uint8Array;
}
```

`size` is the own content size, not recursive DAG size.

Consumers that need recursive logical size must encode or derive it in an application-specific root format. The generic CAS does not traverse the graph to validate a claimed total size.

## 10. Portable full-node encoding

Although Cloudflare storage is split, tooling may exchange a full node using the canonical layout directly.

Suggested media type:

```text
application/vnd.unidocs.cas-node.v1
```

A full-node decoder:

1. reads the 24-byte header;
2. validates fixed fields;
3. slices `contentTypeLength` bytes;
4. slices `refCount * 32` bytes;
5. treats the remaining `contentSize` bytes as own content;
6. rejects trailing or missing bytes;
7. hashes the entire input and compares it to the expected key.

This representation is useful for:

- export/import tooling;
- offline integrity verification;
- migration between storage providers;
- deterministic test fixtures.

It is not required as the public upload wire format; the HTTP API may send metadata as JSON and content as a separate binary request.

## 11. Sequential file profile (informative)

The core node format is a generic ordered DAG. This section sketches an optional large-file profile derived from CASFA's f-node/s-node B-tree. It is informative, not canonical, until the exact topology algorithm and locked test vectors are specified.

### 11.1 Media types

Root node:

```text
<actual file content type>
```

Successor/chunk node:

```text
application/vnd.unidocs.cas-chunk.v1
```

### 11.2 Reconstruction

A file is reconstructed using depth-first preorder:

```text
read node own content
for child in node.refs order:
  recursively read child
concatenate all byte sequences
```

Only chunk-profile children are valid below the root.

### 11.3 Canonical node limit

Default canonical logical node limit:

```text
1,048,576 bytes (1 MiB)
```

For a node with content-type length `T` and `N` children, own-content capacity is:

```text
capacity = nodeLimit - 24 - T - 32 * N
```

Capacity must be non-negative.

### 11.4 Greedy layout sketch

The intended profile fills each node's own content before assigning bytes to children.

A node may have children only when its own content region is filled to the capacity implied by its final child count. Child subtrees are filled left-to-right.

At depth 1:

```text
maxContent = nodeLimit - 24 - contentTypeLength
```

At greater depth, each child consumes 32 bytes in its parent and contributes the capacity of a subtree one level shallower. Implementations choose the minimum depth that can hold the file and the minimum child count needed at each node.

The root uses the actual file content type length; all descendants use the fixed chunk media type length.

This sketch does not yet normatively define the exact depth-selection formula, child-count bounds, byte partition, zero-length subtree rule, or tie breaking. Implementations must not claim interoperable root hashes from this profile until those rules and required test vectors are fixed in a future revision.

### 11.5 Bottom-up creation

Creation is bottom-up:

1. compute deterministic layout;
2. create and upload leaf chunks;
3. create parents containing ordered child hashes;
4. create the root last;
5. return the root hash.

The root's CAS lease protects the root. Child nodes are protected by `childRefCount` once parent metadata is inserted. Intermediate unready parents retain child refs until they are completed or collected.

### 11.6 Scope

The sequential file profile is deferred from the first implementation. A client may store a file as one node when it is below service size limits. The generic CAS API must not assume every node follows this profile.

## 12. Directory profile

This optional profile models a named ordered directory, derived from CASFA d-nodes.

Media type:

```text
application/vnd.unidocs.cas-directory.v1
```

Own content contains exactly one name per child ref:

```text
repeated refCount times:
  nameLength  u16 LE
  nameBytes   UTF-8
```

Rules:

- names and refs correspond by ordinal;
- names are valid UTF-8;
- names are non-empty;
- names must not contain `/`, `\`, NUL, `.` or `..` path segments;
- names are strictly increasing by unsigned UTF-8 byte lexicographic order;
- duplicate names are forbidden;
- content contains exactly `refCount` complete strings and no trailing bytes.

The generic CAS does not interpret directory content unless the media type matches this profile.

## 13. Empty nodes and well-known values

An empty generic node is valid when:

```text
contentSize = 0
refCount = 0
contentType = a non-empty valid media type
```

Different content types produce different hashes, so there is no single universal empty-node key.

Implementations may publish well-known keys for specific empty profiles, such as an empty directory, after the version-1 encoder is finalized. Such keys must be generated from the canonical format and locked by test vectors.

## 14. Security and resource limits

The service must enforce configurable limits before allocation or traversal:

- maximum own content size;
- maximum canonical node size;
- maximum child count;
- maximum content type length;
- maximum upload duration;
- maximum DAG traversal depth;
- maximum nodes visited per read;
- maximum reconstructed response size;
- per-user storage quota;
- per-user concurrent upload limit.

A valid hash does not authorize access. Every operation is authenticated and scoped to one user partition.

Content type is descriptive metadata and must not be trusted for content sniffing, browser execution policy, or DOCX image validation. Consumers validate actual bytes for their domain.

## 15. Versioning

The fourth magic byte is the binary-format version:

```text
CAS\x02 = UniDocs CAS node format version 1
```

`CAS\x01` remains associated with the earlier CASFA format and must not be interpreted as this format.

Future incompatible layouts use a new magic version. Future compatible immutable features may use currently reserved header flags only after specifying:

- their canonical encoding;
- whether old readers reject or can safely ignore them;
- D1 persistence requirements;
- digest test vectors.

Version 1 readers reject all non-zero flags and reserved values.

## 16. Required test vectors

Before implementation is considered stable, fixtures must pin at least:

1. empty `application/octet-stream` node;
2. small text node with no refs;
3. node with one child;
4. node with duplicate ordered child refs;
5. same content with different content types producing different hashes;
6. same content/metadata with reversed refs producing different hashes;
7. zero-byte R2 content;
8. maximum content type length;
9. malformed magic/flags/reserved values;
10. content length mismatch;
11. digest mismatch;
12. directory names in canonical UTF-8 byte order;
13. a multi-level sequential file profile tree;
14. D1 metadata + R2 content reconstructing exactly the portable full-node digest.

Test vectors should include canonical bytes, raw SHA-256 bytes, lowercase hexadecimal keys, parsed metadata, and own content.
