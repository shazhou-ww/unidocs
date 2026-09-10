# @unidocs/protocol-admin-portal

Contract-first administrator control-plane protocol for UniDocs Platform.

The package is the single source of truth for:

- Zod 4 request, response, and resource schemas;
- the oRPC contract used by browser clients and server implementations;
- Admin v1 HTTP methods, paths, headers, status codes, and typed errors;
- administrator member list, add, and conditional remove operations;
- paginated administrator audit events with actor, action, resource, document type, and time filters;
- generated OpenAPI 3.1 documentation.

It contains no Platform handler, persistence, Node.js server, or Cloudflare Worker adapter.

## Use the shared contract

A frontend can derive its complete client type from the contract:

```ts
import type { ContractRouterClient } from "@orpc/contract";
import { adminApiContract } from "@unidocs/protocol-admin-portal";

type AdminClient = ContractRouterClient<typeof adminApiContract>;
```

A service package can implement the same contract with `implement` from
`@orpc/server`, then expose the resulting router with the Node.js or Fetch
OpenAPI handler. Cloudflare Workers use the Fetch handler without changing the
contract or business implementation.

Every operation supports two authentication modes. Requests carrying an
`Authorization: Bearer` header use only that token. Requests without one use
the same-origin `__Host-unidocs_admin` HttpOnly session cookie. A rejected
Bearer token never falls back to the cookie, even when a valid cookie is also
present.

Cookie-authenticated mutations require `X-CSRF-Token`; Bearer-authenticated
mutations do not. All mutations require `Idempotency-Key`, and PATCH operations
additionally require `If-Match`.

Stored-resource mutations return compact identity results: a resource ID and
ETag, or a revision and content hash. Complete manifests, schemas, descriptors,
and registrations are read through their GET operations. Synchronous Operator
validation remains a full response because the validation result is the direct
product of that operation.

Collection operations return lightweight summary DTOs. Item GET operations are
the canonical source for complete representations, including bundle manifests,
Operator descriptors, and paired contract schemas. Each operation documents
only its applicable errors; bundle validation and conditional-update errors are
not attached to unrelated reads.

Type Card and View bundle uploads use a raw `application/zip` body and put
initial Admin `name` and `description` in UTF-8 query parameters. A Document
Contract append uses `application/json` and atomically carries the snapshot
schema, location schema, shared `formatVersion`, and audit reason in one body.
Format version 1 derives fixed snapshot CBOR and location JSON media types; it
is independent from the server-assigned `DocumentContractIdx` schema revision.

## Generate OpenAPI

From the repository root:

```text
pnpm --filter @unidocs/protocol-admin-portal docs:generate
```

This writes two artifacts:

- `packages/protocol-admin-portal/openapi/admin-v1.openapi.json` for tooling, client generation, and compatibility checks;
- `packages/protocol-admin-portal/openapi/admin-v1.html` as a human-readable Scalar API reference.

The HTML embeds the OpenAPI document, so it can be opened directly from the
filesystem or published as one static file. It loads the pinned Scalar renderer
from jsDelivr; the Admin site can later bundle `@scalar/api-reference` locally
while continuing to consume the same generated document.

The generator and HTML renderer are internal build tools and are not exported
from the package. The committed JSON document has its own package entrypoint:

```ts
import adminOpenApi from "@unidocs/protocol-admin-portal/openapi.json" with { type: "json" };
```

## Validate

```text
pnpm --filter @unidocs/protocol-admin-portal test
pnpm --filter @unidocs/protocol-admin-portal typecheck
```
