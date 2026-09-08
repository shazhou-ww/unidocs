# @unidocs/doctype-markdown

Cloud-neutral Markdown engine and the in-process P-MVP-01 editor compute core.
The existing `createMarkdownDocumentType` and legacy agent APIs remain available.

## New Compute Core

`MarkdownEditorService` reuses the Markdown engine without session persistence,
history, version allocation, CAS writes or reference retention. It is not an HTTP
service and must not be exposed directly to untrusted callers. Invocation identities
are platform assertions, not credentials. The HTTP adapter below authenticates
them and enforces request/body limits; deployments must supply authorized snapshot access.

`markdown/1` has one state shape and one operation shape:

```ts
type State = { content: string };
type Operation = { kind: "setContent"; payload: { content: string } };
```

The source uses the shared `StateSource<MarkdownV1Operation>` contract. A null base
means an empty document. A non-null base is an internal snapshot SBlob, never an
import file, JSON hash object or inline state. Changesets and their operations run
in order. The new schema does not accept legacy section operations or extra fields.

All three methods return promises of `ServiceResult`:

| Method | Input | Success |
| --- | --- | --- |
| init | Invocation, StateSource | Fresh contextId, sequence 0 |
| apply | Invocation, expected context, changeset | Same contextId, sequence + 1 |
| snapshot | Invocation, expected context | Complete copied `{ content }` state |

Each context serializes apply and snapshot, including the sequence check and state
publication. Two concurrent applies at the same sequence cannot both succeed.
Requests capture identity, context and operation inputs before asynchronous work;
caller mutation cannot change queued operations. Failed requests leave the state
and sequence intact and do not block subsequent work.

Contexts bind actorId, tenantId, docId and docType. requestId may change per request;
it does not implement business idempotency. Missing, expired or mismatched contexts
return `context_lost`. The platform must rebuild from fixed persistent state; it
must not blindly repeat an uncertain apply.

## Lifecycle And Snapshot Port

Constructor options:

- `loadSnapshot(blob)`: authorized read-only port returning a decoded internal
  snapshot. This is not a CAS adapter; access checks, content integrity and canonical
  SValue decoding belong in the adapter. Exceptions return `resource_unavailable`
  without exposing the underlying exception text or credentials.
- `createContextId`: defaults to `crypto.randomUUID`. It must produce globally
  fresh IDs, including across restarts. A collision with a live context fails
  instead of replacing it.
- `contextTtlMs`: defaults to 300000 milliseconds, measured from successful init.
  Reads and writes do not extend it. Expired entries are reclaimed on access or init.
- `maxContexts`: defaults to 128 per instance, including in-flight init reservations.
  Exhaustion returns `limit_exceeded`; existing live contexts are not evicted.
- `now`: injectable millisecond clock, defaulting to `Date.now`.

Temporary contexts are instance-local. Routing to another instance or restarting
loses them, not platform documents. Context limits do not replace transport byte
limits or deployment concurrency controls. Malformed input returns `invalid_request`
or `operation_rejected`; unsupported schemas return `unsupported_schema` before
loading snapshots. None of these results is a platform commit receipt.

## Authenticated HTTP Draft

`createMarkdownEditorHandler` adapts Fetch Request/Response using only canonical
SValue and [platform HMAC](../service-auth/README.md). It does not alter legacy URLs.

| POST path | Body | Required CAS mode |
| --- | --- | --- |
| /v1/editor/probe | Empty object | No credential accepted |
| /v1/editor/init | `{ invocation, source }` | RO |
| /v1/editor/apply | `{ invocation, context, changeSet }` | RW |
| /v1/editor/snapshot | `{ invocation, context }` | RO |

Init is RO for this Markdown schema: rebuilding text never generates resources.
Apply retains the compute-RW contract even though this text-only implementation
does not write blobs. Query/import/export/summary and Operator routes are not exposed.
Probe returns protocol, serviceId, role, docType, schemaVersion and implemented
operations without user data. A probe success is not a CAS-readiness check.

Invocation has exactly requestId, actorId, tenantId, docId and docType, all nonempty
strings; docType must be `markdown`. Example decoded init body (wire is SValue):

```ts
({
  invocation: { requestId: "request-1", actorId: "actor-1", tenantId: "tenant-1", docId: "doc-1", docType: "markdown" },
  source: { schemaVersion: "markdown/1", base: null, changes: [] },
})
```

Successful init returns `{ success: true, data: { contextId, sequence: 0 } }`;
snapshot returns `{ success: true, data: { content } }`. Failure example:
`{ success: false, error: { code: "sequence_conflict", message: "Editor context sequence does not match" } }`.
Responses use SValue Content-Type and `Cache-Control: no-store`. HTTP status mapping:
malformed input 400, authentication 401, CAS denial 403, replay/sequence conflict 409,
context lost 410, limit exceeded 413, unsupported schema/operation rejection 422,
resource or authorization/nonce store unavailable 503, unexpected failure 500.
Unknown paths, wrong method and unsupported content type are rejected by the
authentication boundary as 401, without redirecting or attempting compatibility.

The deployment must provide a fixed origin/platform/environment/service identity,
dynamic scoped key records, persistent atomic `nonces`, `authorizeCas(access)` and
`loadSnapshot(blob, access)`. HTTP option `now` uses Unix seconds (unlike the core's
millisecond clock). The handler owns instance-local contexts; routing must preserve
an instance or the platform must rebuild on context_lost.

`authorizeCas` must verify credential signature, issuer/audience, tenant, expiry and
the exact required mode before any computation. Reject excess RW on RO requests;
do not silently downgrade it. Returning true is an explicit trusted adapter assertion,
not enforcement supplied by this package. Snapshot loading receives only the signed
request's credential and invocation. No credential is stored in context; concurrent
init calls do not share a mutable global token. Adapter exceptions never echo secrets.
The adapter must recheck authorization when using CAS, bound snapshot reads, decode
canonical SValue, and verify hash integrity. It must not expose refs updates.

## Validation

```sh
pnpm --filter @unidocs/doctype-markdown test
pnpm --filter @unidocs/doctype-markdown typecheck
```

Typecheck covers the source and compute/HTTP tests. Tests use real HMAC, Fetch
Request/Response and SValue codecs with injected snapshot and nonce ports, not
a deployed network service or real CAS. Persistent nonce storage, CAS adaptation,
platform commit/receipt storage, hosted frontend and online deployment remain pending.
