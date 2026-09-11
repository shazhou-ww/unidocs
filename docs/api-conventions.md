# UniDocs API conventions

This document defines repository-wide HTTP API design rules. Service-specific contracts may add stricter requirements but should not silently contradict these conventions.

## Read and mutation responses

Read operations return the complete representation needed for their documented view. Mutation operations return the smallest result needed to continue safely; they do not echo the complete mutated resource by default.

A mutation result may contain only:

- a server-assigned resource identity or revision;
- the new ETag or another concurrency token;
- a content hash needed to identify an immutable result;
- a durable receipt identity or state needed to resolve an unknown outcome.

Request fields, manifests, schemas, descriptors, and unchanged nested resources are not echoed. A caller that needs the complete current representation follows the mutation with its canonical GET operation.

One shape is exempt. An operation whose whole effect is to append a new immutable record that the server numbers and timestamps may return that record in full. Such a record is the operation's product rather than an echo of the request, so it cannot drift from its canonical GET, and the server-assigned fields are the reason the caller made the request at all. The exemption is narrow: it does not extend to a resource carrying an ETag, where a compact identity plus the new token is exactly what the caller needs next, nor to an operation that also mutates surrounding state. `@unidocs/protocol-tenant-portal` relies on it for document, thread, and ping creation, where the resources have no ETag and a thin result would force a second round trip for data the server just assigned.

Use these status and response shapes consistently:

- `201 Created`: return a compact identity result and an ETag when the resource has mutable metadata, or the complete record under the immutable-record exemption above.
- `200 OK` for updates: return the resource identity and new ETag, not the full representation.
- `204 No Content`: use when a successful operation has no continuation value, such as deletion.
- Synchronous validation or execution operations may return their complete result when that result is the operation's primary product rather than a stored resource representation.

Do not move required continuation data exclusively into response headers when doing so would make typed clients or idempotent recovery less reliable. A compact JSON result is preferred for these values.

Platform-managed mutable resources use a strong content-derived ETag formatted as `"sha256-<digest>"`, where `<digest>` is the 43-character unpadded base64url SHA-256 digest of the canonical resource representation. For example: `"sha256-qpj883GyEC_ISq5zghYn7x9MAjOW27ImPGJamTCcRkA"`.

The digest input is the resource's canonical GET response projected without its `etag` field, then serialized with the JSON Canonicalization Scheme (RFC 8785) and encoded as UTF-8. It includes all immutable and mutable representation fields, including normalized URL/date strings and `updatedAt` when present; transport headers and request-only metadata are excluded. The service actor computes this value once, so Node.js and Cloudflare adapters cannot choose different canonicalization. For bundle candidate records this hashes the complete Admin representation, not only the immutable bundle bytes, so changing `name` or `description` changes the ETag.

The surrounding double quotes are part of the HTTP entity-tag and must be preserved in JSON fields and `If-Match`. Clients compare and return ETags verbatim; they must not parse or recompute the digest. ETags owned by external services need only be valid strong HTTP entity-tags and do not use the Platform format.

## Integer indexes

All wire fields named `*Idx` are zero-based, monotonically increasing safe integers within their documented scope. The first record receives index 0, and subsequent records receive the current maximum plus 1. Use `null`, not 0, to represent an absent record or watermark.

## Format versions and schema revisions

A format version identifies a wire encoding. A contract index identifies a schema revision. Do not derive one from the other or increment the format version for ordinary schema evolution.

Document snapshot and location media types also encode the MIME-safe document type: `application/vnd.unidocs.<documentType>.snapshot+cbor;version=<formatVersion>` and `application/vnd.unidocs.<documentType>.location+json;version=<formatVersion>`. Document types therefore match `[a-z][a-z0-9-]{0,63}`. The server derives both media types from the URL/document record and format version; clients do not submit free-form values.
