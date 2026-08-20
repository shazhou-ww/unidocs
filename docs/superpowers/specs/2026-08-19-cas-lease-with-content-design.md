# CAS lease-with-content HTTP API

Status: accepted design (2026-08-19)

Replaces the two-phase HTTP protocol (`POST .../lease` JSON + `PUT .../content` + `uploadToken`) with two distinct lease paths. Updates [CAS Architecture](../../cas-architecture.md) sections 6, 7, 10, and 11.

## Decision

Clients must not write CAS bytes through a standalone PUT. Uploading a new file is a lease that carries content. Extending a ready node is a separate lease with no body. Public identity remains the path `userId`.

## Public routes

Unchanged:

```
GET  /users/{userId}/cas/nodes/{hash}/content
GET  /users/{userId}/cas/nodes/{hash}/metadata
GET  /users/{userId}/cas/usage
POST /users/{userId}/cas/gc
```

New / replacement:

```
POST /users/{userId}/cas/nodes/{hash}         lease with content
POST /users/{userId}/cas/nodes/{hash}/lease   extend ready node only
```

Removed from the public surface:

```
PUT  /users/{userId}/cas/nodes/{hash}/content
POST JSON-only lease that inserts a not-ready D1 row
X-CAS-Upload-Token
uploadRequired / uploadToken in responses
```

Internal Durable Object `leaseExisting` maps to `POST .../lease`. Internal `updateRootRefs` stays unpublished.

## Lease with content

```http
POST /users/{userId}/cas/nodes/{hash}
Content-Type: image/png
Content-Length: 12345
X-CAS-Refs: <hash>[,<hash>...]
X-CAS-Lease-Duration: 900000

<raw bytes>
```

| Field | Source | Default |
|-------|--------|---------|
| hash | URL | required, 64 lowercase hex |
| content | body | required unless the node is already ready |
| size | `Content-Length` | required; must match received byte length |
| contentType | `Content-Type` | required; participates in digest |
| refs | `X-CAS-Refs` | omitted or empty → `[]`; comma-separated ordered hashes |
| duration | `X-CAS-Lease-Duration` | omitted → 15 minutes; clamped to 1 minute … 24 hours |

`X-CAS-Refs` is sufficient for the expected small fan-out. A multipart encoding is deferred until a real DAG exceeds header size limits.

### Server flow (per-user Durable Object queue)

1. Validate hash, `Content-Type`, `Content-Length`, refs, and duration from URL and headers. Do not read the body yet.
2. Load the D1 row and `HEAD` the canonical R2 key.
3. **Ready hit:** immutable metadata (`size`, `contentType`, ordered `refs`) must match. On mismatch return `409` and cancel the body. On match, extend the lease, cancel the body (`request.body?.cancel()`), return `200` with the lease result. The client may still be sending; the server must not wait for it.
4. **Missing or not-ready:** every child hash must already be ready. Then read the body, require length = `Content-Length`, compute the canonical digest, require it to equal the URL hash.
5. `PUT` validated bytes to the canonical R2 key (idempotent).
6. In one D1 transaction: insert or confirm the node row, insert ordered edges, increment each child's `childRefCount`, persist `leaseStartedAt` / `leaseExpiresAt`.
7. Return `200` with `ready: true`.

R2 is published before the D1 row. A crash after R2 and before D1 leaves an orphan object; retry is idempotent and completes the row. A D1 row is never committed without canonical R2 content. This reverses architecture §7 (which inserted D1 first and allowed leased not-ready rows).

Concurrent identical uploads are serialized by the user Durable Object: the first writer completes R2+D1; the second takes the ready-hit path.

## Extend existing lease

```http
POST /users/{userId}/cas/nodes/{hash}/lease
X-CAS-Lease-Duration: 900000
```

No body. No refs. No content type.

- Missing node → `404`
- Node exists but R2 content is missing → `409` (caller must use lease-with-content)
- Ready → extend lease, `200`

Used by document apply (`leaseExisting`). Apply never uploads bytes.

## Lease result

```ts
export interface CasLeaseResult {
  readonly hash: CasHash;
  readonly ready: true;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
}
```

Both successful lease paths return `ready: true`. Not-ready public states are not part of the HTTP contract.

## Client (`CasClient`)

- `ensureNode` / upload: one `POST /nodes/{hash}` with headers and bytes.
- `leaseExisting`: `POST /nodes/{hash}/lease`.
- Remove `claimLease` + `uploadContent` two-phase helpers.

## Errors

| Status | When |
|--------|------|
| 400 | invalid hash, content type, refs, duration, or digest/length mismatch |
| 404 | extend-lease on unknown hash; GET on unknown/not-ready |
| 409 | immutable metadata mismatch; extend-lease on not-ready; child not ready |
| 405 | `PUT` (or any non-GET) on `/content`; the path remains GET-only |
| 404 | unknown path |

## Out of scope

- Bearer binding to path `userId`
- Multipart metadata for large ref lists
- Changing read, usage, GC, or `updateRootRefs`
- Explicit lease release
