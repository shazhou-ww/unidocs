# @unicas/tenant-protocol

Cloud-neutral UniCAS tenant data-plane contracts and capability vocabulary.

The package exports the existing request/response types, route helpers, and
matchers together with Zod resource schemas and `casTenantApiContract`, an
oRPC contract covering node, lease, usage, garbage collection, and Root Ref
operations. Binary CAS node bodies remain streamable.

Derive an implementation or client type from the shared contract:

```ts
import type { ContractRouterClient } from "@orpc/contract";
import { casTenantApiContract } from "@unicas/tenant-protocol";

type TenantClient = ContractRouterClient<typeof casTenantApiContract>;
```

Generate the OpenAPI 3.1 JSON from the repository root:

```text
pnpm --filter @unicas/tenant-protocol docs:generate
```

The generated file is `openapi/tenant-v1.openapi.json`. Presentation, guides,
navigation grouping, and Scalar rendering are owned by `@unicas/docs-webui`,
which consumes the package's `./openapi.json` export.

Validate with:

```text
pnpm --filter @unicas/tenant-protocol typecheck
pnpm --filter @unicas/tenant-protocol test
```