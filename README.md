# UniDocs

Universal document editing framework for AI agents. Built on Cloudflare Workers + Durable Objects.

## Design documents

- [Microservice Architecture](docs/microservice-architecture.md) — service ownership, identity translation, static registration, and deployment boundaries
- [CAS Architecture](docs/cas-architecture.md) — tenant-scoped storage, leases, reference counts, GC, APIs, and DocumentType integration
- [CAS Binary Format](docs/cas-binary-format.md) — canonical SHA-256 Merkle DAG node encoding derived from CASFA

## Architecture

```text
Client → Gateway (user auth + directory)
              ├──→ Doc service (opaque session)
              └──→ CAS (tenant-scoped storage)
Doc service ─────→ CAS
```

### Three-layer system

- **Gateway** — the only user-facing service; owns auth, list, public `docId`, and `docId → sessionId` routing
- **Doc service** — one document type per independently deployable service; owns session state and has no user/list concept
- **CAS** — tenant-scoped content-addressed storage, usage accounting, leases, references, and GC

### Storage layout

| Layer | Storage | Purpose |
|-------|---------|---------|
| Gateway DB | user, tenant, `docId`, `sessionId`, lifecycle | User directory and routing |
| Doc session metadata | `docType`, `sessionId`, `tenantId` | Immutable internal session identity |
| DO sqlite | `svalue_deltas`, `svalue_snapshots`, `svalue_pending` | Root indexes + recoverable outbox |
| Tenant CAS D1/R2 | nodes, edges, root owners + content | SValue/SBlob Merkle DAG storage |

### Consistency model

Write order on every delta:
1. encode and lease the SValue delta root;
2. apply against immutable TDoc;
3. optionally encode and lease a TDoc snapshot root;
4. write one local pending/outbox row containing root hashes and bytes;
5. idempotently assign durable CAS root owners;
6. finalize local indexes and publish in-memory state.

Recovery retries pending bytes and owner assignment. A timeout cannot expose a
partially committed version.

### Versioning

- **Version**: monotonically increasing integer (auto-increment)
- **Delta**: a batch of operations applied atomically (all-or-nothing)
- **Snapshot**: a standalone retained TDoc SValue root

### Snapshot strategy

Every delta is retained as an SValue root. Snapshots default to every 20 deltas
and share unchanged Blob descendants through CAS.

## Packages

```
packages/
├── protocol/              @unidocs/protocol              — Document protocol contracts (types + constants, no logic)
├── protocol-cas/          @unidocs/protocol-cas          — CAS HTTP routes, wire contracts, and domain types
├── protocol-doc/          @unidocs/protocol-doc          — Doc HTTP routes, wire contracts, and errors
├── protocol-gateway/      @unidocs/protocol-gateway      — Gateway HTTP routes and pass-through contracts
├── service-auth/          @unidocs/service-auth          — Capability claims, permissions, issuance, and verification
├── svalue-codec/          @unidocs/svalue-codec          — SValue/SBlob codec + protocol helpers
├── gateway-common/        @unidocs/gateway-common        — Cloud-neutral API Gateway routing
├── cas-server-common/     @unidocs/cas-server-common     — CAS server kernel (binary/digest/validation)
├── cas-client/            @unidocs/cas-client            — Cloud-neutral CAS HTTP client
├── doctype-server-common/ @unidocs/doctype-server-common — Cloud-neutral doctype 服务公共实现 (session/ports/operator)
├── doctype-markdown/      @unidocs/doctype-markdown      — Cloud-neutral Markdown document type
├── doctype-docx/          @unidocs/doctype-docx          — Cloud-neutral DOCX document type
├── doctype-psd/           @unidocs/doctype-psd           — Cloud-neutral PSD image document type
├── psd-client/            @unidocs/psd-client            — Browser-side PSD render client
├── cloudflare-sdk/        @unidocs/cloudflare-sdk        — Durable Object runtime factories
├── cloudflare-cas/        @unidocs/cloudflare-cas        — Tenant-scoped CAS worker
├── cloudflare-gateway/    @unidocs/cloudflare-gateway    — Cloudflare API Gateway
├── cloudflare-markdown/   @unidocs/cloudflare-markdown   — Cloudflare Markdown deployment
├── cloudflare-docx/       @unidocs/cloudflare-docx       — Cloudflare DOCX deployment
├── cloudflare-psd/        @unidocs/cloudflare-psd        — Cloudflare PSD deployment
├── azure-sdk/             @unidocs/azure-sdk             — Azure (Postgres + Blob) storage adapters
├── azure-gateway/         @unidocs/azure-gateway         — Azure/Node API Gateway
├── azure-markdown/        @unidocs/azure-markdown        — Azure/Node Markdown service
├── azure-docx/            @unidocs/azure-docx            — Azure/Node DOCX service
└── web-psd/               @unidocs/web-psd               — PSD dev frontend (Vite)
```

## API

All end-user endpoints go through Gateway under `/tenants/{tenantId}/...`.
Gateway authenticates the user, authorizes tenant membership, and never forwards
end-user credentials or `userId` downstream. Doc calls use a private `sessionId`;
CAS calls use `tenantId`. The path-based development resolver is disabled unless
`INSECURE_PATH_IDENTITY=true` is explicitly configured. Legacy `/users/*` routes
are rejected.

### Document lifecycle

```
POST   /tenants/{tenantId}/docs/{docType}/                              → create document (multipart/form-data)
GET    /tenants/{tenantId}/docs/{docType}/                              → list documents
GET    /tenants/{tenantId}/docs/{docType}/{docId}/export                → download document (binary)
POST   /tenants/{tenantId}/docs/{docType}/{docId}/query                 → query document → { data, version }
POST   /tenants/{tenantId}/docs/{docType}/{docId}/apply                 → apply delta → { version }
GET    /tenants/{tenantId}/docs/{docType}/{docId}/history               → get delta history
POST   /tenants/{tenantId}/docs/{docType}/{docId}/rollback              → rollback to version
POST   /tenants/{tenantId}/docs/{docType}/{docId}/run                   → Operator ReAct loop
POST   /tenants/{tenantId}/docs/{docType}/{docId}/reset                 → reset Operator session
```

### CAS

```
GET    /tenants/{tenantId}/cas/nodes/{hash}/content    → read node bytes
GET    /tenants/{tenantId}/cas/nodes/{hash}/metadata   → read metadata + state
POST   /tenants/{tenantId}/cas/nodes/{hash}            → lease with content
POST   /tenants/{tenantId}/cas/nodes/{hash}/lease      → extend a ready node
GET    /tenants/{tenantId}/cas/usage                   → storage usage
POST   /tenants/{tenantId}/cas/gc                      → tenant-admin GC
```

CAS root management is internal. Usage and GC require tenant-administration
authorization at Gateway.

See [CAS Architecture](docs/cas-architecture.md) for lease-with-content and lease-extend.

### Create document

```
POST /tenants/{tenantId}/docs/{docType}/
Content-Type: multipart/form-data

Fields (mutually exclusive):
- file: binary file to initialize from
- sourceId: existing document ID to clone from
- (empty): create empty document

Response: { success: true, docId: string, version: 1 }
```

Clone flow:
1. Gateway resolves `sourceId` in the authenticated tenant's document directory
2. Gateway verifies the source is ready, uses the same Doc service, and belongs
  to the resolved tenant
3. Gateway obtains the source snapshot and reserves the target document/session
4. Gateway calls the target session's internal `/init-from-hash` endpoint
5. the destination retains the same snapshot DAG without copying content

Snapshot hashes are never accepted as public clone capabilities. Cross-tenant
clone is rejected; cross-tenant content copy requires a future
authorized recursive DAG-copy operation.

### Query

```
POST /tenants/{tenantId}/docs/{docType}/{docId}/query
Content-Type: application/vnd.unidocs.svalue+cbor;version=1

{ "kind": "...", "payload": {...} }

Response: { success: true, data: any, version: number }
```

Every query response includes the current document version.

JSON remains a compatibility transport for values that contain no SBlob.

### Apply (delta)

```
POST /tenants/{tenantId}/docs/{docType}/{docId}/apply
Content-Type: application/vnd.unidocs.svalue+cbor;version=1

{
  "operations": [ { "kind": "...", "payload": {...} }, ... ],
  "description": "human-readable description",
  "baseVersion": 42
}

Response: { success: true, version: 43 }
```

**Optimistic locking**: `baseVersion` must match current version. Returns `409` on conflict.

**Transactional**: all operations in a delta succeed or fail together. If any operation throws, the entire delta is rejected.

Blob-taking domain operations carry SBlob, not a magic JSON property. Agent
tools may accept explicit uploaded hashes; the doctype's JSON `toolCall` handler
resolves them to SBlob before typed apply and persistence. Direct `/apply` never
performs this conversion.

### Rollback

```
POST /tenants/{tenantId}/docs/{docType}/{docId}/rollback
Content-Type: application/json

{ "version": 10 }

Response: { success: true, version: 43 }
```

Rollback implementation:
1. Find nearest snapshot ≤ target version (from sqlite snapshots table)
2. Load the retained TDoc root from tenant CAS
3. Replay retained SValue delta roots to the target
4. Insert a restore delta that references the reconstructed standalone TDoc root

### Operator (AI agent interface)

```
POST /tenants/{tenantId}/docs/{docType}/{docId}/run
Content-Type: application/json

{ "instruction": "natural language task description" }

Response: { success: true, data: { response: string, iterations: number } }
```

Operator behavior:
- Maintains conversation history
- Dispatches `(tool name, JSON parameters)` to the doctype's DocumentAgent
- Agent query updates the optimistic-lock version; agent apply uses it
- Structured results are JSON; optional media content is rendered by the model-provider adapter
- On `409` conflict, error includes `currentVersion` and retry hint
- Max 10 iterations per run (configurable)

```
POST /tenants/{tenantId}/docs/{docType}/{docId}/reset

Response: { success: true }
```

Clears conversation history and version tracking.

## Adding a document type

1. Create a cloud-neutral package: `packages/doctype-mytype/`
2. Export a context-curried `DocumentType` factory. Optional doctype settings
  belong in an outer function (`Options -> Context -> DocumentType`), not in
  the core factory generic:

```typescript
import type { DocumentTypeFactory } from "@unidocs/protocol";

export const createMytypeDocumentType:
  DocumentTypeFactory<MyDocument, MyQuery, MyOperation> =
  context => ({
    init: ...,
    query: ...,
    apply: ...,
    formats: {
      myformat: { mediaTypes: [...], extensions: [...], load: ..., save: ... },
    },
    defaultFormat: "myformat",
  });

export const createMytypeDocumentAgent:
  DocumentAgentFactory<MyQuery, MyOperation> =
  context => ({
    tools: ...,
    instructions: ...,
    async toolCall(name, parameters) {
      // parameters and structuredContent are JSON-only. Internally the handler
      // can call context.query/apply/resolveBlob/readBlob.
      return { structuredContent: ... };
    },
  });
```

3. Create a separate Cloudflare adapter package and use the runtime factories:

```typescript
import { createEditorDO, createOperatorDO } from "@unidocs/cloudflare-sdk";
import { createMytypeDocumentType } from "@unidocs/doctype-mytype";

export const MytypeEditor = createEditorDO(createMytypeDocumentType);
export const MytypeOperator = createOperatorDO({
  agentFactory: createMytypeDocumentAgent,
  llmProvider: ...,
  getEditorStub: ...,
});
```

4. Configure `wrangler.toml`:

```toml
name = "unidocs-mytype"

[[durable_objects.bindings]]
name = "MYTYPE_EDITOR"
class_name = "MytypeEditor"

[[durable_objects.bindings]]
name = "MYTYPE_OPERATOR"
class_name = "MytypeOperator"

[[services]]
binding = "CAS_SERVICE"
service = "unidocs-cas"
```

Set the Doc worker's exact `DOC_CAPABILITY_AUDIENCE`, CAS audience, issuer, and
public-only `CAPABILITY_TRUSTED_JWKS`. Only Gateway receives the matching private
signing key.

5. Add a deployment-time Gateway registration (secure
`DOC_SERVICES_JSON`); do not add a runtime KV row or Gateway DO binding:

```json
{
  "mytype": {
    "serviceId": "mytype",
    "url": "https://mytype.internal",
    "audience": "unidocs-doc:mytype"
  }
}
```

6. Azure side — no Durable Objects, so no DO bindings to wire up. Instead:
   - New `packages/azure-mytype/` (`package.json`, `tsconfig.json`, `src/main.ts`, `scripts/bundle.mjs`) — copy `packages/azure-docx` as the template rather than `packages/azure-markdown`: its `bundle.mjs` explicitly externalizes only `pg`/`@azure/storage-blob` instead of using `packages: "external"`, which matters the moment your doc type pulls in a real (non-`@unidocs/*`) npm dependency that isn't also a root `package.json` devDependency — `packages: "external"` would leave that import unresolvable at runtime. `src/main.ts` should differ from the docx entry by nothing but the doc type string and the default port; if it needs more than that, the gap belongs in `@unidocs/azure-sdk`, not in the entry point.
   - Add a `mytype: <port>` row to `AZURE_DOC_TYPE_PORT_BASE` in `stacks/azure/local/ports.mjs` (pick a base at least `AZURE_PORT_STRIDE` past the last one).
   - Add `"mytype"` to `SUPPORTED_DOC_TYPES` in `stacks/azure/local/runtime.mjs`.
   - Add `{ "path": "packages/azure-mytype" }` to the root `tsconfig.json`'s `references`.
   - Provision a service-owned database and migration job, then include its URL
     and exact capability audience in Gateway's static registry.

## Development

```bash
pnpm dev                     # Gateway + every Doc type, Miniflare backend
pnpm dev docx                # Gateway + DOCX only
pnpm dev docx markdown       # explicit Doc type selection
```

The Miniflare runtime injects one static `DOC_SERVICES_JSON` containing only
the selected Doc services and generates an ephemeral ES256 fixture unless one
is supplied. Gateway receives the private key; Doc and CAS receive only its
public JWKS. Gateway alone binds `GATEWAY_DB`; Doc workers own only their Durable
Objects and call CAS through `CAS_SERVICE` with request-local delegated tokens.

```text
POST http://127.0.0.1:8787/tenants/{tenantId}/docs/markdown/
```

### Local Azure stack

```bash
pnpm dev --azure              # Gateway :41787 + Markdown :41800 + DOCX :41810
pnpm dev --azure markdown     # Markdown only
```

Docker must be running for Postgres on `:5433`. Azurite runs as a Node child
process on `:10000`. Startup creates and migrates independent
`unidocs_gateway`, `unidocs_markdown`, and `unidocs_docx` databases; replicas
of one Doc service share only that service's database and Blob containers.

Azure DOCX currently uses the Cloudflare CAS worker as a cross-cloud service.
Start `pnpm dev docx` in another terminal first, or set `CAS_BASE_URL`. The
Azure and Cloudflare local stacks share one ephemeral capability fixture so
Azure Doc calls the tenant-scoped CAS URL with request-local delegated tokens.

Migrations run automatically as part of startup — no separate command needed. The Azure ports (gateway `41787`, markdown `41800`s band, docx `41810`s band — see `stacks/azure/local/ports.mjs`) are deliberately offset from Miniflare's (`8787`/`8788`/`8789`) so both backends can run side by side, which `docx` on Azure now requires. `pnpm dev --azure`'s startup banner prints a ready-to-use `psql` connection string for Postgres and the Azurite blob endpoint, for poking at storage directly. `Ctrl+C` stops the gateway/doc-type/azurite-blob processes; it does **not** tear down the docker compose Postgres container (the signal handler that would await that teardown loses the race with `stacks/azure/local/runtime.mjs`'s own `process.exit()` on the same signal). Run `pnpm azure:down` afterwards to stop and remove it.

**First run only:** if `postgres:18-alpine` isn't cached locally yet, `docker compose up` pulls it (~100 MB) before anything else can start; every run after that is instant. There's no equivalent cost for Azurite — it installed with `pnpm install` like any other dependency.

### Tests

| Command | Coverage |
|---|---|
| `pnpm test` | 各包 `packages/*/tests` 单测 |
| `pnpm test:local` | `tests/unit`（脚本单测）+ `tests/integration/cloudflare` + `tests/integration/shared`（起 Miniflare 的 HTTP） |
| `pnpm test:azure` | `tests/integration/azure`（起本地 Azure 栈的 HTTP，需要 Docker） |
| treespec | `tests/treespec/`（容器里从干净安装跑 YAML 树；镜像见同目录 `Dockerfile`） |

`pnpm test:azure` (via `tests/integration/azure/azure-behavior.test.mjs`) and `pnpm -r test` (via `packages/azure-sdk`'s Vitest `globalSetup`, `packages/azure-sdk/tests/containers.ts`) both bring up the same `packages/azure-sdk/docker-compose.yml` Postgres container (host port `:5433`, unnamed default compose project) and each spawn their own `azurite-blob` process on `:10000`. `pnpm dev --azure` starts the identical stack for interactive use.

**Do not run `pnpm test:azure`, `pnpm -r test`, and `pnpm dev --azure` at the same time.** They still share the Postgres container: whichever one tears it down first (`docker compose ... down -v`) pulls the database out from under whichever else is still using it, mid-test or mid-session. They also all bind `:10000` for their own `azurite-blob` process, so a second one starting up simply fails to claim the port. Run them one at a time, or stop `pnpm dev --azure` before running either test command.

Docker must be running before invoking `pnpm test:azure` or `pnpm -r test` for the first time — both will start the Postgres container themselves and run migrations against it, but the Docker daemon itself has to already be up. The first-run Postgres image pull noted above applies here too, and both entry points print an explicit notice before it happens so a slow pull doesn't read as a hang. `pnpm test:local` needs no Docker at all — it no longer runs the Azure integration tests.
## Workspace package resolution

Library packages point `main` / `types` / `exports` at **`src/*.ts`**, and carry a
`publishConfig` block that restores the `dist/*` paths at publish time:

```json
{
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "publishConfig": {
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
  }
}
```

Why: with `dist`-only exports, `pnpm -r test` and `pnpm --filter <pkg> test` fail on a
fresh clone — vitest resolves a sibling workspace package before anything has built it
(`Failed to resolve entry for package "@unidocs/cas-server-common"`). Pointing the workspace-facing
entry at source removes the ordering dependency; `publishConfig` keeps packaged
consumers on the built artifacts (`pnpm pack` rewrites the fields and drops the block).

`typecheck` scripts use `tsc -b` rather than `tsc --noEmit`: TypeScript project
references cannot resolve an unbuilt dependency, and `tsc -b --noEmit` is rejected
outright (`TS6310: Referenced project may not disable emit`). Build mode walks the
reference graph and builds what it needs, so a clean checkout typechecks without a
manual pre-build.

**When adding a package**, follow both conventions — otherwise its first consumer
breaks the recursive test run.

## Deployment

Before deploying Cloudflare Gateway, apply its D1 migrations from
`packages/cloudflare-gateway`:

```text
wrangler d1 migrations apply unidocs-snapshots
```

Configure Gateway's secure `CAPABILITY_PRIVATE_KEY_PKCS8`, active
`CAPABILITY_KEY_ID`, issuer, CAS audience, and static `DOC_SERVICES_JSON` with an
exact audience per Doc service. Configure Doc/CAS validators with public-only
`CAPABILITY_TRUSTED_JWKS`, issuer, exact audiences, and lifetime policy. Key or
JWKS changes require deployment/restart; wait at least $300+30=330$ seconds
before removing retired trust. There is no KV registry or runtime registration
step. See [Capability Key Operations](docs/capability-key-operations.md).

Azure deployment provisions and migrates separate Gateway, Markdown, and DOCX
databases. Existing monolithic Azure data is left untouched; import it
explicitly before switching an environment that contains durable documents.
For each Doc service, first copy that type's legacy `deltas`, `doc_snapshots`,
and Blob objects into its service-owned database/containers without changing
the legacy `doc_id` values. Then provide the tenant mapping that the old schema
did not store:

```json
[
  { "sessionId": "legacy-doc-id", "tenantId": "tenant-1", "docType": "markdown" }
]
```

Run the built migration image/CLI with `DATABASE_URL` pointing at that Doc
database and `LEGACY_SESSION_MAP_FILE` pointing at the JSON file:

```text
pnpm --filter @unidocs/azure-sdk migrate:legacy-identities
```

The import is transactional and refuses to write anything unless every session
present in `deltas` or `doc_snapshots` has a matching identity. Import the
corresponding Gateway directory mapping before switching traffic. Routine
migrations never guess a tenant or silently adopt legacy rows.

## Infrastructure

- **Cloudflare Workers** — runtime
- **Durable Objects** — session state and tenant CAS serialization
- **D1/Postgres** — service-owned Gateway directory, Doc session logs, and CAS metadata
- **R2/Blob Storage** — tenant CAS content and Doc-service-owned roots/caches

## Roadmap

See [open issues](https://git.shazhou.work/shazhou/unidocs/issues) for upcoming work.

## License

TBD
