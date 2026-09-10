# @unidocs/protocol-admin

Contract-first administrator control-plane protocol for UniDocs Platform.

The package is the single source of truth for:

- Zod 4 request, response, and resource schemas;
- the oRPC contract used by browser clients and server implementations;
- Admin v1 HTTP methods, paths, headers, status codes, and typed errors;
- administrator member list, add, and conditional remove operations;
- generated OpenAPI 3.1 documentation.

It contains no Platform handler, persistence, Node.js server, or Cloudflare Worker adapter.

## Use the shared contract

A frontend can derive its complete client type from the contract:

```ts
import type { ContractRouterClient } from "@orpc/contract";
import { adminApiContract } from "@unidocs/protocol-admin";

type AdminClient = ContractRouterClient<typeof adminApiContract>;
```

A service package can implement the same contract with `implement` from
`@orpc/server`, then expose the resulting router with the Node.js or Fetch
OpenAPI handler. Cloudflare Workers use the Fetch handler without changing the
contract or business implementation.

All mutation operations require `X-CSRF-Token` and `Idempotency-Key`. PATCH
operations additionally require `If-Match`. Authentication uses the existing
same-origin `__Host-unidocs_admin` HttpOnly session cookie.

Bundle uploads use a raw `application/zip` body. Initial Admin `name` and
`description` are UTF-8 query parameters so the binary body remains streamable.

## Generate OpenAPI

From the repository root:

```text
pnpm --filter @unidocs/protocol-admin docs:generate
```

This writes two artifacts:

- `packages/protocol-admin/openapi/admin-v1.openapi.json` for tooling, client generation, and compatibility checks;
- `packages/protocol-admin/openapi/admin-v1.html` as a human-readable Scalar API reference.

The HTML embeds the OpenAPI document, so it can be opened directly from the
filesystem or published as one static file. It loads the pinned Scalar renderer
from jsDelivr; the Admin site can later bundle `@scalar/api-reference` locally
while continuing to consume the same generated document.

The generator and HTML renderer are internal build tools and are not exported
from the package. The committed JSON document has its own package entrypoint:

```ts
import adminOpenApi from "@unidocs/protocol-admin/openapi.json" with { type: "json" };
```

## Validate

```text
pnpm --filter @unidocs/protocol-admin test
pnpm --filter @unidocs/protocol-admin typecheck
```
