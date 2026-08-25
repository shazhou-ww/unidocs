# Gateway-Issued Internal Capability Authorization Implementation Plan

> **Status:** Deferred. Execute only after
> `docs/superpowers/plans/2026-08-25-p0-microservice-boundaries-working.md`
> has completed every gate and the final Gateway -> Doc -> CAS boundaries have
> landed. Task 0 must rebase and re-audit the final ownership surfaces before
> implementation starts.
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
`/v1` prefix, `status` or delete routes, `HEAD`/`PUT` CAS operations,
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
| Gateway -> Doc | `X-Internal-Token`, `X-User-Id`, `X-Doc-Type`, `X-Doc-Id` | Doc Bearer capability plus optional `X-UniDocs-CAS-Capability`; tenant/session come from matched path and signed claims |
| Gateway -> CAS | `X-Internal-Token`, `X-User-Id` | CAS Bearer capability; path `tenantId` must equal the signed claim |
| Doc -> CAS | `X-Internal-Token`, `X-User-Id` | delegated CAS Bearer capability; path `tenantId` must equal the signed claim |

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

Gateway still allowlist-proxies the current six public CAS operations. Their
tenant-aware routes and canonical types are defined by `protocol-cas` below;
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
| `POST /users/{userId}/` plus `X-Doc-Id` | `POST /tenants/{tenantId}/{sessionId}/` | `DocCreateRequest` / `DocCreateResponse` |
| `POST /users/{userId}/{docId}/query` | `POST /tenants/{tenantId}/{sessionId}/query` | `DocQueryRequest<TQuery>` / `DocQueryResponse` (`data: SValue`) |
| `POST /users/{userId}/{docId}/apply` | `POST /tenants/{tenantId}/{sessionId}/apply` | `DocApplyRequest<TOp>` / `DocApplyResponse` |
| `GET /users/{userId}/{docId}/export?format=` | `GET /tenants/{tenantId}/{sessionId}/export?format=` | `DocExportRequest` / `DocExportResponse` |
| `GET /users/{userId}/{docId}/history?from=&to=` | `GET /tenants/{tenantId}/{sessionId}/history?from=&to=` | `DocHistoryRequest` / `DocHistoryResponse<TOp>` |
| `POST /users/{userId}/{docId}/rollback` | `POST /tenants/{tenantId}/{sessionId}/rollback` | `DocRollbackRequest` / `DocRollbackResponse` |
| `GET /users/{userId}/{docId}/snapshot` | `GET /tenants/{tenantId}/{sessionId}/snapshot` | `DocSnapshotRequest` / `DocSnapshotResponse` |
| `GET /users/{userId}/{docId}/ir` | `GET /tenants/{tenantId}/{sessionId}/ir` | `DocIrRequest` / `DocIrResponse` |
| `POST /users/{userId}/{docId}/init_from_hash` | `POST /tenants/{tenantId}/{sessionId}/init_from_hash` | `DocInitFromHashRequest` / `DocInitFromHashResponse` |
| `POST /users/{userId}/{docId}/run` | `POST /tenants/{tenantId}/{sessionId}/run` | `DocRunOperatorRequest` / `DocRunOperatorResponse` |
| `POST /users/{userId}/{docId}/reset` | `POST /tenants/{tenantId}/{sessionId}/reset` | `DocResetOperatorRequest` / `DocResetOperatorResponse` |

The adapter-private Editor routes remain `/_internal/create`, `query`, `apply`,
`export`, `history`, `rollback`, `snapshot`, `ir`, and `init_from_hash`; they
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

Public CAS changes only `/users/{userId}` to `/tenants/{tenantId}`. Internal
CAS routes gain the same tenant prefix so CAS can compare the path with the
signed claim; their `/_internal/*` suffixes, methods, headers other than auth,
bodies, and responses stay unchanged.

| Current CAS route | Tenant-aware CAS route | Request/response types |
|-------------------|------------------------|------------------------|
| `GET /users/{userId}/cas/nodes/{hash}/content` | `GET /tenants/{tenantId}/cas/nodes/{hash}/content` | `CasReadContentRequest` / `CasReadContentResponse` |
| `GET /users/{userId}/cas/nodes/{hash}/metadata` | `GET /tenants/{tenantId}/cas/nodes/{hash}/metadata` | `CasReadMetadataRequest` / `CasReadMetadataResponse` |
| `POST /users/{userId}/cas/nodes/{hash}` | `POST /tenants/{tenantId}/cas/nodes/{hash}` | `CasLeaseNodeRequest` / `CasLeaseNodeResponse` |
| `POST /users/{userId}/cas/nodes/{hash}/lease` | `POST /tenants/{tenantId}/cas/nodes/{hash}/lease` | `CasLeaseExistingRequest` / `CasLeaseExistingResponse` |
| `GET /users/{userId}/cas/usage` | `GET /tenants/{tenantId}/cas/usage` | `CasUsageRequest` / `CasUsageResponse` |
| `POST /users/{userId}/cas/gc` | `POST /tenants/{tenantId}/cas/gc` | `CasGcRequest` / `CasGcResponse` |
| `POST /_internal/root-refs` plus `X-User-Id` | `POST /tenants/{tenantId}/_internal/root-refs` | `CasRootRefsRequest` / `CasRootRefsResponse` |
| `POST /_internal/root-assignments` plus `X-User-Id` | `POST /tenants/{tenantId}/_internal/root-assignments` | `CasRootAssignmentsRequest` / `CasRootAssignmentsResponse` |
| `GET /_internal/nodes/{hash}` plus `X-User-Id` | `GET /tenants/{tenantId}/_internal/nodes/{hash}` | `CasReadPortableNodeRequest` / `CasReadPortableNodeResponse` |
| `POST /_internal/nodes/{hash}` plus `X-User-Id` | `POST /tenants/{tenantId}/_internal/nodes/{hash}` | `CasLeasePortableNodeRequest` / `CasLeasePortableNodeResponse` |

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
      | { success: true; version: number; hash: string; docType: string; docId: string }
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
                        created_at: number;
                        updated_at: number;
                  }>;
                  count: number;
            }
      | GatewayErrorResponse;

interface GatewayCreateDocumentRequest {
      path: GatewayDocumentCollectionPath;
      body: DocCreateRequest["body"];
}
type GatewayCreateDocumentResponse = DocCreateResponse;

interface GatewayQueryDocumentRequest<TQuery extends SValue = SValue> {
      path: GatewayDocumentPath;
      body: TQuery;
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
type GatewayInitFromHashResponse = DocInitFromHashResponse;

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
| `POST /tenants/{tenantId}/{sessionId}/` | tenant `sessions:create`, constrained to signed `sessionId` | `cas:write` |
| `POST .../query`; `GET .../export` | session `read` | `cas:read` |
| `GET .../history`; `GET .../ir` | session `read` | none |
| `GET .../snapshot` | session `read` | `cas:write` |
| `POST .../apply`; `POST .../rollback`; `POST .../run` | session `write` | `cas:read` + `cas:write` |
| `POST .../init_from_hash` | session `write` | `cas:write` |
| `POST .../reset` | session `write` | none |

This is the union of current doctype behavior. Markdown/docx may use less, but
PSD query/export can materialize SBlobs from CAS, create can store SBlobs,
snapshot/init can update roots, and apply/rollback/run can do both. Route policy
stays identical for every doctype rather than deriving authority from a
caller-selected type-specific shortcut.

For a `none` route, Gateway omits `X-UniDocs-CAS-Capability`; Doc rejects an
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

## Expected ownership map

Task 0 must replace provisional filenames with final paths after the P0
refactor. The ownership boundaries and single-source rules are normative.

| Surface | Expected responsibility |
|---------|-------------------------|
| `packages/protocol-cas/` | CAS routes, `CasXxxRequest`/`CasXxxResponse` wire types, CAS domain types, media/header constants, and public-route allowlist |
| `packages/protocol-doc/` | Doc routes, `DocXxxRequest`/`DocXxxResponse` wire types, history types, and SValue media/header constants |
| `packages/protocol-gateway/` | Gateway routes, `GatewayXxxRequest`/`GatewayXxxResponse` wire types, directory/list DTOs, and pass-through aliases to Doc/CAS payloads |
| `packages/service-auth/` | Claims schema, canonical permission helpers, issuer/verifier, typed failures |
| `packages/gateway-common/` | Tenant-aware Gateway dispatch, directory resolution, route-to-capability policy, and cloud-neutral downstream request construction |
| `packages/cloudflare-gateway/` | Cloudflare signing-key adapter and configuration |
| `packages/azure-gateway/` | Azure signing-key adapter and configuration |
| `packages/doctype-server-common/` | Shared current Doc route set, tenant/session identity, audience/permission enforcement, and CAS delegation used by every doctype |
| Doctype runtime packages | Bind a configured `DocumentType` and platform storage to the shared Doc contract; preserve documented runtime-specific framing/unsupported results |
| CAS common/edge package(s) | Current CAS operations with tenant storage identity and capability/resource enforcement |
| `packages/cas-client/` | Build tenant-aware current CAS routes, preserve existing framing, accept a request-local delegated capability, and emit CAS-only `Authorization` |
| `scripts/` | Local key fixture/configuration and migration wiring |
| `infra/` and Wrangler configuration | Secret/JWKS distribution and rotation |

---

### Task 0: Rebase after P0 and freeze the final protocol surfaces

- [ ] Rebase this branch onto the commit that completes the P0
      microservice-boundary plan. Do not start from an intermediate P0 state.
- [ ] Verify the current-to-tenant route tables above against every Gateway,
      Doc, and CAS implementation after the rebase. Include both cloud runtimes,
      every doctype, and private adapter routes; record differences rather than
      silently redesigning them.
- [ ] Freeze the current methods, operation names, query parameters, request
      and response bodies, headers, media types, status behavior, and runtime
      differences. Only tenant identity and capability authentication may
      change in this plan.
- [ ] Record every existing `@unidocs/http-protocol` export and its destination
      in `protocol-cas`, `protocol-doc`, `protocol-gateway`, or a client package.
      No compatibility export may remain ownerless.
- [ ] Confirm the final Gateway directory interface and immutable
      `{ tenantId, docId, docType, sessionId }` record, Doc tenant/session
      storage keys, CAS tenant keys/root owner model, and deployment
      registrations.
- [ ] Assign every Doc route an end-to-end operation deadline and issued TTL
      satisfying `deadline + 30 seconds <= TTL <= 300 seconds`. Resolve any
      route that cannot fit without introducing Doc -> Gateway.
- [ ] Replace the provisional ownership map above with exact final files and
      package names.
- [ ] Record the current `INTERNAL_TOKEN` call graph and all startup/deployment
      configuration that must be removed.
- [ ] Capture the focused baseline for Gateway, Doc, CAS, CAS client, local
      runtime, and Azure/Cloudflare integration suites.

**Gate:** No implementation edit is made until the P0 completion commit, the
verified current-to-tenant route inventory, complete type-move inventory, and
the final ownership table are recorded here.

### Task 1: Split the HTTP protocol by owning service

- [ ] Create `@unidocs/protocol-cas`, `@unidocs/protocol-doc`, and
      `@unidocs/protocol-gateway` with the dependency direction specified
      above. Do not introduce a fourth catch-all HTTP protocol package.
- [ ] Move the current CAS domain/wire types, client-independent constants, and
      `isPublicCasRoute` to `protocol-cas`. Change only its user path parameter
      to `tenantId` and add the tenant prefix to current internal route builders.
- [ ] Move history types, Doc errors, SValue media constants, and the complete
      current Doc route set to `protocol-doc`. Do not move the legacy
      `QueryValue`/`WireQueryValue`/`encodeQueryValue` layer: query data is
      `SValue`, as required by the completed SValue protocol plan.
- [ ] Move document directory/list records and Gateway public route definitions
      to `protocol-gateway`; use aliases to Doc/CAS body types for pass-through
      operations instead of copying structures.
- [ ] Define the explicit `GatewayXxxRequest`/`GatewayXxxResponse`,
      `DocXxxRequest`/`DocXxxResponse`, and
      `CasXxxRequest`/`CasXxxResponse` pair named in every comparison-table row.
      Request types describe path/query/headers/body separately; response types
      preserve current JSON fields, raw bytes, media types, and response headers.
- [ ] Preserve generics for doctype-specific `TQuery` and `TOp` and
      preserve the current JSON/SValue alternatives. Do not normalize Cloudflare
      and Azure framing as part of the package move.
- [ ] Move `HttpFetcher`, `CasClientConfig`, and `CasClientError` to the owning
      CAS client/transport package. Keep shared document/SValue domain types in
      `@unidocs/protocol`.
- [ ] Migrate consumers package by package, then delete
      `@unidocs/http-protocol`; do not keep a broad compatibility barrel after
      every consumer has moved.
- [ ] Add table-driven tests proving each current and tenant-aware route maps to
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

### Task 2: Add the cloud-neutral capability protocol package

- [ ] Create `@unidocs/service-auth` (or the final equivalent chosen in Task 0)
      with no Cloudflare/Azure imports.
- [ ] Add `jose` as the JOSE implementation; do not hand-roll JWS parsing,
      DER/raw ECDSA conversion, base64url, or claim serialization.
- [ ] Define versioned claims and typed verified-capability results. Reject
      unknown versions and malformed or duplicate semantic fields.
- [ ] Add canonical permission builders and exact-match checks for all CAS and
      session permissions. Encode resource segments centrally; prohibit raw
      interpolation at call sites.
- [ ] Implement an issuer interface that accepts an injected signer/current
      time and always sets the fixed protected headers and registered claims.
- [ ] Implement a verifier configured with fixed issuer, audience, algorithm,
      max lifetime, clock skew, and an in-memory JWKS. It must not perform
      network key discovery.
- [ ] Define typed errors that service edges consistently map to `401` or
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

### Task 3: Make current Gateway routes tenant-aware and issue token pairs

- [ ] Replace `/users/{userId}` with `/tenants/{tenantId}` in the current public
      document and CAS route set. Preserve every current method, suffix, query,
      body, response, and allowlist decision.
- [ ] Key directory lookups by `{ tenantId, docId }`; persist immutable
      `{ tenantId, docId, docType, sessionId }` records. Replace `ownerId` as a
      storage/routing identity; user authorization remains Gateway-only.
- [ ] For the current create and `init_from_hash` flows, preallocate/resolve the
      private `sessionId`, call the same Doc operation with the existing method
      and body, and preserve the current public `docId` response/route behavior.
- [ ] Add a route policy that maps each matched Gateway operation to one Doc
      permission and the minimum delegated CAS permissions from the fixed
      matrix.
- [ ] Resolve `tenantId`, `docType`, and `sessionId` only from authenticated
      identity plus the Gateway-owned directory. Never accept these values from
      public internal-style headers.
- [ ] Sign a Doc-only token for the configured target service audience.
- [ ] When the operation may call CAS, sign a separate CAS-only delegated
      capability with `sub: doc:{docType}` and matching tenant/session claims.
- [ ] For `history`, `ir`, and `reset`, omit the CAS capability and never mint
      unused downstream authority.
- [ ] For direct Gateway -> CAS operations, sign a CAS-only token with
      `sub: gateway` and no Doc permissions.
- [ ] Keep the current six-route CAS proxy allowlist. Replace only its user path
      with tenant and its legacy internal credentials with a CAS capability.
- [ ] Build Doc/CAS URLs with the owning protocol package and construct outbound
      requests from per-operation header allowlists. Replace user
      `Authorization`; never append internal credentials to copied headers.
- [ ] Import/cache signing key objects at startup rather than reparsing private
      key material per request. Signing remains per authorized operation.
- [ ] Add structured audit events containing only decision metadata such as
      `kid`, `jti`, audience, permission, and resource IDs; never log token
      strings or signatures.

Tests must prove current methods/suffixes/framing are unchanged, tenant/document
directory isolation, create/clone routing, and that old `/users/*` paths fail.
They must also prove that Gateway never creates a token
with both Doc and CAS audiences or permissions, never delegates `cas:admin` to
Doc, binds create to one preallocated session, and strips hostile public
auth/internal headers.

**Focused validation:** Gateway common and both runtime adapter suites.

### Task 4: Make every current Doc type tenant-aware and contract-identical

- [ ] Drive each doctype service edge from `protocol-doc`'s current route set.
      Remove duplicated route-name sets where practical and add conformance
      tests proving every doctype exposes the same methods and operation suffixes.
- [ ] Add authentication middleware at that edge, before session route dispatch
      or request-body parsing.
- [ ] Configure each Doc deployment with one exact audience, for example
      `unidocs-doc:docx`.
- [ ] Apply the Doc route permission matrix. Compare signed tenant/session
      claims with path parameters and persisted immutable session metadata.
- [ ] Replace `DocIdentity`/owner addressing with immutable logical
      `{ tenantId, sessionId }` identity plus the deployment-configured
      `docType` physical partition throughout sessions, indexes, deltas,
      snapshots, unit-of-work records, caches, and idempotency records. The same
      `sessionId` in two tenants or two doctypes must remain isolated and valid.
- [ ] For the current multipart/empty create and current `init_from_hash`,
      persist the signed tuple without changing request or response framing.
- [ ] On Cloudflare, use a canonical length-prefixed encoding of both IDs for
      Durable Object names inside the doctype-specific namespace. On Azure,
      include tenant, configured doctype, and session columns in every key,
      predicate, foreign key, and uniqueness constraint. Add migration and
      collision test vectors for delimiter-containing identifiers.
- [ ] Verify the delegated CAS capability separately with the CAS audience,
      required CAS permissions, matching tenant/session, and an expiry no later
      than the Doc token.
- [ ] Reject an unexpected delegated capability on `history`, `ir`, and
      `reset`, and prevent those paths from constructing a CAS client.
- [ ] Keep the delegated token request-local. Do not add it to session
      metadata, snapshots, deltas, caches, retry queues, or exception context.
- [ ] Change the CAS client boundary to receive that request-local capability
      plus verified tenant/session context, build the tenant-aware current CAS
      routes, and send the delegated token as CAS `Authorization`.
- [ ] Construct CAS requests from minimal headers. Never forward the Doc token,
      cookies, public forwarding headers, or user authorization.
- [ ] Make absent verifier configuration and absent credentials fail closed.
- [ ] Reject old `/users/*` service-edge routes. Keep adapter-private
      `/_internal/*` operation names, but derive their tenant/session context
      only after capability verification; do not treat context headers as auth.

Tests must prove same-session-id cross-tenant/cross-doctype isolation,
wrong-tenant/session denial, route-level read/write separation, the shared route
and type surface across doctypes, documented existing runtime-specific results,
CAS token mismatch denial, no token persistence, and that the Doc token never
reaches a mock CAS service.

**Focused validation:** shared Doc runtime, CAS client, and Azure/Cloudflare Doc
adapter suites.

### Task 5: Make current CAS routes tenant-aware and enforce capabilities

- [ ] Dispatch the current `protocol-cas` operation set. Authenticate at the CAS
      service edge before schema work, Durable Object lookup, database access,
      or request-body parsing.
- [ ] Require the exact CAS audience and apply the CAS route permission matrix.
- [ ] Compare URL `tenantId` with the signed claim for every tenant route.
- [ ] Migrate every node, edge, root owner, idempotency, usage, object-store,
      and Durable Object partition key from user identity to tenant identity.
      Prove equal hashes in different tenants remain physically and
      accountant-wise isolated.
- [ ] Preserve public raw-content `POST`, `X-CAS-Refs`,
      `X-CAS-Lease-Duration`, and internal portable-node framing. Only replace
      user partitioning with tenant partitioning and legacy auth with Bearer.
- [ ] Preserve `CasRootRefUpdate` and `CasAssignRootsRequest` bodies. Require a
      session-scoped capability for both root routes and reject an assignment
      owner that is outside the signed session's existing owner namespace.
- [ ] Keep immutable node keys tenant-scoped as `(tenantId, hash)`; do not add
      `sessionId` to physical node keys.
- [ ] Require only `cas:admin` for usage/GC/admin routes. Confirm explicitly
      that `admin` alone cannot read or write node content.
- [ ] Reject Doc-audience tokens, multi-audience tokens, and any valid token
      whose permission/resource does not match the route.
- [ ] Remove trust in identity/context headers from the capability code path and
      reject old `/users/*` and tenant-less internal CAS paths outside the
      explicit migration mode.

Tests must include the confused-deputy cases: a valid Doc token sent to CAS, a
CAS token for another tenant, equal hashes and session IDs across tenants, a
root owner outside the signed session namespace, a session-bound token trying
to change another session's roots, unchanged node hash/content validation, and
`cas:admin` used as implicit read/write.

**Focused validation:** CAS common/runtime suites and tenant-isolation
integration tests.

### Task 6: Add key provisioning, rotation, and runtime configuration

- [ ] Keep signing behind an injected `CapabilitySigner` boundary so a runtime
      may use either a secret-backed Web Crypto key or a managed KMS/HSM signer
      without changing authorization policy.
- [ ] Gateway startup requires an active private signing key, matching `kid`,
      issuer, TTL, and algorithm. Doc/CAS startup requires a non-empty trusted
      JWKS, issuer, audience, max lifetime, and algorithm.
- [ ] Store private material only in the platform secret facility. Do not place
      it in source, images, Bicep outputs, Wrangler vars, command output, or
      deployment history.
- [ ] Give Gateway signing access only. Doc/CAS deployment identities must not
      have read or sign access to the private key.
- [ ] Add local/test key generation that writes only to ignored runtime state.
      Commit public test fixtures only when deterministic unit tests require
      them; never commit a production-like private key.
- [ ] Cache imported private/public key objects for process lifetime. Refresh
      trusted JWKS only through deployment/config reload, not per request.
- [ ] Document and test rotation:
            1. deploy/restart every validator with old and new public keys;
            2. wait until every active Cloudflare deployment/Azure revision is healthy
                  and its startup diagnostic reports the new trusted `kid`;
            3. switch Gateway's active `kid` to the new private key;
            4. run a normal-operation probe through every target and monitor
                  unknown-key failures;
            5. wait at least maximum lifetime plus clock skew;
            6. deploy/restart validators without the old public key, then remove the
                  old private key.
- [ ] Treat JWKS as immutable process configuration: Cloudflare key changes
            require a Worker deployment and Azure key changes require a new active
            Container App revision/restart. Do not rely on unspecified hot reload.
- [ ] Add startup diagnostics that name missing configuration fields but never
      print key material.

Cloudflare and Azure may use different private keys and signer adapters. Their
issuers and JWKS must remain deployment-specific so a token from one
environment is not accepted in another.

**Focused validation:** configuration unit tests, Bicep build, Wrangler dry-run
or equivalent package checks, and local runtime startup with missing/rotated
keys.

### Task 7: Migrate credentials and routes without an outage

Use an explicit three-phase rollout. There is no implicit fallback mode.

- [ ] Phase A: deploy Doc/CAS validators in an explicitly configured `dual`
      mode that accepts either the legacy service token on a quarantined legacy
      `/users/*` route adapter or capabilities on tenant-aware routes. Emit
      credential-kind and route-generation metrics. Capability validation
      remains strict, and tenant routes never accept identity headers as
      authority.
- [ ] Phase B: switch Gateway to two-token issuance and every Doc -> CAS client
      to delegated capabilities and the split protocol route builders. Verify supported
      traffic emits zero legacy authentications and zero legacy-route matches
      for at least one maximum token lifetime plus the operational observation
      window.
- [ ] Phase C1: deploy Doc/CAS in `capability` mode and stop mounting the legacy
      secret in active services. Retain the prior capability-aware `dual`
      artifact and a disabled, access-controlled version of the legacy secret
      for one explicitly recorded rollback window.
- [ ] Phase C2: after the rollback window and capability-only observation gate,
      delete the legacy secret from platform secret stores, remove legacy
      routes, matchers, headers/config from Gateway, Doc, CAS, clients, scripts,
      tests, generated config, and infrastructure, deactivate old revisions,
      and delete `dual` mode.
- [ ] Make the final/default production mode `capability`; an absent mode or
      absent trust configuration must not silently select legacy behavior.
- [ ] Update local development and integration harnesses to issue real test
      capabilities rather than inserting a magic shared token.

Rollback during Phase A/B or C1 is an audited forward deployment of the retained
capability-aware `dual` artifact plus an explicit remount of the retained
legacy secret. Phase C2 begins only after that bounded rollback window closes.
After secret destruction, pre-capability artifacts are intentionally no longer
valid rollback targets; recovery must use a capability-capable release and key
rotation. Do not retain a hidden permanent legacy bypass.

**Gate:** Repository search finds no service-edge/runtime auth use of
`INTERNAL_TOKEN`, `X-Internal-Token`, `X-User-Id`, or `/users/*`; historical
plans and explicitly private adapter route names may retain those terms as
history/context.
Active Cloudflare and Azure configuration contains no legacy secret/binding,
old revisions are inactive, and direct legacy route/header probes fail at every
Doc/CAS runtime.

### Task 8: Protocol conformance, security integration, and canonical docs

- [ ] Add one shared HTTP conformance and authorization behavior suite and run
      it against Gateway, every supported Doc runtime/doctype, and every CAS
      runtime.
- [ ] Assert all current methods, operation names, query parameters, request and
      response fields, status behavior, media types, and headers remain intact
      after the tenant/auth and package migrations.
- [ ] Cover valid current create/read/write and CAS read/write/admin operations.
- [ ] Cover missing, malformed, tampered, expired, future, overlong, wrong-key,
      wrong-issuer, wrong-audience, wrong-permission, wrong-tenant, and
      wrong-session tokens.
- [ ] Prove that a Doc token cannot call CAS and a CAS token cannot call Doc.
- [ ] Prove that delegated CAS capabilities never contain Doc permissions or
      `cas:admin`, and that Doc tokens never reach CAS.
- [ ] Prove that user credentials/cookies/internal-looking public headers never
      reach Doc/CAS.
- [ ] Prove equal `docId`, `sessionId`, and CAS hashes in different tenants never
      collide and that no service keys tenant data by user.
- [ ] Prove rotation overlap accepts both configured keys and removal rejects
      the retired key after the bounded lifetime.
- [ ] Inspect active Cloudflare secrets/bindings and Azure Container App
      revisions, environment variables, and secret references. Prove local,
      generated, and deployed configuration has no shared-token credential or
      equivalent renamed bypass.
- [ ] Probe every active Doc/CAS runtime with the retired legacy header and
      verify `401`; confirm capability-authenticated smoke paths still succeed.
- [ ] Add a focused throughput/latency check for two Gateway signatures plus
      local Doc/CAS verification. Treat external signer throttling or material
      latency as a deployment issue, not a reason to broaden token lifetime or
      cache bearer tokens across operations.
- [ ] Update canonical architecture, deployment, operations, and incident
      response documentation. Mark this plan complete rather than leaving it as
      a competing source of truth.

Final validation:

```text
pnpm build
pnpm typecheck
pnpm test
pnpm test:local
```

## Completion gate

The migration is complete only when all of the following hold:

- Gateway is the only capability issuer and the only service that handles user
  identity/authorization.
- Every internal operation is authorized to an explicit tenant; every session
  operation is additionally authorized to one session.
- Gateway -> Doc uses a Doc-only token plus, when needed, a separate CAS-only
  delegated capability.
- Doc never forwards its own token, never persists delegated capabilities, and
  never calls Gateway to validate or refresh them.
- CAS enforces tenant permissions and derives session root ownership from a
  signed session constraint.
- No service accepts a token for another audience, an overlong token, or a
  permission implied by another permission.
- `INTERNAL_TOKEN`, `X-Internal-Token`, and production dual mode are gone from
      active code, generated configuration, platform secret stores/bindings, and
      active revisions; deployed legacy-header probes fail closed.
- Private keys exist only in Gateway-controlled secret/signing facilities;
  Doc/CAS hold only the required public keys.
- Full repository validation and both cloud-focused authorization behavior
  suites pass.