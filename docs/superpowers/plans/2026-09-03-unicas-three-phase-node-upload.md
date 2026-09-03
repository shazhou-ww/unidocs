# UniCAS Three-Phase Node Upload Plan

> **Status:** PLANNED
>
> Implement one phase at a time. Do not remove the current streaming lease
> upload until every first-party caller has migrated and production rollback
> has been exercised.

**Goal:** Keep canonical-node upload bodies out of the UniCAS Worker and its
service-binding request path by changing node creation from one proxied
request into a bodyless lease admission, a direct caller-to-R2 PUT, and a
bodyless lease finalization.

**Architecture:** The public tenant API continues to expose the canonical
node lease resource. A stack-authorized caller first asks UniCAS to lease a
hash and declares the canonical byte length. UniCAS either renews an existing
ready node or creates a short-lived upload reservation and returns a PUT-only
R2 presigned URL for a random temporary object. After the direct upload, the
caller finalizes the same lease with the reservation ID. The tenant Durable
Object verifies the immutable temporary object, streams it into the final
hash-addressed R2 key with R2 SHA-256 enforcement, parses canonical metadata,
and atomically publishes the node row, edges, and lease. Failed or expired
uploads never become ready.

**Primary packages:** `@unicas/tenant-protocol`, `@unicas/tenant-client`,
`@unicas/tenant-blob-client`, `@unicas/service`, and
`@unicas/service-cloudflare`.

## Fixed Decisions

1. Keep `POST /stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/lease` as
   the only public node-write route. Request headers distinguish renew,
   prepare, finalize, and legacy streaming upload.
2. The prepare and finalize requests have no body. The R2 upload body never
   traverses a UniCAS Worker or service binding.
3. Upload to a random temporary R2 key, never directly to the final hash key.
   A failed validation therefore cannot poison a valid CAS address.
4. Make the temporary key write-once with a signed `If-None-Match: *` header.
   R2 presigned URLs are reusable until expiry, so an unsigned conditional
   would permit replacement during finalization.
5. Keep the durable state machine minimal: `absent -> uploading -> ready`.
   Verification is an idempotent operation over `uploading`, not a durable
   state. In-process duplicate finalizers join one promise; a DO reset allows
   the next finalizer to repeat verification safely.
6. `uploadId` is an opaque fencing identifier, not a substitute for tenant
   capability authorization. Every prepare and finalize call still requires
   `cas:write` for the same stack and tenant.
7. Finalization remains synchronous. A successful response means the R2
   object, node metadata, edges, and lease are all ready.
8. Preserve the current body-carrying lease as a compatibility path during
   rollout. New clients prefer direct upload only when the server returns an
   `upload_required` result.
9. Do not expose R2 API credentials. Only the short-lived, one-key, PUT-only
   URL leaves UniCAS. Credentials remain Cloudflare Worker secrets.
10. Do not assume direct R2 upload removes caller-isolate buffering. A Doc
  Durable Object still originates the R2 `fetch` body; keep its upload
  concurrency bounded until production measurements establish safe limits.

## HTTP Contract

### Renew or discover

```http
POST /stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/lease
Authorization: Bearer <tenant capability>
X-CAS-Lease-Duration: <milliseconds>  # optional
```

If the node is ready, return `200`:

```json
{
  "hash": "<sha256>",
  "ready": true,
  "leaseStartedAt": 0,
  "leaseExpiresAt": 0
}
```

If the node is absent and no upload length was supplied, preserve the current
not-ready/not-found behavior. Discovery must not reserve quota accidentally.

### Prepare direct upload

```http
POST /stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/lease
Authorization: Bearer <tenant capability>
X-CAS-Lease-Duration: <milliseconds>  # optional
X-CAS-Upload-Length: <canonical bytes>
```

If the node is absent, reserve quota and return `200`:

```json
{
  "status": "upload_required",
  "ready": false,
  "hash": "<sha256>",
  "uploadId": "<opaque id>",
  "expiresAt": 0,
  "upload": {
    "method": "PUT",
    "url": "https://<account>.r2.cloudflarestorage.com/<bucket>/<temporary-key>?...",
    "headers": {
      "Content-Type": "application/vnd.unidocs.cas-node.v1",
      "If-None-Match": "*"
    }
  }
}
```

The response supplies the exact headers covered by the signature. Clients
must not add an `Authorization` header to the R2 PUT. The implementation spike
below decides whether `Content-Length` can also be signed for all supported
callers; if it can, include it in `upload.headers`.

An unexpired reservation for the same `(stackId, tenantId, hash, length)` may
return the same `uploadId` and a freshly signed URL for its temporary key.
Conflicting length returns `409 CAS_UPLOAD_CONFLICT`. An expired reservation
is replaced with a new ID and key after scheduling cleanup of the old key.

### Finalize lease

```http
POST /stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/lease
Authorization: Bearer <tenant capability>
X-CAS-Upload-Id: <opaque id>
X-CAS-Lease-Duration: <milliseconds>  # optional; must match reservation policy
```

Return the same `ready` response as renewal. Repeating finalize after a
successful commit is idempotent: if the hash is ready, renew and return it.
An upload ID for another hash, tenant, stack, or expired reservation is never
accepted.

### Legacy streaming upload

During migration, retain the current request:

```http
POST /stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/lease
Content-Type: application/vnd.unidocs.cas-node.v1
Content-Length: <canonical bytes>

<canonical body>
```

Reject ambiguous requests that combine a body or canonical `Content-Type`
with `X-CAS-Upload-Length` or `X-CAS-Upload-Id`.

## Stable Error Semantics

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `CAS_UPLOAD_INVALID` | Invalid headers, upload ID, or canonical envelope |
| `404` | existing not-ready code | Bodyless renew/discover found no ready node |
| `409` | `CAS_UPLOAD_CONFLICT` | Active reservation has incompatible parameters |
| `409` | `CAS_CHILD_NOT_READY` | Canonical child reference is not ready |
| `410` | `CAS_UPLOAD_EXPIRED` | Reservation expired; caller must prepare again |
| `412` | `CAS_UPLOAD_INCOMPLETE` | Temporary object is absent or has the wrong size |
| `422` | `CAS_DIGEST_MISMATCH` | R2 rejected the object against the requested hash |
| `429` | existing quota code | Reservation would exceed tenant quota |

Do not return R2 keys, signatures, provider error bodies, or credential
details in errors or logs. The presigned URL appears only in the successful
prepare response and must be treated as a bearer credential.

## Persistence Model

Evolve `cas_upload_reservations` from a quota-only fence into the authoritative
upload session table:

```text
(stack_id, tenant_id, hash) primary key
upload_id                         opaque random identifier
temporary_object_key              random _uploads/ key
stored_bytes                      declared canonical length
lease_duration_ms                 clamped lease requested at prepare
created_at
expires_at
```

Keep `cas_nodes` as the sole `ready` marker. Do not add partially populated
rows to `cas_nodes`. Existing usage accounting continues to derive
`reservedBytes` and `notReadyNodeCount` from active reservations.

Temporary object keys use an opaque random namespace such as
`_uploads/v1/{random}`. Do not embed stack IDs, tenant IDs, hashes, subjects,
or upload IDs in the externally visible key.

## Finalization Algorithm

Inside the tenant Durable Object:

1. Enter the mutation gate and read the ready row and reservation.
2. If ready, renew idempotently and return. Otherwise verify upload ID, hash,
   declared length, and expiry.
3. Join an in-memory active finalization for the hash when one exists.
4. Outside the mutation gate, `HEAD` the temporary object and require the
   exact declared byte count.
5. `GET` the temporary object once and tee its bounded stream:
   - parse canonical metadata and refs using the existing codec limits;
   - conditionally stream to an absent final hash key through the R2 binding
     with `If-None-Match: *` and `{ sha256: requestedHash }` so R2 enforces
     the full canonical digest without overwriting a competing valid object.
6. Re-enter the mutation gate, re-read ready state and reservation, validate
   child readiness, and atomically commit node metadata, edges, counters,
   lease, and reservation deletion.
7. Delete the temporary object after a successful commit. Await deletion on
   the normal path; also retain lifecycle cleanup as defense in depth.
8. On size, parse, child, or digest failure, delete the temporary object and
   reservation so a subsequent prepare receives a fresh session. Preserve a
   ready node if another finalizer won the race.

The conditional final R2 PUT may lose to another attempt. On precondition
failure, inspect the existing object and treat matching SHA-256 and length as
idempotent; never overwrite or adopt mismatching bytes.

## Platform Security Gate

Complete this spike before freezing the protocol types:

1. Generate a presigned R2 PUT in a Worker with `aws4fetch` and credentials
   scoped to only the CAS bucket.
2. Confirm `If-None-Match: *` is included in `X-Amz-SignedHeaders`; the first
   PUT succeeds and every replay returns `412` without replacing the object.
3. Test signing `Content-Length` from a Worker caller and a browser `fetch`.
   If both work, require it. If browsers cannot satisfy the signed header,
   server-side callers may use the stricter profile while browser support
   remains disabled until an equivalent upload-size control exists.
4. Confirm expired URLs and modified content type/conditional headers fail.
5. Confirm R2 binding `HEAD` reports exact size and final binding `put` with
   `sha256` rejects a mismatching canonical stream.

Do not enable direct uploads in production unless write-once behavior is
proven. Do not grant an unconstrained presigned PUT to browser callers without
an accepted storage-abuse policy: finalization can delete an oversized object,
but it cannot prevent the temporary storage and bandwidth charge.

Browser support additionally requires an exact-origin R2 CORS policy allowing
`PUT` and the signed request headers. Wildcard production origins are out of
scope. Server-side Doc Durable Objects do not require CORS.

## Package Work

### Phase 1: Protocol

- Keep the existing `CasLeaseResult` ready shape and add
  `CasUploadRequiredResult` so `ready: true | false` discriminates the
  expanded response union without breaking existing ready consumers.
- Add `X-CAS-Upload-Length` and `X-CAS-Upload-Id` constants and update the
  lease request contract in `tenant-protocol/src/http.ts`.
- Keep the route unchanged; add route and contract tests for all four request
  modes and ambiguous-header rejection.
- Update `docs/cas-architecture.md`, `docs/cas-binary-format.md`, and
  `docs/cas-operations.md` once the platform spike fixes the exact headers.

### Phase 2: Cloud-Neutral State Machine

- Replace the current minimal reservation type in
  `unicas-packages/service/src/node-lease.ts` with explicit prepare and
  finalize plans.
- Add repository operations to read, create/replace, and delete upload
  sessions without exposing provider URLs to `@unicas/service`.
- Preserve `nextNodeLease`, canonical parsing, child-readiness checks, and
  atomic metadata publication.
- Add memory-repository tests for prepare reuse, conflicting lengths, expiry,
  finalize idempotency, reset/retry, digest failure, and competing callers.

### Phase 3: Cloudflare Adapter

- Migrate `cas_upload_reservations` additively in
  `unicas-packages/service-cloudflare/src/schema.ts`.
- Add opaque temporary-key construction and session persistence to
  `service-cloudflare/src/node-lease.ts`.
- Add an R2 presigner adapter in `@unicas/service-cloudflare`; keep account ID,
  bucket name, and expiry as non-secret config and access key ID/secret as
  Worker secrets.
- Update `tenant-do.ts` to dispatch renew, prepare, finalize, and legacy upload
  without forwarding a body for the new modes.
- Generate binding types after configuration changes and avoid hand-maintained
  secret-bearing environment declarations.
- Add a lifecycle rule for `_uploads/v1/` and explicit expired-reservation
  cleanup in tenant GC. Lifecycle cleanup is a fallback, not correctness.

### Phase 4: Tenant Client

- Keep the public `leaseNode(hash, source?, options?)` abstraction.
- For a source, call prepare, PUT `source.body` directly to the returned URL
  with exactly the returned headers, consume the R2 response body, then call
  finalize with a newly acquired tenant capability.
- Use the configured `CasHttpFetcher` for absolute upload URLs without adding
  UniCAS authorization. This keeps Miniflare and tests injectable.
- Do not automatically retry a consumed one-shot body. A future replayable
  source factory may opt into prepare/upload retries.
- Keep a compatibility fallback to the legacy body request behind an explicit
  client option while production rolls forward.
- Verify `tenant-blob-client` needs no API change beyond inheriting the new
  transport behavior.

### Phase 5: Caller Rollout

- Deploy UniCAS with protocol support disabled by default, then enable prepare
  for a dedicated canary stack/tenant.
- Run direct tenant-client smoke tests for absent, existing, invalid hash,
  wrong length, expired session, URL replay, and capability expiry between
  prepare and finalize.
- Migrate Cloudflare DOCX first and compare create latency, CAS request count,
  caller DO memory failures, reservation count, and temporary-object cleanup.
- Migrate Markdown and other Cloudflare doc types after DOCX is stable.
- Keep `DOC_CAS_CONCURRENCY=2` until direct-upload production evidence shows
  the old service-binding upload bodies are gone. Direct R2 PUT concurrency
  needs its own measured limit.
- Remove legacy streaming upload only in a later breaking release after all
  callers and rollback revisions no longer depend on it.

## Validation Matrix

### Contract and unit tests

- Tagged response decoding and old ready-response compatibility.
- Prepare requires a valid hash and bounded positive canonical length.
- Same reservation is reusable; conflicting reservation is rejected.
- Finalize cannot cross stack, tenant, hash, or upload ID boundaries.
- Expired sessions return `410` and become reclaimable.
- Missing, oversized, malformed, wrong-hash, and missing-child objects never
  create `cas_nodes` rows or edges.
- Successful and repeated finalize produce one node and monotonic lease.
- DO reset between final R2 write and D1 commit recovers idempotently.
- Usage and GC account for active and expired reservations correctly.

### Cloudflare integration tests

- Presigned URL permits only PUT to one temporary key until expiry.
- Signed content type and `If-None-Match` are mandatory.
- Replay cannot overwrite the temporary object.
- Finalization streams bounded data and R2 rejects SHA-256 mismatch.
- Temporary objects are deleted on success and validation failure.
- Concurrent prepare/finalize calls converge on one ready node.

### Production acceptance

- Empty DOCX creation succeeds with the seven part uploads directed to R2 and
  no canonical body crossing the DOCX-to-UniCAS service binding.
- DOCX create/apply/query/export remains correct.
- No increase in invalid reservations, leaked temporary objects, or R2 errors.
- A controlled concurrency comparison no longer reproduces the caller DO
  memory reset seen with legacy streaming uploads.
- Rollback to the legacy client remains functional while the compatibility
  endpoint is present.

## Observability

Emit structured, secret-free events for:

```text
cas_upload_prepared
cas_upload_reused
cas_upload_finalize_started
cas_upload_ready
cas_upload_validation_failed
cas_upload_expired
cas_upload_temp_deleted
```

Include stack ID, tenant ID, hash, declared bytes, elapsed time, result code,
and a non-secret correlation ID. Never log presigned URLs, query strings, R2
credentials, tenant capabilities, or raw upload IDs.

Track gauges/counters for active reservations, reserved bytes, expired
reservations, temporary cleanup failures, finalize latency, digest mismatch,
and prepare-to-finalize conversion. Alert on sustained reservation growth or
cleanup failure before broad caller rollout.

## Exit Criteria

- The three-phase API is documented and covered by protocol, kernel, adapter,
  client, and production smoke tests.
- A canonical upload body does not pass through UniCAS for migrated callers.
- Invalid and interrupted uploads cannot create ready nodes or permanently
  occupy a hash.
- Presigned URL replay cannot replace an uploaded temporary object.
- Quota and GC remain correct across crashes and expired sessions.
- Production measurements establish and document a safe direct-R2 upload
  concurrency for Doc Durable Objects, while the legacy path remains
  available for rollback.