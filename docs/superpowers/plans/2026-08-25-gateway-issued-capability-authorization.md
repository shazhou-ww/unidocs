# Gateway-Issued Internal Capability Authorization Implementation Plan

> **Superseded CAS contract (2026-08-26):** This is a historical implementation
> record. Owner assignments, portable-node HTTP, shared keys, tenantless routes,
> and tenant-only CAS namespaces are not current guidance. See
> [CAS Middleware](./2026-08-26-cas-middleware.md) and
> [CAS Architecture](../../cas-architecture.md).

> **Status:** Complete for repository and local-runtime scope (2026-08-26).
> Tasks 0-6, local Task 7 support, and repository Task 8 conformance/docs are
> complete. Production deployment, observation, secret destruction, and active
> revision probes are explicitly deferred and are not completion gates for the
> current phase.
>
> **For agentic workers:** Use an executing-plans workflow and complete one
> task at a time. Keep the checkboxes current. Do not combine this migration
> with the P0 microservice-boundary migration.

**Goal:** Replace the shared long-lived `INTERNAL_TOKEN` with short-lived,
Gateway-issued, asymmetrically signed capability tokens. Doc and CAS validate
tokens locally with Gateway public keys and enforce tenant/session permissions
without learning `userId` or calling Gateway during verification.

**Architecture:** Gateway remains the only user-aware authorization decision
point and the only capability issuer. Every Gateway -> Doc operation gets a Doc
token whose sole audience is the target Doc service. When that operation may
call CAS, Gateway also signs a delegated CAS capability whose sole audience is
CAS. Doc consumes the first token and may use the second as its `Authorization`
credential for CAS calls triggered by that operation. It never forwards the
Doc token to CAS. Public keys and audiences are deployment configuration, so
verification adds no Doc -> Gateway or CAS -> Gateway dependency.

**Tech Stack:** TypeScript, Web Crypto, `jose`, compact JWS/JWT, Vitest,
Cloudflare Workers, Azure Container Apps, deployment-managed secrets/JWKS.

## Scope and prerequisites

Implementation may start only when all of the following are true:

- The P0 microservice-boundary plan is complete, including its full validation
  suite and canonical documentation update.
- Gateway owns the document directory and resolves every public `docId` to an
  immutable `{ tenantId, docType, sessionId }` routing record.
- Doc APIs are tenant-and-session scoped. A session persists exactly one
      immutable `(tenantId, sessionId)` identity; later requests cannot replace
      either value with a header or body field.
- CAS storage, roots, idempotency, usage, and GC are tenant-scoped.
- Only Gateway is publicly exposed. All service links use TLS or a platform
  service binding.
- Doc operations are request-bounded. A Doc service does not continue using a
  delegated capability after the originating Gateway request completes.

This plan does not select or implement the end-user identity provider. It
starts after Gateway has authenticated the user and authorized the public
document operation.

## Non-goals

- OAuth authorization-server flows, OIDC discovery, refresh tokens, or token
  introspection.
- Forwarding end-user Bearer tokens, cookies, `userId`, or `docId` to Doc/CAS.
- A Doc -> Gateway token-exchange or refresh endpoint.
- Long-running autonomous Doc jobs. Such jobs need a separate workload
  identity or an explicit token-exchange design.
- Real-time revocation of an already issued token. Short expiry bounds the
  revocation delay.
- Per-node/hash CAS capabilities or cross-tenant copy.
- mTLS as a replacement for capability authorization. Platform network
  identity and mTLS may remain defense in depth.

## Fixed security decisions

### Token format and trust

- Tokens are compact JWTs protected by JWS, signed asymmetrically by Gateway.
- Initial algorithm: `ES256`. Verifiers accept only the configured algorithm;
  the token cannot choose another algorithm.
- Protected headers contain `alg`, `kid`, and
  `typ: "unidocs-cap+jwt"`. All three are validated.
- Gateway alone has signing capability. Doc and CAS receive only public keys.
- Validation is local. Public keys are supplied as a versioned JWKS through
  deployment configuration; services do not fetch keys from Gateway.
- Each token has exactly one audience. Multi-audience tokens are rejected.
- JWT is a signed container, not encrypted storage. Claims must contain no
  credentials, document content, `userId`, or other secrets.

### Lifetime

- Default lifetime is 120 seconds.
- Verifiers reject tokens whose `exp - iat` exceeds 300 seconds, even if the
  signature is valid.
- Maximum clock skew is 30 seconds.
- Required registered claims are `iss`, `sub`, `aud`, `iat`, `nbf`, `exp`, and
  `jti`.
- `iss` is an environment-specific configured value, not a caller-provided
  URL. Development, test, and production use different signing keys and
  issuers.
- One delegated CAS capability may be reused for all CAS calls made by the
  single Doc operation for which it was issued. It is never persisted in
  session state, a database, a queue, or logs.

Before implementation, Task 0 must assign every synchronous Doc route both an
operation deadline and an issued TTL satisfying:

```text
operation deadline + 30-second completion margin <= issued token TTL <= 300 seconds
```

The deadline is measured from token issuance through the final downstream CAS
call, not merely time spent inside Doc. With the default 120-second TTL, the
maximum operation deadline is therefore 90 seconds. Doc must not start another
CAS call after its request deadline. A route that cannot fit this budget must be
bounded or moved to a separately designed background-work identity; do not
lengthen all capabilities to accommodate an unbounded operation.

### Claims

Doc token example:

```json
{
  "ver": 1,
  "iss": "unidocs-gateway:prod",
  "sub": "gateway",
  "aud": "unidocs-doc:docx",
  "iat": 1787616000,
  "nbf": 1787615995,
  "exp": 1787616120,
  "jti": "6f31f07d-32aa-471f-9717-8e3c907d01fa",
  "tenantId": "tenant-123",
  "sessionId": "session-456",
  "permissions": [
    "tenants:tenant-123:sessions:session-456:write"
  ]
}
```

Delegated CAS capability example:

```json
{
  "ver": 1,
  "iss": "unidocs-gateway:prod",
  "sub": "doc:docx",
  "aud": "unidocs-cas",
  "iat": 1787616000,
  "nbf": 1787615995,
  "exp": 1787616120,
  "jti": "8f57dbe9-6caa-46db-b8bf-84c66cefbc44",
  "tenantId": "tenant-123",
  "sessionId": "session-456",
  "permissions": [
    "tenants:tenant-123:cas:read",
    "tenants:tenant-123:cas:write"
  ]
}
```

The structured `tenantId` claim is mandatory on every business capability. A
structured `sessionId` claim is additionally mandatory on every Doc token,
every delegated Doc -> CAS capability, and every CAS request that changes or
clears session roots. Direct Gateway -> CAS tenant operations such as usage,
GC, or a tenant-scoped node operation omit `sessionId`; those tokens cannot be
used on Doc routes or session-root routes. The shared schema represents these
as distinct tenant-scoped and session-scoped claim variants rather than making
callers invent a dummy session.

These claims provide unambiguous resource comparison even though permission
strings also contain IDs. Permission strings must be built and checked through
shared canonical helpers; application code must not concatenate or parse them
ad hoc. Identifier segments are percent-encoded canonically before being
embedded in a permission string.

### Permission vocabulary

CAS permissions:

```text
tenants:{tenantId}:cas:read
tenants:{tenantId}:cas:write
tenants:{tenantId}:cas:admin
```

- `cas:read`: read node content and metadata and test node existence.
- `cas:write`: upload immutable nodes, create/extend leases, update session
  roots, and write the associated idempotency records.
- `cas:admin`: tenant usage, GC, quota/repair, and other tenant CAS management
  operations.
- The three permissions are independent. `admin` does not imply `read` or
  `write`; a token that needs more than one lists each explicitly.
- A delegated Doc capability is never issued `cas:admin`.
- Cross-tenant platform administration, if later required, uses a separate
  platform workload identity and is outside this plan.

Doc permissions:

```text
tenants:{tenantId}:sessions:create
tenants:{tenantId}:sessions:{sessionId}:read
tenants:{tenantId}:sessions:{sessionId}:write
```

- `sessions:create` is tenant collection scope, but P0 accepts it only in a
      session-scoped token. The create route must require the path `sessionId` to
      equal that signed claim, so the token can create only the one preallocated
      session. A reusable tenant-wide create token is not supported.
- `read` and `write` are independent. Neither permission implies the other.
- Creating the same `{ tenantId, sessionId }` again may converge idempotently;
      the same `sessionId` under another tenant is a distinct resource. No stored
      session or Gateway directory record may have its tenant changed in place.

### HTTP API delta: current to tenant-aware

This migration does not redesign the existing HTTP API. Methods, operation
names, query parameters, request bodies, response bodies, status behavior, and
binary/media framing remain as implemented. In particular, it does not add a
`/v1` prefix, delete routes, `HEAD`/`PUT` CAS operations,
`application/problem+json`, or a new CAS upload format. `init_from_hash`,
multipart create, SValue negotiation, raw export/IR bytes, `X-CAS-Refs`, and
`X-CAS-Lease-Duration` remain part of the contract.

Only two concerns change:

1. resource ownership moves from `userId` to `tenantId`; and
2. shared internal authentication moves from `X-Internal-Token` plus identity
   headers to the capability credentials defined in this plan.

The one required shape exception is Doc create: Gateway must preallocate the
private `sessionId` and put it in the target Doc path so the create capability
can be bound to one session. Existing non-create Doc operations retain their
method and final operation segment, with the current worker-side `docId`
replaced by that Gateway-resolved private `sessionId`.

#### Authentication and identity delta

| Edge | Current | Target |
|------|---------|--------|
| Client -> Gateway | path `userId`; end-user auth is not yet enforced here | path `tenantId`; Gateway authenticates the user and authorizes membership/operation in that tenant |
| Gateway -> Doc | `X-Internal-Token`, `X-Tenant-Id`, `X-Doc-Type`, `X-Session-Id` | Doc Bearer capability plus optional `X-UniDocs-CAS-Capability`; tenant/session come from matched path and signed claims |
| Gateway -> CAS | `X-Internal-Token`, `X-Tenant-Id` | CAS Bearer capability; path `tenantId` must equal the signed claim |
| Doc -> CAS | `X-Internal-Token`, `X-Tenant-Id` | delegated CAS Bearer capability; path `tenantId` must equal the signed claim |

Gateway never treats the public tenant path as authorization by itself. Doc
and CAS authenticate before parsing a business body or selecting tenant
storage. Incoming user credentials, cookies, internal-looking headers, and
identity headers are not forwarded. Adapter-private DO calls may carry derived
tenant/session context after the service edge has authenticated it, but those
headers are not credentials and are never accepted at a service edge.

#### Gateway document API comparison

The Gateway public `docType`, `docId`, methods, query parameters, body framing,
and response framing stay unchanged. Only `/users/{userId}` becomes
`/tenants/{tenantId}`.

| Current route | Tenant-aware route | Request/response types |
|---------------|--------------------|------------------------|
| `GET /users/{userId}/docs/{docType}/` | `GET /tenants/{tenantId}/docs/{docType}/` | `GatewayListDocumentsRequest` / `GatewayListDocumentsResponse` |
| `POST /users/{userId}/docs/{docType}/` | `POST /tenants/{tenantId}/docs/{docType}/` | `GatewayCreateDocumentRequest` / `GatewayCreateDocumentResponse` |
| `GET /users/{userId}/docs/{docType}/{docId}` | `GET /tenants/{tenantId}/docs/{docType}/{docId}` | `GatewayStatusDocumentRequest` / `GatewayStatusDocumentResponse` |
| `POST /users/{userId}/docs/{docType}/{docId}/query` | `POST /tenants/{tenantId}/docs/{docType}/{docId}/query` | `GatewayQueryDocumentRequest<TQuery>` / `GatewayQueryDocumentResponse` |
| `POST /users/{userId}/docs/{docType}/{docId}/apply` | `POST /tenants/{tenantId}/docs/{docType}/{docId}/apply` | `GatewayApplyDocumentRequest<TOp>` / `GatewayApplyDocumentResponse` |
| `GET /users/{userId}/docs/{docType}/{docId}/export?format=` | `GET /tenants/{tenantId}/docs/{docType}/{docId}/export?format=` | `GatewayExportDocumentRequest` / `GatewayExportDocumentResponse` |
| `GET /users/{userId}/docs/{docType}/{docId}/history?from=&to=` | `GET /tenants/{tenantId}/docs/{docType}/{docId}/history?from=&to=` | `GatewayHistoryDocumentRequest` / `GatewayHistoryDocumentResponse<TOp>` |
| `POST /users/{userId}/docs/{docType}/{docId}/rollback` | `POST /tenants/{tenantId}/docs/{docType}/{docId}/rollback` | `GatewayRollbackDocumentRequest` / `GatewayRollbackDocumentResponse` |
| `GET /users/{userId}/docs/{docType}/{docId}/snapshot` | `GET /tenants/{tenantId}/docs/{docType}/{docId}/snapshot` | `GatewaySnapshotDocumentRequest` / `GatewaySnapshotDocumentResponse` |
| `GET /users/{userId}/docs/{docType}/{docId}/ir` | `GET /tenants/{tenantId}/docs/{docType}/{docId}/ir` | `GatewayIrDocumentRequest` / `GatewayIrDocumentResponse` |
| `POST /users/{userId}/docs/{docType}/{docId}/init_from_hash` | `POST /tenants/{tenantId}/docs/{docType}/{docId}/init_from_hash` | `GatewayInitFromHashRequest` / `GatewayInitFromHashResponse` |
| `POST /users/{userId}/docs/{docType}/{docId}/run` | `POST /tenants/{tenantId}/docs/{docType}/{docId}/run` | `GatewayRunOperatorRequest` / `GatewayRunOperatorResponse` |
| `POST /users/{userId}/docs/{docType}/{docId}/reset` | `POST /tenants/{tenantId}/docs/{docType}/{docId}/reset` | `GatewayResetOperatorRequest` / `GatewayResetOperatorResponse` |

Gateway's legacy `/users/*` allowlist proxies five public CAS operations: node
content, metadata, create/lease, lease extension, and usage. It currently
rejects GC. The target tenant-aware Gateway allowlist exposes those five plus
the existing CAS GC operation after Gateway's tenant-admin authorization.
Their canonical types are defined by `protocol-cas` below;
`protocol-gateway` exports these aliases instead of copying their fields:
`GatewayCasReadContentRequest`/`GatewayCasReadContentResponse`,
`GatewayCasReadMetadataRequest`/`GatewayCasReadMetadataResponse`,
`GatewayCasLeaseNodeRequest`/`GatewayCasLeaseNodeResponse`,
`GatewayCasLeaseExistingRequest`/`GatewayCasLeaseExistingResponse`,
`GatewayCasUsageRequest`/`GatewayCasUsageResponse`, and
`GatewayCasGcRequest`/`GatewayCasGcResponse`.

#### Doc service-class API comparison

Gateway still selects one configured doctype service and strips
`/docs/{docType}`. The target service route uses the private `sessionId` from
the Gateway directory, not public `docId`; this does not change any operation's
payload or response. Every doctype must expose the same route set. Current
runtime differences in SValue negotiation, `format`, and unimplemented
operator behavior are recorded rather than normalized in this auth migration.

| Current Doc route | Tenant-aware Doc route | Request/response types |
|-------------------|------------------------|------------------------|
| `PUT /sessions/{sessionId}` | `PUT /tenants/{tenantId}/sessions/{sessionId}` | `DocCreateRequest` / `DocCreateResponse` |
| `POST /sessions/{sessionId}/query` | `POST /tenants/{tenantId}/sessions/{sessionId}/query` | `DocQueryRequest<TQuery>` / `DocQueryResponse` (`data: SValue`) |
| `POST /sessions/{sessionId}/apply` | `POST /tenants/{tenantId}/sessions/{sessionId}/apply` | `DocApplyRequest<TOp>` / `DocApplyResponse` |
| `GET /sessions/{sessionId}/export?format=` | `GET /tenants/{tenantId}/sessions/{sessionId}/export?format=` | `DocExportRequest` / `DocExportResponse` |
| `GET /sessions/{sessionId}/history?from=&to=` | `GET /tenants/{tenantId}/sessions/{sessionId}/history?from=&to=` | `DocHistoryRequest` / `DocHistoryResponse<TOp>` |
| `POST /sessions/{sessionId}/rollback` | `POST /tenants/{tenantId}/sessions/{sessionId}/rollback` | `DocRollbackRequest` / `DocRollbackResponse` |
| `GET /sessions/{sessionId}/snapshot` | `GET /tenants/{tenantId}/sessions/{sessionId}/snapshot` | `DocSnapshotRequest` / `DocSnapshotResponse` |
| `GET /sessions/{sessionId}/status` | `GET /tenants/{tenantId}/sessions/{sessionId}/status` | `DocStatusRequest` / `DocStatusResponse` |
| `GET /sessions/{sessionId}/ir` | `GET /tenants/{tenantId}/sessions/{sessionId}/ir` | `DocIrRequest` / `DocIrResponse` |
| `POST /sessions/{sessionId}/init-from-hash` | `POST /tenants/{tenantId}/sessions/{sessionId}/init-from-hash` | `DocInitFromHashRequest` / `DocInitFromHashResponse` |
| `POST /sessions/{sessionId}/run` | `POST /tenants/{tenantId}/sessions/{sessionId}/run` | `DocRunOperatorRequest` / `DocRunOperatorResponse` |
| `POST /sessions/{sessionId}/reset` | `POST /tenants/{tenantId}/sessions/{sessionId}/reset` | `DocResetOperatorRequest` / `DocResetOperatorResponse` |

The adapter-private Editor routes remain `/_internal/create`, `query`, `apply`,
`export`, `history`, `rollback`, `snapshot`, `status`, `ir`, and
`init_from_hash`; they
use the corresponding `DocXxxRequest`/`DocXxxResponse` pair. Cloudflare-only
`POST /_internal/resolve_blob` and `POST /_internal/read_blob` use
`DocResolveBlobRequest`/`DocResolveBlobResponse` and
`DocReadBlobRequest`/`DocReadBlobResponse`. These are private adapter APIs, not
additional doctype service-edge routes.

Doc storage becomes tenant-aware without otherwise redesigning document
storage. A dedicated doctype namespace keys by `(tenantId, sessionId)`; a
database shared by doctypes keys by `(tenantId, configuredDocType, sessionId)`.
The configured type is trusted deployment state, not a request header. The
same `sessionId` in two tenants is valid and isolated.

#### CAS API comparison

The post-P0 CAS service public edge is already tenant-aware; only its shared
credential changes. Internal CAS routes gain the same tenant prefix so CAS can
compare the path with the signed claim; their `/_internal/*` suffixes, methods,
headers other than auth, bodies, and responses stay unchanged.

| Current CAS route | Tenant-aware CAS route | Request/response types |
|-------------------|------------------------|------------------------|
| `GET /tenants/{tenantId}/cas/nodes/{hash}/content` | unchanged | `CasReadContentRequest` / `CasReadContentResponse` |
| `GET /tenants/{tenantId}/cas/nodes/{hash}/metadata` | unchanged | `CasReadMetadataRequest` / `CasReadMetadataResponse` |
| `POST /tenants/{tenantId}/cas/nodes/{hash}` | unchanged | `CasLeaseNodeRequest` / `CasLeaseNodeResponse` |
| `POST /tenants/{tenantId}/cas/nodes/{hash}/lease` | unchanged | `CasLeaseExistingRequest` / `CasLeaseExistingResponse` |
| `GET /tenants/{tenantId}/cas/usage` | unchanged | `CasUsageRequest` / `CasUsageResponse` |
| `POST /tenants/{tenantId}/cas/gc` | unchanged | `CasGcRequest` / `CasGcResponse` |
| `POST /_internal/root-refs` plus `X-Tenant-Id` | `POST /tenants/{tenantId}/_internal/root-refs` | `CasRootRefsRequest` / `CasRootRefsResponse` |
| `POST /_internal/root-assignments` plus `X-Tenant-Id` | `POST /tenants/{tenantId}/_internal/root-assignments` | `CasRootAssignmentsRequest` / `CasRootAssignmentsResponse` |
| `GET /_internal/nodes/{hash}` plus `X-Tenant-Id` | `GET /tenants/{tenantId}/_internal/nodes/{hash}` | `CasReadPortableNodeRequest` / `CasReadPortableNodeResponse` |
| `POST /_internal/nodes/{hash}` plus `X-Tenant-Id` | `POST /tenants/{tenantId}/_internal/nodes/{hash}` | `CasLeasePortableNodeRequest` / `CasLeasePortableNodeResponse` |

`CasLeaseNodeRequest` continues to model raw content plus `Content-Type`,
`Content-Length`, optional `X-CAS-Refs`, and optional
`X-CAS-Lease-Duration`; it is not a new JSON envelope. Portable-node operations
continue to use `application/vnd.unidocs.cas-node`. CAS physical node identity
changes from `(userId, hash)` to `(tenantId, hash)`, including database, object
key, Durable Object, idempotency, usage, and GC partitions.

#### Protocol package split

Replace `@unidocs/http-protocol` with three service-owned packages. This is an
ownership split, not a wire-format migration.

| Package | Owns |
|---------|------|
| `@unidocs/protocol-cas` | CAS route constants/builders/matchers, all `CasXxxRequest`/`CasXxxResponse` types above, CAS domain types, CAS media/header constants, and `CasErrorResponse` |
| `@unidocs/protocol-doc` | Doc route constants/builders/matchers, all `DocXxxRequest`/`DocXxxResponse` types above, `HistoryEntry`, SValue negotiation/media constants, and `DocErrorResponse` |
| `@unidocs/protocol-gateway` | Gateway public route constants/builders/matchers, all `GatewayXxxRequest`/`GatewayXxxResponse` types above, document directory/list DTOs, and `GatewayErrorResponse` |

Every endpoint exports an explicit pair even when the request has no body or
the response is raw bytes. A request type models its path parameters, query,
relevant headers, and body separately so it does not imply a new JSON wrapper.
A response type models the current body and relevant response headers; binary
bodies use `Uint8Array`. Each package's endpoint response is a union with that
package's current error shape where applicable. Existing field names such as
`success`, `docId`, `doc_id`, and `owner_id` are retained in this migration.

Dependencies are one-way: `protocol-cas` has no dependency on the other two;
`protocol-doc` may import CAS identifiers; `protocol-gateway` may alias Doc/CAS
payload types for pass-through endpoints. Shared document/SValue domain types
remain in `@unidocs/protocol`. `HttpFetcher`, client configuration, and client
error classes move to their client/transport packages rather than creating a
new catch-all protocol package.

The following is the minimum type-shape baseline. `path`, `query`, `headers`,
and `body` describe parts of an HTTP request; they are not serialized as a new
JSON envelope. Error unions preserve the current service-specific error bodies.

`protocol-doc` defines:

```ts
interface DocSessionPath { tenantId: string; sessionId: string }
interface DocErrorResponse { success?: false; error: string; version?: number }
type DocStructuredRequestBody<T extends SValue> =
      | { contentType: "application/json"; value: T }
      | { contentType: "application/vnd.unidocs.svalue+cbor;version=1"; bytes: Uint8Array };
type DocNegotiatedResponse<T extends SValue> =
      | { contentType: "application/json"; value: T }
      | {
                  contentType: "application/vnd.unidocs.svalue+cbor;version=1";
                  body: Uint8Array;
            };

interface DocCreateRequest {
      path: DocSessionPath;
      form?: { file?: File; format?: string };
}
interface CreateResult {
      success: boolean;
      sessionId: string;
      version: number;
      error?: string;
}
type DocCreateResponse = CreateResult | DocErrorResponse;

interface DocQueryRequest<TQuery extends SValue = SValue> {
      path: DocSessionPath;
      headers: { accept?: string };
      body: DocStructuredRequestBody<TQuery>;
}
type DocQueryResponse =
      | DocNegotiatedResponse<{ success: true; data: SValue; version: number }>
      | DocErrorResponse;

interface DocApplyRequest<TOp extends SValue = SValue> {
      path: DocSessionPath;
      body: DocStructuredRequestBody<{
            operations: TOp[];
            description: string;
            baseVersion: number;
            opId?: string;
      }>;
}
type DocApplyResponse = ApplyResult | DocErrorResponse;

interface DocExportRequest { path: DocSessionPath; query: { format?: string } }
type DocExportResponse =
      | { body: Uint8Array; headers: { contentType: string; contentDisposition: string } }
      | DocErrorResponse;

interface DocHistoryRequest {
      path: DocSessionPath;
      headers: { accept?: string };
      query: { from?: string; to?: string };
}
type HistoryEntry<TOp extends SValue = SValue> = {
      version: number;
      timestamp: string;
      description: string;
      operations: TOp[];
};
type DocHistoryResponse<TOp extends SValue = SValue> =
      | DocNegotiatedResponse<{
                  success: true;
                  data: HistoryEntry<TOp>[];
                  version: number;
            }>
      | DocErrorResponse;

interface DocRollbackRequest {
      path: DocSessionPath;
      body: DocStructuredRequestBody<{ version: number }>;
}
type DocRollbackResponse = RollbackResult | DocErrorResponse;

interface DocSnapshotRequest { path: DocSessionPath }
type DocSnapshotResponse =
      | { success: true; version: number; hash: string; docType: string }
      | DocErrorResponse;

interface DocStatusRequest { path: DocSessionPath }
type DocStatusResponse =
      | { exists: boolean; version: number }
      | DocErrorResponse;

interface DocIrRequest { path: DocSessionPath }
type DocIrResponse =
      | { body: Uint8Array; headers: { contentType: string; docVersion: number } }
      | DocErrorResponse;

interface DocInitFromHashRequest {
      path: DocSessionPath;
      body: DocStructuredRequestBody<{ hash: string; sourceVersion: number }>;
}
type DocInitFromHashResponse = CreateResult | DocErrorResponse;

interface DocRunOperatorRequest {
      path: DocSessionPath;
      body: { instruction: string };
}
type DocRunOperatorResponse =
      | { success: true; data: { response: string; iterations: number } }
      | DocErrorResponse;

interface DocResetOperatorRequest { path: DocSessionPath }
type DocResetOperatorResponse = { success: true } | DocErrorResponse;

interface DocResolveBlobRequest {
      headers: { accept?: string };
      body: DocStructuredRequestBody<{ hash: string }>;
}
type DocResolveBlobResponse =
      | DocNegotiatedResponse<{ blob: SBlob }>
      | DocErrorResponse;
interface DocReadBlobRequest {
      body: DocStructuredRequestBody<{ blob: SBlob }>;
}
type DocReadBlobResponse =
      | { body: Uint8Array; headers: { contentType: string; sblobHash: string } }
      | DocErrorResponse;
```

`protocol-gateway` defines the public route path in each
`GatewayXxxRequest`, aliases the matching Doc query/body and response payload,
and never exposes `sessionId`:

```ts
interface GatewayDocumentCollectionPath { tenantId: string; docType: string }
interface GatewayDocumentPath extends GatewayDocumentCollectionPath { docId: string }
interface GatewayErrorResponse { error: string }

interface GatewayListDocumentsRequest {
      path: GatewayDocumentCollectionPath;
}
type GatewayListDocumentsResponse =
      | {
                  success: true;
                  data: Array<{
                        doc_id: string;
                        doc_type: string;
                        owner_id: string;
                        version: number;
                        created_at: number;
                        updated_at: number;
                  }>;
                  count: number;
            }
      | GatewayErrorResponse;

interface GatewayCreateDocumentRequest {
      path: GatewayDocumentCollectionPath;
      form?: DocCreateRequest["form"];
}
type GatewayCreateDocumentResponse =
      | {
            success: true;
            docId: string;
            state: "creating" | "ready";
            version?: number;
        }
      | {
            success: false;
            docId: string;
            state: "failed";
            error: string | null;
        }
      | GatewayErrorResponse;

interface GatewayStatusDocumentRequest { path: GatewayDocumentPath }
type GatewayStatusDocumentResponse =
      | {
            success: true;
            data: {
                  doc_id: string;
                  doc_type: string;
                  state: "creating" | "ready" | "failed";
                  version: number | null;
                  created_at: number;
                  updated_at: number;
            };
        }
      | GatewayErrorResponse;

interface GatewayQueryDocumentRequest<TQuery extends SValue = SValue> {
      path: GatewayDocumentPath;
      headers: DocQueryRequest<TQuery>["headers"];
      body: DocQueryRequest<TQuery>["body"];
}
type GatewayQueryDocumentResponse = DocQueryResponse;

interface GatewayApplyDocumentRequest<TOp extends SValue = SValue> {
      path: GatewayDocumentPath;
      body: DocApplyRequest<TOp>["body"];
}
type GatewayApplyDocumentResponse = DocApplyResponse;

interface GatewayExportDocumentRequest {
      path: GatewayDocumentPath;
      query: DocExportRequest["query"];
}
type GatewayExportDocumentResponse = DocExportResponse;

interface GatewayHistoryDocumentRequest {
      path: GatewayDocumentPath;
      headers: DocHistoryRequest["headers"];
      query: DocHistoryRequest["query"];
}
type GatewayHistoryDocumentResponse<TOp> = DocHistoryResponse<TOp>;

interface GatewayRollbackDocumentRequest {
      path: GatewayDocumentPath;
      body: DocRollbackRequest["body"];
}
type GatewayRollbackDocumentResponse = DocRollbackResponse;

interface GatewaySnapshotDocumentRequest { path: GatewayDocumentPath }
type GatewaySnapshotDocumentResponse = DocSnapshotResponse;
interface GatewayIrDocumentRequest { path: GatewayDocumentPath }
type GatewayIrDocumentResponse = DocIrResponse;

interface GatewayInitFromHashRequest {
      path: GatewayDocumentPath;
      body: DocInitFromHashRequest["body"];
}
type GatewayInitFromHashResponse =
      | { success: true; docId: string; version: number }
      | GatewayErrorResponse;

interface GatewayRunOperatorRequest {
      path: GatewayDocumentPath;
      body: DocRunOperatorRequest["body"];
}
type GatewayRunOperatorResponse = DocRunOperatorResponse;
interface GatewayResetOperatorRequest { path: GatewayDocumentPath }
type GatewayResetOperatorResponse = DocResetOperatorResponse;

type GatewayCasReadContentRequest = CasReadContentRequest;
type GatewayCasReadContentResponse = CasReadContentResponse;
type GatewayCasReadMetadataRequest = CasReadMetadataRequest;
type GatewayCasReadMetadataResponse = CasReadMetadataResponse;
type GatewayCasLeaseNodeRequest = CasLeaseNodeRequest;
type GatewayCasLeaseNodeResponse = CasLeaseNodeResponse;
type GatewayCasLeaseExistingRequest = CasLeaseExistingRequest;
type GatewayCasLeaseExistingResponse = CasLeaseExistingResponse;
type GatewayCasUsageRequest = CasUsageRequest;
type GatewayCasUsageResponse = CasUsageResponse;
type GatewayCasGcRequest = CasGcRequest;
type GatewayCasGcResponse = CasGcResponse;
```

The CAS aliases reuse the same parsed path parameters even though the Gateway
URL contains the additional literal `/cas` segment. Route builders remain
package-specific, so an alias cannot accidentally generate a service URL.

`protocol-cas` defines:

```ts
interface CasNodePath { tenantId: string; hash: string }
interface CasErrorResponse { error: string }

interface CasReadContentRequest { path: CasNodePath }
type CasReadContentResponse =
      | { body: Uint8Array; headers: { contentType: string } }
      | CasErrorResponse;

interface CasReadMetadataRequest { path: CasNodePath }
type CasReadMetadataResponse =
      | { metadata: CasNodeMetadata; state: CasNodeState }
      | CasErrorResponse;

interface CasLeaseNodeRequest {
      path: CasNodePath;
      headers: {
            contentType: string;
            contentLength: number;
            refs?: CasHash[];
            leaseDurationMs?: number;
      };
      body: Uint8Array;
}
type CasLeaseNodeResponse = CasLeaseResult | CasErrorResponse;

interface CasLeaseExistingRequest {
      path: CasNodePath;
      headers: { leaseDurationMs?: number };
}
type CasLeaseExistingResponse = CasLeaseResult | CasErrorResponse;

interface CasUsageRequest { path: { tenantId: string } }
type CasUsageResponse = CasUsage | CasErrorResponse;
interface CasGcRequest {
      path: { tenantId: string };
      body?: { maxNodes?: number };
}
type CasGcResponse = CasGcResult | CasErrorResponse;

interface CasRootRefsRequest {
      path: { tenantId: string };
      body: CasRootRefUpdate;
}
type CasRootRefsResponse =
      | { success: true; idempotent?: true }
      | CasErrorResponse;

interface CasRootAssignmentsRequest {
      path: { tenantId: string };
      body: CasAssignRootsRequest;
}
type CasRootAssignmentsResponse =
      | { success: true; idempotent: boolean }
      | CasErrorResponse;

interface CasReadPortableNodeRequest { path: CasNodePath }
type CasReadPortableNodeResponse =
      | { body: Uint8Array; headers: { contentType: "application/vnd.unidocs.cas-node" } }
      | CasErrorResponse;

interface CasLeasePortableNodeRequest {
      path: CasNodePath;
      headers: { leaseDurationMs?: number };
      body: Uint8Array;
}
type CasLeasePortableNodeResponse = CasLeaseResult | CasErrorResponse;
```

### Route authorization matrix

Doc edge:

| Tenant-aware Doc route | Required Doc permission | Delegated CAS permission |
|------------------------|-------------------------|----------------------------|
| `PUT /tenants/{tenantId}/sessions/{sessionId}` | tenant `sessions:create`, constrained to signed `sessionId` | `cas:write` |
| `GET .../status` | tenant `sessions:create`, constrained to signed `sessionId` | none |
| `POST .../query`; `GET .../export` | session `read` | `cas:read` |
| `GET .../history`; `GET .../ir` | session `read` | none |
| `GET .../snapshot` | session `read` | `cas:write` |
| `POST .../apply`; `POST .../rollback`; `POST .../run` | session `write` | `cas:read` + `cas:write` |
| `POST .../init-from-hash` | session `write` | `cas:read` + `cas:write` |
| `POST .../reset` | session `write` | none |

This is the union of current doctype behavior. Markdown/docx may use less, but
PSD query/export can materialize SBlobs from CAS, create can store SBlobs,
snapshot/init can update roots, and apply/rollback/run can do both. Route policy
stays identical for every doctype rather than deriving authority from a
caller-selected type-specific shortcut.

The status route is only for Gateway create reconciliation; the public Gateway
status response comes from its directory. For a `none` route, Gateway omits
`X-UniDocs-CAS-Capability`; Doc rejects an
unexpected delegated capability and the request path cannot construct a CAS
client.

CAS edge:

| Tenant-aware CAS route | Required CAS permission | Additional constraint |
|------------------------|-------------------------|-----------------------|
| `GET /tenants/{tenantId}/cas/nodes/{hash}/content`; `GET .../metadata`; `GET /tenants/{tenantId}/_internal/nodes/{hash}` | tenant `cas:read` | path tenant equals token tenant |
| `POST /tenants/{tenantId}/cas/nodes/{hash}`; `POST .../lease`; `POST /tenants/{tenantId}/_internal/nodes/{hash}` | tenant `cas:write` | path tenant equals token tenant |
| `POST /tenants/{tenantId}/_internal/root-refs`; `POST .../root-assignments` | tenant `cas:write` | path tenant equals token tenant and token has the calling Doc `sessionId` |
| `GET /tenants/{tenantId}/cas/usage`; `POST /tenants/{tenantId}/cas/gc` | tenant `cas:admin` | path tenant equals token tenant; `sessionId` claim is absent |

CAS permissions remain independent. `admin` does not imply `read` or `write`,
and delegated Doc capabilities never contain `cas:admin`.

### Two-token delegation

For a route that requires CAS, Gateway sends the tokens to Doc as:

```http
Authorization: Bearer <doc-token>
X-UniDocs-CAS-Capability: <cas-token>
```

Doc always verifies the primary Doc token before beginning an operation. When
the route matrix requires CAS, it also verifies the delegated capability:

1. The Doc token has the configured Doc audience and required session
   permission.
2. The CAS capability has the CAS audience and exactly the same `tenantId` and
   `sessionId`.
3. The CAS capability contains the CAS permissions required by the Doc route
   and no `cas:admin` permission.
4. The token lifetimes are valid; the CAS capability may not expire after the
   Doc token.

For a `none` route, the CAS capability header must be absent and Doc performs
no CAS call. These are the only one-token Gateway -> Doc request shapes.

For a CAS request, Doc builds a new minimal header set and sends:

```http
Authorization: Bearer <cas-token>
```

The Doc token is never forwarded. The CAS capability never contains a Doc
permission. CAS rejects a correctly signed Doc token because its audience is
wrong. Doc likewise rejects a correctly signed CAS token as its primary
credential.

Gateway calls CAS directly with a separate CAS-only token whose `sub` is
`gateway`; it does not reuse a Doc token or a delegated Doc capability.

## Security invariants

1. Authentication precedes parsing or trusting tenant/session context.
2. Missing signing/trust configuration fails service startup; missing or
   invalid credentials fail closed at request time.
3. A valid signature alone is insufficient: `typ`, algorithm, key id, issuer,
   audience, version, lifetime, permissions, tenant, and session are all
   checked.
4. URL/body/session metadata cannot override signed claims. Doc additionally
   compares the claims with its persisted immutable session metadata.
5. Gateway constructs internal requests from an allowlist. It strips incoming
   `Authorization`, cookies, forwarding headers, internal capability headers,
   `userId`, and untrusted tenant/session headers.
6. Full tokens and private keys never enter logs, traces, error bodies, metrics,
   database rows, queues, or crash annotations.
7. Authorization failures return `401` for an absent/invalid/expired token and
   `403` for a valid token lacking permission or resource scope.
8. Capability possession is sufficient only until `exp`; TLS/service bindings
   protect tokens in transit. This plan does not add an online replay store.
9. A compromised Doc can use a delegated capability only for its signed
   tenant/session and lifetime. Tenant-wide node visibility within that bound
   tenant is an accepted P0 property; per-hash restriction is future work.
10. `INTERNAL_TOKEN` compatibility is temporary and must be absent at the
    completion gate.

## Final post-P0 ownership map

These files are the final ownership boundaries for this migration. A runtime
adapter may translate an authenticated request into private platform context,
but it must not redefine route, claim, or permission policy.

| Surface | Expected responsibility |
|---------|-------------------------|
| CAS protocol | `packages/protocol-cas/src/routes.ts`, `http.ts`, and `types.ts` own CAS routes, endpoint pairs, media/header constants, domain types, and the public allowlist; `index.ts` is only their barrel. |
| Doc protocol | `packages/protocol-doc/src/routes.ts`, `http.ts`, and `errors.ts` own the shared Doc edge/private route set, endpoint pairs, history/results, SValue media constants, and Doc errors; `index.ts` is only their barrel. |
| Gateway protocol | `packages/protocol-gateway/src/index.ts` owns public Gateway routes, directory/list DTOs, endpoint pairs, and pass-through Doc/CAS aliases. It must not own service-edge route builders. |
| Capability protocol | `packages/service-auth/src/claims.ts`, `permissions.ts`, `issuer.ts`, `verifier.ts`, `errors.ts`, and `index.ts` will own the cloud-neutral schema, canonical permissions, issuance/verification, failures, and public API. |
| Gateway policy | `packages/gateway-common/src/gateway-handler.ts`, `document-directory.ts`, `doc-service-registry.ts`, and `identity.ts` own tenant-aware dispatch, immutable directory resolution, route policy, downstream request construction, and the user-to-tenant authorization boundary. |
| Gateway adapters | `packages/cloudflare-gateway/src/worker.ts` and `document-directory.ts`, plus `packages/azure-gateway/src/main.ts`, `document-directory.ts`, and `migrations/`, own only platform key/config and directory adapters. |
| Shared Doc edge | `packages/doctype-server-common/src/doc-type-handler.ts`, `session-handler.ts`, `session.ts`, and `ports.ts` own edge dispatch, immutable tenant/session identity, audience/permission policy, and request-local CAS delegation for every doctype. |
| Doc platform state | `packages/cloudflare-sdk/src/editor-do-svalue.ts`, `operator-do-agent.ts`, and related SDK ports own Durable Object adaptation. `packages/azure-sdk/src/doc-type-service.ts`, `local-editor.ts`, `ports-pg.ts`, `ports-blob.ts`, and `migrations/` own Azure HTTP/Postgres/blob adaptation. Doctype worker/service entry points bind only configured `docType` and platform dependencies. |
| CAS implementation | `packages/cloudflare-cas/src/worker.ts`, `cas/routes.ts`, `cas/do.ts`, and `cas/schema.ts` own the CAS edge, operations, tenant storage, roots, usage, and GC. `packages/cas-server-common/src/digest.ts`, `binary.ts`, and `validation.ts` own cloud-neutral CAS encoding and validation only. There is no separate Azure CAS service. |
| CAS client | `packages/cas-client/src/index.ts` owns `HttpFetcher`, capability-aware client configuration/error types, protocol route construction, current framing, and request-local delegated credentials. |
| Local runtime | `scripts/doc-types.mjs`, `scripts/local-runtime.mjs`, `local/runtime.mjs`, and `azure/local/runtime.mjs` own local key fixtures, service registration, and migration wiring. |
| Deployment | Package `wrangler.toml` files and `azure/deploy/container-app.bicep`, `deploy.mjs`, and service `azure.service.json` files own secret/JWKS distribution, audience/issuer configuration, and rotation-triggered deployments. |

---

### Task 0: Rebase after P0 and freeze the final protocol surfaces

- [x] Rebase this branch onto the commit that completes the P0
      microservice-boundary plan. Do not start from an intermediate P0 state.
- [x] Verify the current-to-tenant route tables above against every Gateway,
      Doc, and CAS implementation after the rebase. Include both cloud runtimes,
      every doctype, and private adapter routes; record differences rather than
      silently redesigning them.
- [x] Freeze the current methods, operation names, query parameters, request
      and response bodies, headers, media types, status behavior, and runtime
      differences. Only tenant identity and capability authentication may
      change in this plan.
- [x] Record every existing `@unidocs/http-protocol` export and its destination
      in `protocol-cas`, `protocol-doc`, `protocol-gateway`, or a client package.
      No compatibility export may remain ownerless.
- [x] Confirm the final Gateway directory interface and immutable
      `{ tenantId, docId, docType, sessionId }` record, Doc tenant/session
      storage keys, CAS tenant keys/root owner model, and deployment
      registrations.
- [x] Assign every Doc route an end-to-end operation deadline and issued TTL
      satisfying `deadline + 30 seconds <= TTL <= 300 seconds`. Resolve any
      route that cannot fit without introducing Doc -> Gateway.
- [x] Replace the provisional ownership map above with exact final files and
      package names.
- [x] Record the current `INTERNAL_TOKEN` call graph and all startup/deployment
      configuration that must be removed.
- [x] Capture the focused baseline for Gateway, Doc, CAS, CAS client, local
      runtime, and Azure/Cloudflare integration suites.

**Gate:** No implementation edit is made until the P0 completion commit, the
verified current-to-tenant route inventory, complete type-move inventory, and
the final ownership table are recorded here.

#### Post-P0 rebase record (2026-08-26)

- `cdce042` is the P0 completion commit and is an ancestor of the working HEAD,
      `012957b`.
- The provisional protocol commits `5121de6` and `e67284b` are also ancestors
      of that HEAD. They created and formatted the three target protocol packages
      before the P0 audit was complete; their contracts are scaffolding, not a
      completed Task 1 migration.
- `plan/internal-capability-auth` had no divergent commits and was
      fast-forwarded from `e67284b` to `012957b`.

#### Verified route inventory and corrections

The post-P0 runtime, rather than the provisional protocol packages, freezes the
current side of this migration. The following differences must be corrected in
the comparison tables and explicit endpoint types before runtime adoption:

| Surface | Post-P0 current runtime | Capability target and correction |
|---------|-------------------------|----------------------------------|
| Gateway documents | The routes remain under `/users/{userId}/docs/{docType}` with the methods and operation suffixes listed above. There is also `GET /users/{userId}/docs/{docType}/{docId}` for status. | Replace only the identity prefix with `/tenants/{tenantId}` and add the omitted status endpoint pair. Preserve every current method, suffix, query, body, response, and status behavior. |
| Shared Doc edge | `PUT /sessions/{sessionId}` creates; the remaining routes are `/sessions/{sessionId}/{operation}`. The actual clone spelling is `POST .../init-from-hash`, and `GET .../status` is part of the service contract. | Use `/tenants/{tenantId}/sessions/{sessionId}` while preserving `PUT` create, `init-from-hash`, and status. The provisional `protocol-doc` routes used `POST /tenants/{tenantId}/{sessionId}/`, `init_from_hash`, and omitted status; Task 1 corrected those shapes before runtime adoption. |
| Doc private adapters | Editor routes remain `/_internal/create`, `query`, `apply`, `export`, `history`, `rollback`, `snapshot`, `ir`, `init_from_hash`, and `status`; Cloudflare additionally exposes `resolve_blob` and `read_blob`. Operator dispatch remains adapter-private. | Keep these route names private. Tenant/session context may be derived only after edge capability verification and is not a credential. |
| CAS public edge | Cloudflare CAS already serves the six `/tenants/{tenantId}/cas/*` operations with the current raw bodies and headers. Azure Gateway exposes them only when `CAS_BASE_URL` is configured; otherwise its allowlist rejects them with `404`. | Preserve the six-operation allowlist and existing runtime availability. Replace only service authentication. |
| CAS private edge | Cloudflare CAS still serves tenant-less `/_internal/root-refs`, `root-assignments`, and `nodes/{hash}` routes and receives tenant context through `X-Tenant-Id`. | Move these operations to `/tenants/{tenantId}/_internal/*`, compare the path to the signed claim, and stop accepting `X-Tenant-Id` as edge authority. |

All Cloudflare Markdown, DOCX, and PSD workers use the shared Doc edge. Azure
Markdown and DOCX use the same shared handler; there is no Azure PSD service.
The migration preserves their existing multipart/empty create handling,
JSON/SValue negotiation, raw export and IR bytes, unsupported operator results,
and service-specific error/status behavior. It does not normalize these
differences.

#### Complete `http-protocol` export migration inventory

| Existing export | Final owner | Post-P0 state |
|-----------------|-------------|---------------|
| `HistoryEntry`, `ApplyResult`, `RollbackResult`, `CreateResult` | `@unidocs/protocol-doc` | Copied, but not fully adopted. The copied `CreateResult.docId` does not model the active private Doc create result `{ sessionId, version }`; the explicit public and private create responses must be separated. |
| `VersionConflictError`, `DeltaRejectedError`, `DocNotFoundError`, `DocExistsError`, `StorageCorruptError`, `RootRefsError` | `@unidocs/protocol-doc` | Copied, but Doc and SDK consumers still import the old package. |
| `BinaryQueryValue`, `EscapedQueryObject`, `WireQueryValue`, `encodeQueryValue` | No destination; delete after callers use the completed SValue response framing | Still used by `doctype-server-common`; this is migration work, not a compatibility API to preserve. |
| `CasHash`, `CasNode`, `CasNodeDescriptor`, `CasNodeMetadata`, `CasNodeState`, `CasLeaseResult`, `CasReferences`, `CasRefChanges`, `CasRootRefUpdate`, `CasRootAssignment`, `CasAssignRootsRequest`, `CasUsage`, `CasGcResult`, `TenantCasService` | `@unidocs/protocol-cas` | Copied, but CAS runtime and client consumers still import the old package. |
| `isPublicCasRoute` | `@unidocs/protocol-cas` | A tenant-aware implementation exists; Gateway and Cloudflare CAS still import the legacy `/users/*` matcher. |
| `HttpFetcher`, `CasClientConfig`, `CasClientError` | `@unidocs/cas-client` | Not moved. The client must own and export these symbols before `http-protocol` can be deleted. |

The source consumers that currently prevent deletion are:

| Package | Remaining dependency |
|---------|----------------------|
| `gateway-common` | `HttpFetcher` |
| `cloudflare-gateway`, `azure-gateway` | legacy `isPublicCasRoute` |
| `cloudflare-cas` | CAS domain types and legacy route re-export |
| `cas-client` | CAS root update and all three client/transport symbols |
| `doctype-server-common` | Doc errors/results, CAS metadata, and obsolete query-wire encoding |
| `azure-sdk`, `cloudflare-sdk` | Doc errors and history/results |
| `doctype-psd` | stale package-manifest dependency; no source import |

Generated `dist` and `tsconfig.tsbuildinfo` references are not migration
sources and will be regenerated after the source and manifest dependencies are
removed.

#### Final identity and storage decisions

- Gateway directory APIs and physical uniqueness move from `(userId, docId)`
      to `(tenantId, docId)`. The immutable routing identity is
      `{ tenantId, docId, docType, serviceId, sessionId }`; lifecycle,
      idempotency, and timestamps remain Gateway-owned metadata. `userId` is not
      persisted as a routing or storage key.
- The current `GatewayDocumentDirectory` and its memory, D1, and Postgres
      adapters are still user-keyed and must migrate together. The provisional
      `protocol-gateway` directory interface is not a replacement for this
      lifecycle-aware port.
- A Doc logical identity is `(tenantId, sessionId)` under the deployment-bound
      `docType`. Cloudflare Durable Object names must use a canonical
      length-prefixed encoding of both IDs inside the doctype namespace. Azure
      session, delta, snapshot, cache, idempotency, foreign-key, and uniqueness
      predicates include tenant, configured doctype, and session.
- CAS node identity remains `(tenantId, hash)` in routes, Durable Objects, D1,
      R2, idempotency, usage, and GC. Session identity constrains root mutations;
      it never becomes part of an immutable node key.
- `DOC_SERVICES_JSON` remains the deployment registration source for
      `{ docType, serviceId, url }`. Its current per-service `accessKey` is replaced
      by the configured Doc audience and Gateway signer policy; validators receive
      issuer/JWKS configuration separately.

#### Frozen operation deadlines and issued lifetimes

Gateway issues every Doc token and paired delegated CAS capability with a
120-second TTL immediately before the first downstream attempt. Both tokens
share the operation start time; the delegated token must not expire after the
Doc token. The request deadline below is measured from issuance through the
final downstream CAS response.

| Post-P0 Doc operation | End-to-end deadline | Issued TTL | Required enforcement |
|-----------------------|--------------------:|-----------:|----------------------|
| `GET .../status` | 15 seconds | 120 seconds | No CAS capability; bound directory reconciliation and the Doc status request. |
| `GET .../history`, `GET .../ir`, `POST .../reset` | 30 seconds | 120 seconds | No CAS capability; reject an unexpected delegated token. |
| `POST .../query`, `GET .../export` | 60 seconds | 120 seconds | Propagate one request abort signal through all permitted CAS reads. |
| `GET .../snapshot`, `POST .../init-from-hash` | 60 seconds | 120 seconds | Propagate the deadline through the final CAS write/root update. |
| `PUT .../sessions/{sessionId}` create | 90 seconds | 120 seconds | Bound multipart parsing, import, storage, and all CAS writes; a timeout leaves Gateway reconciliation metadata, not an unbounded worker. |
| `POST .../apply`, `POST .../rollback` | 90 seconds | 120 seconds | Bound document work and all CAS reads/writes under the same signal. |
| `POST .../run` | 90 seconds | 120 seconds | The existing 10/25 iteration caps remain, but every LLM, Editor, and CAS call must also receive the request deadline. Do not start another iteration or CAS call after expiry. |

Every row satisfies `deadline + 30 seconds <= 120 seconds`. A timeout is a
bounded request failure; Doc never refreshes a token, continues in a queue, or
calls Gateway. Existing payload limits and operation semantics remain
unchanged. If production evidence shows an operation cannot finish inside its
assigned deadline, that operation must be bounded further or designed as a
separate workload identity before rollout; increasing the shared TTL is not a
valid migration shortcut.

#### Current shared-key call graph and removal surfaces

1. Gateway resolves the public user/tenant and directory record. For Doc it
       sends `X-Internal-Token: SERVICE_ACCESS_KEY` plus derived `X-Tenant-Id`,
       `X-Doc-Type`, and `X-Session-Id`. For CAS it sends
       `X-Internal-Token: CAS_ACCESS_KEY` plus `X-Tenant-Id`.
2. `doctype-server-common/src/doc-type-handler.ts` compares the Doc token to
       its configured service access key before private adapter dispatch. Derived
       context headers are then consumed by Cloudflare Editor/Operator objects or
       Azure local-editor storage adapters.
3. Cloudflare `editor-do-svalue.ts` and Azure `doc-type-service.ts` construct
       `CasClient` with `CAS_ACCESS_KEY`. The client sends `X-Internal-Token` and
       `X-Tenant-Id` to the Cloudflare CAS worker, including tenant-less private
       root routes.
4. `cloudflare-cas/src/worker.ts` compares `X-Internal-Token` with
       `CAS_ACCESS_KEY` and accepts `X-Tenant-Id` as edge context before Durable
       Object dispatch.

Active removal surfaces are Gateway/Doc/CAS source and tests, `cas-client`,
`scripts/doc-types.mjs`, both local runtime harnesses, all Doc/CAS/Gateway
Wrangler files, service `azure.service.json` files,
`azure/deploy/container-app.bicep`, `azure/deploy/deploy.mjs`, and the Azure
local runtime. `SERVICE_ACCESS_KEY`, `CAS_ACCESS_KEY`, and
`X-Internal-Token` are the active names; `INTERNAL_TOKEN` itself is now only a
test variable or historical/generated term. Derived tenant/session/type
headers may remain behind an authenticated adapter boundary, but no service
edge may accept them as credentials or allow them to override signed claims.

#### Captured protocol baseline

At `012957b`, before further implementation edits:

```text
pnpm --filter @unidocs/protocol-cas test          # 12 passed
pnpm --filter @unidocs/protocol-doc test          # 25 passed
pnpm --filter @unidocs/protocol-gateway test      # 19 passed
pnpm --filter @unidocs/protocol-cas typecheck     # passed
pnpm --filter @unidocs/protocol-doc typecheck     # passed
pnpm --filter @unidocs/protocol-gateway typecheck # passed
```

The post-P0 service and integration baseline at the same commit is:

```text
pnpm --filter @unidocs/gateway-common test          # 14 passed
pnpm --filter @unidocs/cloudflare-gateway test      # 3 passed
pnpm --filter @unidocs/azure-gateway typecheck      # passed
pnpm --filter @unidocs/doctype-server-common test   # 64 passed
pnpm --filter @unidocs/cloudflare-markdown test     # passed
pnpm --filter @unidocs/cloudflare-docx test         # passed
pnpm --filter @unidocs/cloudflare-psd test           # 2 passed
pnpm --filter @unidocs/azure-sdk test                # 49 passed
pnpm --filter @unidocs/cloudflare-cas test           # 39 passed
pnpm --filter @unidocs/cas-server-common test        # 66 passed
pnpm --filter @unidocs/cas-client test               # 18 passed
pnpm test:local                                      # 269 passed, 2 skipped
pnpm test:azure                                      # 15 passed
```

The Azure baseline successfully started and cleaned up its local Postgres and
Azurite prerequisites. The two local skips are pre-existing conditional cases,
not failures.

### Task 1: Split the HTTP protocol by owning service

- [x] Create `@unidocs/protocol-cas`, `@unidocs/protocol-doc`, and
      `@unidocs/protocol-gateway` with the dependency direction specified
      above. Do not introduce a fourth catch-all HTTP protocol package.
- [x] Move the current CAS domain/wire types, client-independent constants, and
      `isPublicCasRoute` to `protocol-cas`. Change only its user path parameter
      to `tenantId` and add the tenant prefix to current internal route builders.
- [x] Move history types, Doc errors, SValue media constants, and the complete
      current Doc route set to `protocol-doc`. Do not move the legacy
      `QueryValue`/`WireQueryValue`/`encodeQueryValue` layer: query data is
      `SValue`, as required by the completed SValue protocol plan.
- [x] Move document directory/list records and Gateway public route definitions
      to `protocol-gateway`; use aliases to Doc/CAS body types for pass-through
      operations instead of copying structures.
- [x] Define the explicit `GatewayXxxRequest`/`GatewayXxxResponse`,
      `DocXxxRequest`/`DocXxxResponse`, and
      `CasXxxRequest`/`CasXxxResponse` pair named in every comparison-table row.
      Request types describe path/query/headers/body separately; response types
      preserve current JSON fields, raw bytes, media types, and response headers.
- [x] Preserve generics for doctype-specific `TQuery` and `TOp` and
      preserve the current JSON/SValue alternatives. Do not normalize Cloudflare
      and Azure framing as part of the package move.
- [x] Move `HttpFetcher`, `CasClientConfig`, and `CasClientError` to the owning
      CAS client/transport package. Keep shared document/SValue domain types in
      `@unidocs/protocol`.
- [x] Migrate consumers package by package, then delete
      `@unidocs/http-protocol`; do not keep a broad compatibility barrel after
      every consumer has moved.
- [x] Add table-driven tests proving each current and tenant-aware route maps to
      the expected endpoint type pair and that methods, operation names, query
      parameters, headers, and media framing did not change accidentally.

**Focused validation:**

```text
pnpm --filter @unidocs/protocol-cas test
pnpm --filter @unidocs/protocol-doc test
pnpm --filter @unidocs/protocol-gateway test
pnpm --filter @unidocs/protocol-cas typecheck
pnpm --filter @unidocs/protocol-doc typecheck
pnpm --filter @unidocs/protocol-gateway typecheck
```

Implementation record (2026-08-26):

- Added typed `CasEndpointContracts`, `DocEndpointContracts`,
      `DocPrivateEndpointContracts`, and `GatewayEndpointContracts` maps so every
      matched operation names its request and response pair.
- Corrected the provisional Doc contract to the post-P0
      `/tenants/{tenantId}/sessions/{sessionId}` edge with `PUT` create,
      `init-from-hash`, and status. Gateway keeps public `docId` DTOs separate from
      Doc's private `sessionId` results.
- Moved CAS client transport/config/error ownership, migrated every source,
      test, manifest, TypeScript reference, and bundler alias, removed the obsolete
      query-value escape layer, and deleted `@unidocs/http-protocol` without a
      compatibility barrel.
- Focused results: protocol CAS 13 passed, Doc 28 passed, Gateway 31 passed;
      all three typechecks passed. `pnpm typecheck` passed all 24 projects,
      `pnpm build` passed, `pnpm test:local` passed 264 with 2 conditional skips,
      and `pnpm test:azure` passed with Postgres/Azurite cleanup.

### Task 2: Add the cloud-neutral capability protocol package

- [x] Create `@unidocs/service-auth` (or the final equivalent chosen in Task 0)
      with no Cloudflare/Azure imports.
- [x] Add `jose` as the JOSE implementation; do not hand-roll JWS parsing,
      DER/raw ECDSA conversion, base64url, or claim serialization.
- [x] Define versioned claims and typed verified-capability results. Reject
      unknown versions and malformed or duplicate semantic fields.
- [x] Add canonical permission builders and exact-match checks for all CAS and
      session permissions. Encode resource segments centrally; prohibit raw
      interpolation at call sites.
- [x] Implement an issuer interface that accepts an injected signer/current
      time and always sets the fixed protected headers and registered claims.
- [x] Implement a verifier configured with fixed issuer, audience, algorithm,
      max lifetime, clock skew, and an in-memory JWKS. It must not perform
      network key discovery.
- [x] Define typed errors that service edges consistently map to `401` or
      `403`, without echoing token contents.

Tests must cover:

- valid issuance/verification and multiple trusted `kid` values;
- tampered header, payload, and signature;
- wrong `typ`, algorithm, issuer, audience, version, and `kid`;
- missing claims, wrong claim types, expired/not-yet-valid tokens, excessive
  lifetime, and clock-skew boundaries;
- exact permission matching across tenant/session IDs, including IDs with
  characters that require encoding;
- rejection of multi-audience tokens and tokens containing disallowed
  permissions.

**Focused validation:**

```text
pnpm --filter @unidocs/service-auth test
pnpm --filter @unidocs/service-auth typecheck
```

Implementation record (2026-08-26):

- Added distinct tenant/session claim variants with required registered claims,
      fixed `ver: 1`, `ES256`, and `typ: "unidocs-cap+jwt"` constants.
- Centralized RFC 3986 permission segment encoding, strict canonical parsing,
      all six permission builders, and exact non-implication checks.
- Added an injected `CapabilitySigner`, a JOSE-backed signer adapter, and an
      issuer with injected clock/JTI generation, 120-second default lifetime, and
      absolute 300-second lifetime/30-second skew limits.
- Added a public-key-only, in-memory local JWKS verifier with fixed
      issuer/audience/algorithm, strict claim/header allowlists, multiple-`kid`
      rotation overlap, typed 401/403 errors, and tenant/session/permission guards.
- `service-auth` has no platform or network key-discovery imports. Its 57 tests
      cover issuance, tampering, wrong trust parameters, malformed/missing claims,
      lifetime/skew boundaries, canonical IDs, multi-audience tokens, permission
      families, resource mismatch, and configuration failures. Package typecheck,
      root `pnpm typecheck`, and root `pnpm build` pass.

### Task 3: Make current Gateway routes tenant-aware and issue token pairs

- [x] Replace `/users/{userId}` with `/tenants/{tenantId}` in the current public
      document and CAS route set. Preserve every current method, suffix, query,
      body, response, and allowlist decision.
- [x] Key directory lookups by `{ tenantId, docId }`; persist immutable
      `{ tenantId, docId, docType, sessionId }` records. Replace `ownerId` as a
      storage/routing identity; user authorization remains Gateway-only.
- [x] For the current create and `init_from_hash` flows, preallocate/resolve the
      private `sessionId`, call the same Doc operation with the existing method
      and body, and preserve the current public `docId` response/route behavior.
- [x] Add a route policy that maps each matched Gateway operation to one Doc
      permission and the minimum delegated CAS permissions from the fixed
      matrix.
- [x] Resolve `tenantId`, `docType`, and `sessionId` only from authenticated
      identity plus the Gateway-owned directory. Never accept these values from
      public internal-style headers.
- [x] Sign a Doc-only token for the configured target service audience.
- [x] When the operation may call CAS, sign a separate CAS-only delegated
      capability with `sub: doc:{docType}` and matching tenant/session claims.
- [x] For `status`, `history`, `ir`, and `reset`, omit the CAS capability and never mint
      unused downstream authority.
- [x] For direct Gateway -> CAS operations, sign a CAS-only token with
      `sub: gateway` and no Doc permissions.
- [x] Replace the legacy five-route CAS proxy allowlist with the target six
      tenant routes, adding GC only behind tenant-admin authorization, and
      replace legacy internal credentials with a CAS capability.
- [x] Build Doc/CAS URLs with the owning protocol package and construct outbound
      requests from per-operation header allowlists. Replace user
      `Authorization`; never append internal credentials to copied headers.
- [x] Import/cache signing key objects at startup rather than reparsing private
      key material per request. Signing remains per authorized operation.
- [x] Add structured audit events containing only decision metadata such as
      `kid`, `jti`, audience, permission, and resource IDs; never log token
      strings or signatures.

Tests must prove current methods/suffixes/framing are unchanged, tenant/document
directory isolation, create/clone routing, and that old `/users/*` paths fail.
They must also prove that Gateway never creates a token
with both Doc and CAS audiences or permissions, never delegates `cas:admin` to
Doc, binds create to one preallocated session, and strips hostile public
auth/internal headers.

**Focused validation:** Gateway common and both runtime adapter suites.

Implementation record (2026-08-26):

- Rebased the capability foundation commit onto the latest `origin/main`
      (`d01afd0`) after the stack layout moved under `stacks/{azure,cloudflare}`;
      restored the in-progress Task 3 work without conflicts.
- Migrated the in-memory, D1, and Postgres Gateway directories from user keys
      to `(tenantId, docId)` and tenant-scoped idempotency. Added collision-safe D1
      and Postgres migrations plus a persistent local D1 migration ledger for
      Miniflare restarts.
- Switched the public Gateway edge and CAS client to `/tenants/{tenantId}`;
      old `/users/*` Gateway routes fail before identity resolution. Gateway keeps
      authenticated `userId` only inside its identity boundary and persists no user
      routing key.
- Added table-driven Doc/CAS capability policy, request deadlines, separated
      Doc/delegated-CAS/direct-CAS issuance, tenant-aware protocol route builders,
      hostile-header stripping, and metadata-only audit events.
- Added explicit `legacy`/`dual`/`capability` Gateway modes with no implicit
      fallback. Cloudflare caches one imported PKCS8 issuer promise per process;
      Azure imports once at startup. Current local and deployment stacks explicitly
      remain in `legacy` mode until Task 4/5 validators and Task 7 rollout are ready,
      while Doc registrations already carry target audiences.
- Focused results: `service-auth` 59 passed, `gateway-common` 44 passed,
      `cloudflare-gateway` 4 passed, CAS client 18 passed, shared Doc 64 passed.
      Root `pnpm typecheck` and `pnpm build` pass; `pnpm test:local` passed 285 with
      2 conditional skips; `pnpm test:azure` passed 15/15 with Postgres/Azurite
      cleanup.

### Task 4: Make every current Doc type tenant-aware and contract-identical

- [x] Drive each doctype service edge from `protocol-doc`'s current route set.
      Remove duplicated route-name sets where practical and add conformance
      tests proving every doctype exposes the same methods and operation suffixes.
- [x] Add authentication middleware at that edge, before session route dispatch
      or request-body parsing.
- [x] Configure each Doc deployment with one exact audience, for example
      `unidocs-doc:docx`.
- [x] Apply the Doc route permission matrix. Compare signed tenant/session
      claims with path parameters and persisted immutable session metadata.
- [x] Replace `DocIdentity`/owner addressing with immutable logical
      `{ tenantId, sessionId }` identity plus the deployment-configured
      `docType` physical partition throughout sessions, indexes, deltas,
      snapshots, unit-of-work records, caches, and idempotency records. The same
      `sessionId` in two tenants or two doctypes must remain isolated and valid.
- [x] For the current multipart/empty create and current `init_from_hash`,
      persist the signed tuple without changing request or response framing.
- [x] On Cloudflare, use a canonical length-prefixed encoding of both IDs for
      Durable Object names inside the doctype-specific namespace. On Azure,
      include tenant, configured doctype, and session columns in every key,
      predicate, foreign key, and uniqueness constraint. Add migration and
      collision test vectors for delimiter-containing identifiers.
- [x] Verify the delegated CAS capability separately with the CAS audience,
      required CAS permissions, matching tenant/session, and an expiry no later
      than the Doc token.
- [x] Reject an unexpected delegated capability on `status`, `history`, `ir`, and
      `reset`, and prevent those paths from constructing a CAS client.
- [x] Keep the delegated token request-local. Do not add it to session
      metadata, snapshots, deltas, caches, retry queues, or exception context.
- [x] Change the CAS client boundary to receive that request-local capability
      plus verified tenant/session context, build the tenant-aware current CAS
      routes, and send the delegated token as CAS `Authorization`.
- [x] Construct CAS requests from minimal headers. Never forward the Doc token,
      cookies, public forwarding headers, or user authorization.
- [x] Make absent verifier configuration and absent credentials fail closed.
- [x] Reject old `/users/*` service-edge routes. Keep adapter-private
      `/_internal/*` operation names, but derive their tenant/session context
      only after capability verification; do not treat context headers as auth.

Tests must prove same-session-id cross-tenant/cross-doctype isolation,
wrong-tenant/session denial, route-level read/write separation, the shared route
and type surface across doctypes, documented existing runtime-specific results,
CAS token mismatch denial, no token persistence, and that the Doc token never
reaches a mock CAS service.

**Focused validation:** shared Doc runtime, CAS client, and Azure/Cloudflare Doc
adapter suites.

Implementation record (2026-08-26):

- Replaced duplicated service-edge dispatch with the shared `protocol-doc`
      matcher. Explicit `legacy`/`dual`/`capability` modes quarantine the old
      `/sessions/*` shared-key edge; tenant routes accept capabilities only, and
      missing mode/trust/credentials fail startup.
- The shared edge verifies the primary Doc token before namespace lookup or
      body parsing, enforces exact route permissions and signed tenant/session,
      verifies delegated CAS subject/audience/resources/permission set separately,
      and rejects delegated expiry after the primary token. No-CAS routes reject
      unexpected delegated authority.
- Added immutable process-level public JWKS caches and exact configured
      audiences for Cloudflare Markdown/DOCX/PSD and Azure Markdown/DOCX. Current
      deployed/local modes remain explicitly `legacy` until Task 5 and Task 7.
- Capability Cloudflare objects use UTF-8 byte-length-prefixed tenant/session
      names; legacy routes retain session-only object names during migration.
      Azure PostgreSQL, snapshot Blob keys, primary keys, uniqueness constraints,
      predicates, and foreign keys now include tenant, configured Doc type, and
      session. The phased migration imports legacy identities before enforcing the
      composite FK schema, and collision/isolation vectors cover delimiters,
      Unicode, equal sessions across tenants, and equal sessions across doctypes.
- CAS clients now accept one request-local delegated capability and emit only
      CAS Bearer authorization on tenant-aware public/private routes. Azure creates
      no CAS client for capability no-CAS operations. Cloudflare Editor clients are
      request-scoped and cleared in `finally`; Operator requests are serialized,
      forward authority only during the active run, and clear it afterward. The
      primary Doc Bearer never reaches Editor or CAS.
- Cloudflare stores canonical delta/snapshot root bytes locally so cold
      `status`/`history`/`ir` paths do not need CAS authority; legacy requests with
      CAS access retain pending-write recovery behavior.
- Focused results: shared Doc 94 passed, CAS client 19 passed, Cloudflare SDK
      13 passed, Azure SDK 50 passed. Root `pnpm typecheck` and `pnpm build` pass;
      `pnpm test:local` passed 285 with 2 conditional skips; `pnpm test:azure`
      passed 15/15 with migrations and infrastructure cleanup.

### Task 5: Make current CAS routes tenant-aware and enforce capabilities

- [x] Dispatch the current `protocol-cas` operation set. Authenticate at the CAS
      service edge before schema work, Durable Object lookup, database access,
      or request-body parsing.
- [x] Require the exact CAS audience and apply the CAS route permission matrix.
- [x] Compare URL `tenantId` with the signed claim for every tenant route.
- [x] Migrate every node, edge, root owner, idempotency, usage, object-store,
      and Durable Object partition key from user identity to tenant identity.
      Prove equal hashes in different tenants remain physically and
      accountant-wise isolated.
- [x] Preserve public raw-content `POST`, `X-CAS-Refs`,
      `X-CAS-Lease-Duration`, and internal portable-node framing. Only replace
      user partitioning with tenant partitioning and legacy auth with Bearer.
- [x] Preserve `CasRootRefUpdate` and `CasAssignRootsRequest` bodies. Require a
      session-scoped capability for both root routes and reject an assignment
      owner that is outside the signed session's existing owner namespace.
- [x] Keep immutable node keys tenant-scoped as `(tenantId, hash)`; do not add
      `sessionId` to physical node keys.
- [x] Require only `cas:admin` for usage/GC/admin routes. Confirm explicitly
      that `admin` alone cannot read or write node content.
- [x] Reject Doc-audience tokens, multi-audience tokens, and any valid token
      whose permission/resource does not match the route.
- [x] Remove trust in identity/context headers from the capability code path and
      reject old `/users/*` and tenant-less internal CAS paths outside the
      explicit migration mode.

Tests must include the confused-deputy cases: a valid Doc token sent to CAS, a
CAS token for another tenant, equal hashes and session IDs across tenants, a
root owner outside the signed session namespace, a session-bound token trying
to change another session's roots, unchanged node hash/content validation, and
`cas:admin` used as implicit read/write.

**Focused validation:** CAS common/runtime suites and tenant-isolation
integration tests.

Implementation record (2026-08-26):

- The CAS edge now dispatches the full `protocol-cas` route set and verifies
      capability credentials before schema migration, body parsing, Durable Object
      lookup, D1, or R2 access. Explicit `legacy`/`dual`/`capability` modes retain
      tenant-less internal routes only inside the quarantined migration mode.
- A cached public-JWKS verifier enforces exact issuer/audience/algorithm,
      route-specific read/write/admin permissions, URL tenant equality, and
      Gateway-vs-Doc subject/session constraints. Tenant-only Gateway admin tokens
      authorize usage/GC only; admin never implies node read/write.
- Tenant-prefixed private portable-node and root routes preserve current body,
      header, and media framing. Root updates require a session-scoped Doc
      capability, and root assignments are constrained to the signed
      `session:{sessionId}:` owner namespace before any storage access.
- Existing P0 physical `(tenantId, hash)` node, edge, root, idempotency, usage,
      R2, D1, DO, and GC partitioning remains unchanged and does not include
      session ID.
- Real ES256 worker tests cover valid read/admin/root operations, wrong tenant,
      Doc-audience confused deputy, multi-audience rejection, admin-as-read denial,
      cross-session root owner denial, pre-storage auth failure, and capability-mode
      rejection of tenant-less legacy paths. The complete route policy covers all
      ten CAS operations.
- Focused results: `cloudflare-cas` 56 passed, shared Doc 94 passed, CAS client
      19 passed, Cloudflare SDK 13 passed, Azure SDK 50 passed. Root
      `pnpm typecheck` and `pnpm build` pass; `pnpm test:local` passed 285 with 2
      conditional skips; `pnpm test:azure` passed 15/15 with migrations and
      infrastructure cleanup.

### Task 6: Add key provisioning, rotation, and runtime configuration

- [x] Keep signing behind an injected `CapabilitySigner` boundary so a runtime
      may use either a secret-backed Web Crypto key or a managed KMS/HSM signer
      without changing authorization policy.
- [x] Gateway startup requires an active private signing key, matching `kid`,
      issuer, TTL, and algorithm. Doc/CAS startup requires a non-empty trusted
      JWKS, issuer, audience, max lifetime, and algorithm.
- [x] Store private material only in the platform secret facility. Do not place
      it in source, images, Bicep outputs, Wrangler vars, command output, or
      deployment history.
- [x] Give Gateway signing access only. Doc/CAS deployment identities must not
      have read or sign access to the private key.
- [x] Add local/test key generation that writes only to ignored runtime state.
      Commit public test fixtures only when deterministic unit tests require
      them; never commit a production-like private key.
- [x] Cache imported private/public key objects for process lifetime. Refresh
      trusted JWKS only through deployment/config reload, not per request.
- [x] Document and test rotation:
            1. deploy/restart every validator with old and new public keys;
            2. wait until every active Cloudflare deployment/Azure revision is healthy
                  and its startup diagnostic reports the new trusted `kid`;
            3. switch Gateway's active `kid` to the new private key;
            4. run a normal-operation probe through every target and monitor
                  unknown-key failures;
            5. wait at least maximum lifetime plus clock skew;
            6. deploy/restart validators without the old public key, then remove the
                  old private key.
- [x] Treat JWKS as immutable process configuration: Cloudflare key changes
            require a Worker deployment and Azure key changes require a new active
            Container App revision/restart. Do not rely on unspecified hot reload.
- [x] Add startup diagnostics that name missing configuration fields but never
      print key material.

Cloudflare and Azure may use different private keys and signer adapters. Their
issuers and JWKS must remain deployment-specific so a token from one
environment is not accepted in another.

**Focused validation:** configuration unit tests, Bicep build, Wrangler dry-run
or equivalent package checks, and local runtime startup with missing/rotated
keys.

Implementation record (2026-08-26):

- Gateway signing remains behind injected `CapabilitySigner` and
      `GatewayCapabilityIssuer` boundaries. PKCS8 import is a runtime adapter;
      Cloudflare caches one authority promise and Azure imports once at process
      startup. Doc/CAS cache public-only local JWKS verifiers for process lifetime.
- Capability mode requires explicit `ES256`, issued TTL, maximum lifetime,
      clock skew, issuer, audiences, active `kid`, and private/JWKS bindings. The
      shared parser enforces `120`/`300`/`30` bounds; startup failures name only the
      missing or invalid field.
- Azure secure Bicep parameters mount `CAPABILITY_PRIVATE_KEY_PKCS8` only into
      Gateway and `CAPABILITY_TRUSTED_JWKS` only into Doc services. The deploy
      runner reads pre-provisioned Key Vault secrets, never accepts private/JWKS
      values on its CLI, and uses redacted command labels. Cloudflare uses secret
      bindings; Wrangler vars contain policy/audience metadata only.
- Added `pnpm keys:local`, which writes an ES256 fixture to ignored
      `.wrangler/capability/` state with mode `0600`, refuses overwrite, and prints
      only path/issuer/`kid`. Tests prove the JWKS has no private `d` member.
- Added `docs/capability-key-operations.md` covering platform ownership,
      immutable deployment config, six-step overlap rotation, the required
      $300+30=330$ second wait, rollback, compromise response, and prohibited key
      destinations. Unit tests prove old/new overlap and retired-key rejection.
- A real local capability-mode runtime starts with old+new public keys and a
      new active private key, completes create/history, and proves only Gateway
      receives private material. Missing fixtures fail before startup.
- Validation: service-auth 61 passed, shared Doc 94 passed, CAS 58 passed,
      local key tests 3 passed, Azure deploy tests 44 passed. All three Azure Bicep
      templates build; Gateway/CAS/Markdown/DOCX/PSD Wrangler dry-runs pass. Root
      `pnpm typecheck` and `pnpm build` pass; `pnpm test:local` passed 291 with 2
      conditional skips; `pnpm test:azure` passed 15/15, with no residual test
      container or network.

### Task 7: Prepare migration without an outage

Repository and local-runtime support is complete:

- [x] Update local development and integration harnesses to issue real test
      capabilities rather than inserting a magic shared token.

Doc and CAS service edges emit token-free authentication events containing
credential kind, route generation, operation, tenant, and capability key/token
identifiers where applicable. In `dual` mode, tenant routes require capabilities
and legacy credentials are confined to explicit private adapters. Cloudflare and
Azure local harnesses default to `dual`, generate real ephemeral ES256 fixtures,
and share a fixture for cross-runtime Azure Doc -> Cloudflare CAS tests. Root
typecheck, build, and package tests pass; `pnpm test:local` passes 312 with 2
conditional skips and `pnpm test:azure` passes 27/27 with clean resource teardown.

#### Deferred production follow-up

- **Phase A:** deploy Doc/CAS validators in explicit `dual` mode, emit
  credential-kind and route-generation metrics, and keep tenant routes strict.
- **Phase B:** switch production Gateway and Doc-to-CAS traffic to capabilities,
  then observe zero legacy authentication/route matches for the required window.
- **Phase C1:** deploy `capability` mode, stop mounting active legacy secrets,
  and retain one controlled rollback window.
- **Phase C2:** close the rollback window, destroy legacy secrets, remove legacy
  routes/config and `dual` mode, and deactivate old revisions.
- Make the final/default production mode `capability`; missing mode or trust
  configuration must continue to fail closed.

Rollback during Phase A/B or C1 is an audited forward deployment of the retained
capability-aware `dual` artifact plus an explicit remount of the retained
legacy secret. Phase C2 begins only after that bounded rollback window closes.
After secret destruction, pre-capability artifacts are intentionally no longer
valid rollback targets; recovery must use a capability-capable release and key
rotation. Do not retain a hidden permanent legacy bypass.

**Deferred production acceptance criteria:** Repository search finds no
service-edge/runtime auth use of
`INTERNAL_TOKEN`, `X-Internal-Token`, `X-User-Id`, or `/users/*`; historical
plans and explicitly private adapter route names may retain those terms as
history/context.
Active Cloudflare and Azure configuration contains no legacy secret/binding,
old revisions are inactive, and direct legacy route/header probes fail at every
Doc/CAS runtime.

### Task 8: Protocol conformance, security integration, and canonical docs

- [x] Add one shared HTTP conformance and authorization behavior suite and run
      it against Gateway, every supported Doc runtime/doctype, and every CAS
      runtime.
- [x] Assert all current methods, operation names, query parameters, request and
      response fields, status behavior, media types, and headers remain intact
      after the tenant/auth and package migrations.
- [x] Cover valid current create/read/write and CAS read/write/admin operations.
- [x] Cover missing, malformed, tampered, expired, future, overlong, wrong-key,
      wrong-issuer, wrong-audience, wrong-permission, wrong-tenant, and
      wrong-session tokens.
- [x] Prove that a Doc token cannot call CAS and a CAS token cannot call Doc.
- [x] Prove that delegated CAS capabilities never contain Doc permissions or
      `cas:admin`, and that Doc tokens never reach CAS.
- [x] Prove that user credentials/cookies/internal-looking public headers never
      reach Doc/CAS.
- [x] Prove equal `docId`, `sessionId`, and CAS hashes in different tenants never
      collide and that no service keys tenant data by user.
- [x] Prove rotation overlap accepts both configured keys and removal rejects
      the retired key after the bounded lifetime.
- [x] Add a focused throughput/latency check for two Gateway signatures plus
      local Doc/CAS verification. Treat external signer throttling or material
      latency as a deployment issue, not a reason to broaden token lifetime or
      cache bearer tokens across operations.
- [x] Update canonical architecture, deployment, operations, and incident
      response documentation and close the repository/local implementation plan.

Deferred production follow-up:

- Inspect active Cloudflare secrets/bindings and Azure Container App revisions,
  environment variables, and secret references.
- Probe every active Doc/CAS runtime with the retired legacy header and require
  `401` while capability-authenticated smoke paths continue to succeed.

Task 8 implementation record (repository/local complete, 2026-08-26):

- Added `tests/integration/shared/authorization-suite.mjs` and backend entry
      points for Cloudflare and Azure. Gateway creates the test documents, then
      the suite probes every current Doc edge directly: Cloudflare Markdown,
      DOCX, and PSD plus Azure Markdown and DOCX. The Cloudflare entry also probes
      the sole current CAS runtime directly. Every Doc combination performs a
      real session-write apply with an exact Doc capability plus delegated CAS
      read/write capability, then reads version 2 with an exact session-read
      capability.
- The Doc matrix accepts an exact session-read capability and rejects missing,
      malformed, byte-tampered, expired, future, overlong, wrong-key,
      wrong-issuer, CAS-audience, wrong-permission, wrong-tenant, wrong-session,
      and legacy credentials with the required `401`/`403` split.
- The CAS matrix performs real capability-authenticated node write/read and
      tenant-admin usage operations, then rejects missing, legacy, Doc-audience,
      admin-as-read, and wrong-tenant credentials. Focused Cloudflare/Azure
      execution passes 33/33. Root typecheck passes; the full local suite passes
      312 with 2 conditional skips, and the full Azure suite passes 27/27 with
      Postgres, Azurite, and child-process cleanup.
- The Cloudflare Doc-to-CAS request boundary test now signs distinct real Doc
      and delegated CAS capabilities, captures the actual CAS fetch, verifies
      that its Bearer has only the expected CAS audience, Doc subject,
      tenant/session, and read/write permissions, and proves the primary Doc
      token plus Doc/admin permissions are absent. Hostile cookies, user IDs,
      legacy credentials, and forwarding headers are injected at the Doc
      boundary and remain absent from the minimal CAS request; Gateway forwarding
      tests provide the matching public-client-to-Doc stripping evidence.
- Cross-runtime collision cases create the same explicit Gateway `docId` and
      idempotency key in two tenants, create the same direct Doc `sessionId` in
      two tenants, advance only tenant A to version 2 while tenant B remains at
      version 1, and upload the same CAS hash independently after proving it is
      initially absent in the second tenant. Focused storage tests additionally
      prove the Gateway owner column is removed, Cloudflare Doc names and Azure
      Postgres/Blob keys use canonical tenant identities, and CAS D1/R2/DO state
      is partitioned by `(tenantId, hash)`, not user identity.
- The Cloudflare runtime rotation test deploys an overlap JWKS and proves both
      old- and new-key Doc capabilities succeed, then deploys immutable new-only
      trust and proves the new token still succeeds while the retired token gets
      `401`. The test models the post-wait configuration transition; production
      operations still enforce the documented $300+30=330$ second wait before
      removing old trust.
- A focused local latency gate warms up and samples 50 complete apply credential
      sequences. Each sample performs two real ES256 Gateway signatures, local
      Doc verification of the primary and delegated capabilities, and CAS
      verification of the delegated capability. It emits p50, p95, and
      operations/second metadata without tokens and fails when local p95 reaches
      100 ms; external signer latency remains a deployment gate.
- Shared HTTP wire conformance now exercises Gateway create/list/status and the
      complete Markdown apply/query/history-range/rollback/snapshot/IR/export
      lifecycle against Cloudflare and Azure, including JSON/SValue framing,
      response field sets, status codes, `Content-Type`, `Content-Disposition`,
      and `X-Doc-Version`. It records rather than normalizes the existing Azure
      16-hex Blob snapshot ID, ignored unsupported export format, JSON negotiated
      responses, and 501 operator behavior versus the Cloudflare CAS hash,
      format validation, SValue responses, and operator reset behavior.
- The real CAS runtime matrix covers full lease/metadata/state fields, lease
      extension, portable canonical-node bytes and media headers, root-ref and
      root-assignment request/response idempotency, complete usage fields, and GC
      body/results. Protocol CAS/Doc/Gateway route suites pass 13/28/31 and retain
      the complete method, operation, path-encoding, and wrong-method matrices.
- Canonical root, microservice, CAS, Azure/Cloudflare deployment, and capability
      operations documentation now describes tenant-aware routes, separated
      Gateway/Doc/CAS capabilities, trust ownership, rotation, verification, and
      incident response. This plan is complete for the agreed repository/local
      scope; production rollout remains a separate deferred activity.
- Deferred production inspection was inaccessible during this phase: Azure CLI
      is authenticated to `Edge-Data-Pipeline-Dev`, but the deployment script's
      target subscription `24c9acbd-c2f5-4ef9-b9a2-486d90208b3e` is not visible;
      the current subscription also returns `AuthorizationFailed` for the
      `Unidocs` resource group, and package-level Wrangler reports that
      Cloudflare is not authenticated. No production inspection or probe is
      claimed by this local-scope closure.

Final validation:

```text
pnpm build
pnpm typecheck
pnpm test
pnpm test:local
```

## Repository/local completion gate

The migration is complete only when all of the following hold:

- Gateway is the only capability issuer and the only service that handles user
  identity/authorization.
- Every capability-mode internal operation is authorized to an explicit tenant;
      every session operation is additionally authorized to one session.
- Gateway -> Doc uses a Doc-only token plus, when needed, a separate CAS-only
  delegated capability.
- Doc never forwards its own token, never persists delegated capabilities, and
  never calls Gateway to validate or refresh them.
- CAS enforces tenant permissions and derives session root ownership from a
  signed session constraint.
- No service accepts a token for another audience, an overlong token, or a
  permission implied by another permission.
- Local capability fixtures deliver private material only to Gateway; Doc/CAS
      receive public JWKS, and capability mode rejects legacy headers.
- Full repository validation and both cloud-focused authorization behavior
  suites pass.

## Deferred production gate

Before a production rollout is called complete:

- execute Task 7 phases A-C2 and close the recorded observation/rollback windows;
- remove `INTERNAL_TOKEN`, `X-Internal-Token`, production `dual` mode, and legacy
      secrets/routes from active configuration and revisions;
- verify private keys exist only in Gateway-controlled secret/signing facilities;
- inspect every active revision and run deployed legacy-header plus capability
      smoke probes on Cloudflare and Azure.