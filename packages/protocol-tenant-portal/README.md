# @unidocs/protocol-tenant-portal

Contract-first end-user data-plane protocol for UniDocs Platform.

The package is the single source of truth for:

- Zod 4 request, response, and resource schemas;
- the oRPC contract used by browser clients and server implementations;
- Tenant v1 HTTP methods, paths, headers, status codes, and typed errors;
- the enabled document type catalog and its paired Document Contract revisions;
- documents, immutable versions, comment provenance, and the current pointer;
- position-anchored threads with their append-only ping and pong sequences;
- short-lived direct-UniCAS tenant capabilities;
- generated OpenAPI 3.1 documentation.

It contains no Platform handler, persistence, Node.js server, or Cloudflare
Worker adapter. Administrator control-plane contracts live in
`@unidocs/protocol-admin-portal`; the sandboxed View Host RPC, the Agent
submission API, and the Operator webhook live in `@unidocs/protocol-platform`.

## Use the shared contract

A frontend can derive its complete client type from the contract:

```ts
import type { ContractRouterClient } from "@orpc/contract";
import { tenantApiContract } from "@unidocs/protocol-tenant-portal";

type TenantClient = ContractRouterClient<typeof tenantApiContract>;
```

A service package can implement the same contract with `implement` from
`@orpc/server`, then expose the resulting router with the Node.js or Fetch
OpenAPI handler. Cloudflare Workers use the Fetch handler without changing the
contract or business implementation.

Every operation supports two authentication modes. Requests carrying an
`Authorization: Bearer` header use only that token — this is how an Operator
Agent reads the same authoritative data as a user. Requests without one use the
same-origin `__Host-unidocs_tenant` HttpOnly session cookie. A rejected Bearer
token never falls back to the cookie, even when a valid cookie is also present.

Cookie-authenticated mutations require `X-CSRF-Token`; Bearer-authenticated
mutations do not. Creating a document, a thread, or a ping additionally requires
`Idempotency-Key`, because a retry would otherwise create a second record.
Moving the current pointer needs no key: `observedCurrentVersionIdx` is an
equality lock that already makes a retry safe.

## What the shapes encode

Mutations here return the complete new record rather than a compact identity.
These operations create server-numbered immutable records, so the record is the
operation's direct product, and tenant resources carry no ETag that would make
a follow-up GET worthwhile. See the mutation-response rules in
`docs/api-conventions.md`.

A version snapshot is read from its own operation, not embedded in the version
record: an `SValue` carries atomic `SBlob` references that have no JSON
representation, so the snapshot crosses the wire as canonical SValue CBOR under
the document-type-specific media type recorded on its Document Contract
revision. Version metadata stays JSON, which is what version history needs —
`parentVersionIdx` for the base parent forest and `addressedPings` for the
comment provenance graph.

A thread's open state is derived, never stored: a thread is open while its
latest ping is beyond the cumulative pong watermark. There is consequently no
resolve or reopen operation anywhere in this contract, and no ping edit,
delete, or withdraw operation — a correction is a new ping on the same thread.

## Generate OpenAPI

From the repository root:

```text
pnpm --filter @unidocs/protocol-tenant-portal docs:generate
```

This writes two artifacts:

- `packages/protocol-tenant-portal/openapi/tenant-v1.openapi.json` for tooling, client generation, and compatibility checks;
- `packages/protocol-tenant-portal/openapi/tenant-v1.html` as a human-readable Scalar API reference.

The HTML embeds the OpenAPI document, so it can be opened directly from the
filesystem or published as one static file. It loads the pinned Scalar renderer
from jsDelivr; the Tenant Portal can later bundle `@scalar/api-reference`
locally while continuing to consume the same generated document.

The generator and HTML renderer are internal build tools and are not exported
from the package. The committed JSON document has its own package entrypoint:

```ts
import tenantOpenApi from "@unidocs/protocol-tenant-portal/openapi.json" with { type: "json" };
```

## Validate

```text
pnpm --filter @unidocs/protocol-tenant-portal test
pnpm --filter @unidocs/protocol-tenant-portal typecheck
```
