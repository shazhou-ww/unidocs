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

Generate the OpenAPI 3.1 JSON and standalone Scalar reference from the
repository root:

```text
pnpm --filter @unicas/admin-protocol docs:generate
```

The generated files are `openapi/admin-v1.openapi.json` and
`openapi/admin-v1.html`. The HTML embeds the specification and can be opened
directly; it loads the pinned Scalar renderer from jsDelivr.

Validate with:

```text
pnpm --filter @unicas/admin-protocol typecheck
pnpm --filter @unicas/admin-protocol test
```