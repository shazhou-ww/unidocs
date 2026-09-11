# @unicas/admin-protocol

Cloud-neutral UniCAS administrator control-plane contracts.

The package exports the existing request/response types, route helpers, and
matchers together with Zod resource schemas and `casAdminApiContract`, an oRPC
contract covering all Admin HTTP operations. It contains no transport or
service implementation.

Derive an implementation or client type from the shared contract:

```ts
import type { ContractRouterClient } from "@orpc/contract";
import { casAdminApiContract } from "@unicas/admin-protocol";

type AdminClient = ContractRouterClient<typeof casAdminApiContract>;
```

Generate the OpenAPI 3.1 JSON from the repository root:

```text
pnpm --filter @unicas/admin-protocol docs:generate
```

The generated file is `openapi/admin-v1.openapi.json`. Presentation, guides,
navigation grouping, and Scalar rendering are owned by `@unidocs/docs-webui`,
which consumes the package's `./openapi.json` export.

Validate with:

```text
pnpm --filter @unicas/admin-protocol typecheck
pnpm --filter @unicas/admin-protocol test
```