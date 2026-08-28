# Doc Service HTTP Protocol

Status: current implementation reference, verified 2026-08-28.

This document describes the HTTP boundaries around a UniDocs Doc service. It
separates three APIs that use different identifiers and trust models:

```text
End-user client
  -> Gateway public document API       /tenants/{tenantId}/docs/{docType}/...
  -> Doc edge service API              /tenants/{tenantId}/sessions/{sessionId}/...
  -> adapter-internal session API      /_internal/...
```

The normative machine-readable contracts are `@unidocs/protocol-gateway` and
`@unidocs/protocol-doc`. The runtime behavior is owned by
`@unidocs/gateway-common`, `@unidocs/doctype-server-common`, and each cloud
adapter. When this document and those packages disagree, the packages are the
source of truth.

## Scope and identities

- `tenantId` is the authorization and CAS isolation boundary.
- `docType` is the deployment-time service routing key, such as `markdown`,
  `docx`, or `psd`.
- `docId` is the public document identifier owned by Gateway.
- `sessionId` is an opaque service identifier owned by Gateway and used by one
  Doc service. Clients do not choose or discover it.
- `stackId` identifies the native CAS stack. It is not part of a Doc route.
- A snapshot `hash` is a CAS root, not a public clone credential.

Gateway owns end-user authentication, tenant authorization, document listing,
the `docId -> sessionId` directory, and create state. A Doc service never
receives `userId`, never lists documents, and never reads Gateway's directory.

## Wire conventions

All path values are percent-encoded as individual URL segments. JSON responses
use `Content-Type: application/json`. Binary export responses use the selected
document format's media type and a `Content-Disposition` attachment header.

Structured Doc values can use JSON or the canonical SValue media type:

```text
application/vnd.unidocs.svalue+cbor;version=1
```

For `query`, `apply`, `rollback`, `initFromHash`, `resolveBlob`, and `readBlob`,
that exact `Content-Type` means the request body is SValue-encoded CBOR. Other
content types are parsed as JSON and normalized through the SValue codec.

The protocol permits `query`, `history`, and `resolveBlob` to return SValue.
The client requests it with:

```http
Accept: application/vnd.unidocs.svalue+cbor;version=1
```

Cloudflare also selects SValue output when the request itself uses the SValue
content type. A response containing SBlob references cannot be represented by
the JSON compatibility transport; Cloudflare returns `406` unless SValue was
negotiated. See [Current adapter conformance](#current-adapter-conformance) for
the current Azure limitation.

`GET .../ir` always returns canonical SValue bytes and includes:

```http
Content-Type: application/vnd.unidocs.svalue+cbor;version=1
X-Doc-Version: 42
```

An SBlob is CBOR tag `65536` containing a 32-byte SHA-256 hash. The containing
SValue node records that hash as a CAS child reference. See
[CAS Binary Format](cas-binary-format.md) for canonical encoding and hashing.

## Gateway public API

All end-user operations enter through Gateway. Gateway resolves the caller's
identity, requires its tenant to match the route, and does not forward the
caller's `Authorization`, cookies, internal token, tenant/session headers, or
delegated capability to a Doc service.

Base path:

```text
/tenants/{tenantId}/docs/{docType}
```

| Method and path | Operation | Request | Success response |
| --- | --- | --- | --- |
| `POST /` | Create | Empty, multipart `file` plus optional `format`, or `{ "sourceId": "..." }` | `200` ready or `202` creating; see below |
| `GET /` | List | None | `{ success, data, count }` |
| `GET /{docId}` | Status | None | `{ success, data: { doc_id, doc_type, state, version, created_at, updated_at } }` |
| `POST /{docId}/query` | Query | Document-type query | `{ success, data, version }` as JSON or SValue |
| `POST /{docId}/apply` | Apply | `{ operations, description, baseVersion, opId? }` | `{ success: true, version }` |
| `GET /{docId}/export?format=...` | Export | Optional format | Document bytes |
| `GET /{docId}/history?from=...&to=...` | History | Optional inclusive version bounds | `{ success, data, version }` as JSON or SValue |
| `POST /{docId}/rollback` | Rollback | `{ version }` | `{ success: true, version }` |
| `GET /{docId}/snapshot` | Snapshot | None | `{ success, version, hash, docType }` |
| `GET /{docId}/ir` | Current IR | None | Canonical SValue bytes plus `X-Doc-Version` |
| `POST /{docId}/init_from_hash` | Initialize clone target | `{ hash, sourceVersion }` | `{ success: true, docId, version }` |
| `POST /{docId}/run` | Run Operator | `{ instruction }` | `{ success, data: { response, iterations } }` |
| `POST /{docId}/reset` | Reset Operator | None | `{ success: true }` |

The snapshot and `init_from_hash` routes support Gateway's clone orchestration.
Public callers should clone with `sourceId` on create, not treat a snapshot hash
as an authorization token.

### Create state and idempotency

Create accepts optional `Idempotency-Key` and `X-Doc-Id` headers. Gateway first
reserves a directory row in `creating`, then creates the Doc session and marks
the row `ready`. A normal completed response is:

```json
{
  "success": true,
  "docId": "01K...",
  "state": "ready",
  "version": 1
}
```

If the downstream result is uncertain, Gateway retains the reservation and
returns `202`:

```json
{
  "success": true,
  "docId": "01K...",
  "state": "creating"
}
```

Retrying the same idempotency key probes the original session and can converge
it to `ready`. A deterministic client failure records `failed`; a timeout or
5xx leaves the row `creating` because the Doc service may have committed.

Clone is restricted to a ready source in the same tenant, document type, and
registered Doc service. Gateway fetches the source snapshot and initializes a
new opaque session with that root; it does not copy the content DAG.

## Doc edge service API

This is the service-facing contract used by Gateway. It is not an end-user API.
The current capability route generation is:

```text
/tenants/{tenantId}/sessions/{sessionId}
```

| Method and path | Operation | Request | Success response | Required Doc authority | Delegated CAS authority | Deadline |
| --- | --- | --- | --- | --- | --- | ---: |
| `PUT /tenants/{tenantId}/sessions/{sessionId}` | `create` | Empty or multipart `file` plus optional `format` | `{ success, sessionId, version }` | `sessions:create` for tenant | `cas:write` | 90 s |
| `GET .../status` | `status` | None | `{ exists, version }` | `sessions:create` for tenant | None | 15 s |
| `POST .../query` | `query` | Document-type query | `{ success, data, version }` | Session read | `cas:read` | 60 s |
| `POST .../apply` | `apply` | `{ operations, description, baseVersion, opId? }` | `{ success, version }` | Session write | `cas:read`, `cas:write` | 90 s |
| `GET .../export?format=...` | `export` | None | Document bytes | Session read | `cas:read` | 60 s |
| `GET .../history?from=...&to=...` | `history` | None | `{ success, data, version }` | Session read | None | 30 s |
| `POST .../rollback` | `rollback` | `{ version }` | `{ success, version }` | Session write | `cas:read`, `cas:write` | 90 s |
| `GET .../snapshot` | `snapshot` | None | `{ success, version, hash, docType }` | Session read | `cas:write` | 60 s |
| `GET .../ir` | `ir` | None | Canonical SValue bytes | Session read | `cas:read` | 30 s |
| `POST .../init-from-hash` | `initFromHash` | `{ hash, sourceVersion }` | `{ success, sessionId, version }` | Session write | `cas:read`, `cas:write` | 60 s |
| `POST .../run` | `run` | `{ instruction }` | `{ success, data: { response, iterations } }` | Session write | `cas:read`, `cas:write` | 90 s |
| `POST .../reset` | `reset` | None | `{ success: true }` | Session write | None | 30 s |

Deadlines are Gateway request deadlines. Doc and delegated CAS capabilities
currently have a 120-second maximum lifetime.

### Capability authentication

Capability and `stack` deployments use:

```http
Authorization: Bearer <Doc capability>
X-UniDocs-CAS-Capability: <delegated CAS capability, when required>
```

The Doc capability must:

- have `sub = gateway`;
- bind the path tenant and session;
- contain exactly the one Doc permission required by the operation; and
- target the Doc service's configured audience.

When required, the delegated CAS capability must:

- have `sub = doc:{docType}`;
- bind the same tenant and session;
- contain exactly the operation's required CAS permissions; and
- expire no later than the primary Doc capability.

An operation that requires no CAS authority rejects a supplied delegated CAS
capability. The Doc service never forwards the primary Doc capability to CAS;
it creates a request-local CAS client from only the delegated capability.

### Compatibility authentication modes

The handler recognizes four explicit deployment modes:

| Mode | Tenant routes and capabilities | Legacy routes and static token |
| --- | --- | --- |
| `legacy` | Rejected | Accepted |
| `dual` | Accepted | Accepted |
| `capability` | Accepted | Rejected |
| `stack` | Accepted | No usable legacy credential |

The legacy route generation is `/sessions/{sessionId}` with the same operation
suffixes and methods as the table above. It requires:

```http
X-Internal-Token: <service access key>
X-Tenant-Id: <tenantId>
```

Legacy support exists for migration. Current production guidance is `stack`;
new integrations must use tenant routes and capabilities.

### Edge-to-adapter forwarding

After authentication, the edge copies only `Content-Type`, `Content-Length`,
and `Accept`, then adds trusted context:

```http
X-Tenant-Id: <tenantId>
X-Session-Id: <sessionId>
X-Doc-Type: <docType>
X-UniDocs-Auth-Context: legacy|capability
X-UniDocs-Doc-Operation: <operation>
X-UniDocs-CAS-Capability: <delegated token, when required>
```

The create method changes from edge `PUT` to internal `POST`. Operator `run`
and `reset` go to the Operator object/process; all other operations go to the
Editor session object/process.

## Adapter-internal API

These routes are a private adapter boundary. They are reached only after Doc
edge authentication and must not be exposed directly.

| Method and path | Operation | Request | Success response |
| --- | --- | --- | --- |
| `POST /_internal/create` | Create | Empty or multipart upload | `{ success, sessionId, version }` |
| `GET /_internal/status` | Status | None | `{ exists, version }` |
| `POST /_internal/query` | Query | Document-type query | `{ success, data, version }` |
| `POST /_internal/apply` | Apply | `{ operations, description, baseVersion, opId? }` | `{ success, version }` |
| `GET /_internal/export` | Export | Optional `format` query | Document bytes |
| `GET /_internal/history` | History | Optional `from` and `to` | `{ success, data, version }` |
| `POST /_internal/rollback` | Rollback | `{ version }` | `{ success, version }` |
| `GET /_internal/snapshot` | Snapshot | None | `{ success, version, hash, docType }` |
| `GET /_internal/ir` | Current IR | None | Canonical SValue bytes |
| `POST /_internal/init_from_hash` | Initialize clone target | `{ hash, sourceVersion }` | `{ success, sessionId, version }` |
| `POST /_internal/resolve_blob` | Resolve CAS hash | `{ hash }` | `{ blob }` as negotiated structured value |
| `POST /_internal/read_blob` | Read SBlob | `{ blob }` | Blob bytes plus `X-UniDocs-SBlob-Hash` |
| `POST /_internal/run` | Run Operator | `{ instruction }` | `{ success, data: { response, iterations } }` |
| `POST /_internal/reset` | Reset Operator | None | `{ success: true }` |

Cloudflare also has `GET /_internal/snapshot-index`, an adapter-private storage
diagnostic that is not declared by `@unidocs/protocol-doc`. It is not part of
this contract and callers must not depend on it.

The spelling difference is intentional and frozen by route tests:

| Boundary | Clone initialization path |
| --- | --- |
| Gateway public API | `/{docId}/init_from_hash` |
| Doc edge API | `/{sessionId}/init-from-hash` |
| Adapter-internal API | `/_internal/init_from_hash` |

## Error model

Gateway directory and edge authentication errors use:

```json
{ "error": "message" }
```

Session and Operator errors normally use:

```json
{ "success": false, "error": "message", "version": 42 }
```

`version` is omitted when no current session version is meaningful. Stable
error mappings are:

| Condition | Status | Notes |
| --- | ---: | --- |
| Missing or invalid end-user/Doc capability | `401` | Authentication failed |
| Tenant, session, subject, or permission mismatch | `403` | Authorization failed |
| Unknown route or document/version not found | `404` | Envelope depends on boundary |
| Invalid request or rejected delta | `400` | Delta errors include current version |
| Upload exceeds the configured limit | `413` | Rejected before parsing when length is known |
| Optimistic version conflict or existing document | `409` | Conflict includes current version when available |
| SBlob response requested through JSON transport | `406` | Negotiate SValue |
| Doc service unavailable or registration changed | `503` | Gateway-level failure |
| CAS dependency failure | `400`, `409`, or `502` | CAS 404 maps to 400; CAS 409 remains 409; other failures map to 502 |
| Corrupt storage or unexpected exception | `500` | Includes current version when available |

`baseVersion` provides optimistic locking. Apply is transactional: all
operations in a delta commit, or none do. Optional `opId` makes a successfully
applied operation idempotent within the adapter's retained deduplication state.

## Current adapter conformance

The protocol packages describe the common target contract. As of the verified
date, deployed adapters differ in these areas:

| Area | Cloudflare | Azure |
| --- | --- | --- |
| Core create/query/apply/export/history/rollback/snapshot/status/ir/clone | Implemented | Implemented |
| SValue request parsing | Implemented | Implemented |
| Negotiated SValue query/history response and `406` for SBlob-over-JSON | Implemented | Not implemented; shared handler currently returns JSON |
| Export format query and filename extension | Implemented | Uses the document type's default export and filename `document` |
| `resolveBlob` / `readBlob` private contract | Implemented | Not implemented |
| Operator `run` / `reset` | Implemented where an LLM provider is configured | Returns `501` |

These are conformance gaps, not alternate protocol definitions. Code that must
work across both adapters should stay within the common implemented subset
until the Azure adapter is brought up to the protocol contract.

## Change and conformance checklist

Any protocol change should update, in the same change:

1. Route builders, matchers, and endpoint types in `@unidocs/protocol-doc` or
   `@unidocs/protocol-gateway`.
2. Gateway capability policy and Doc edge capability requirements.
3. Cloudflare and Azure adapters, including header and body streaming behavior.
4. Route, authentication, request/response, and error-mapping tests.
5. This document and the README lifecycle summary.

Adapters must preserve body streaming, strip caller-supplied trust headers,
forward `Accept`, use `Accept-Encoding: identity` across Gateway service calls,
validate exact capability permissions, and preserve downstream status and
response bodies.