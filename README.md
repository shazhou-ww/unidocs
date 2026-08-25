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
├── svalue-codec/          @unidocs/svalue-codec          — SValue/SBlob codec + protocol helpers
├── http-protocol/         @unidocs/http-protocol         — HTTP wire contracts for gateway/cas/sdk microservices
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

All end-user endpoints go through Gateway. The current compatibility API lives
under `/users/{userId}/...`; a Gateway identity resolver must bind authenticated
identity to that path. Gateway never forwards `userId` downstream: Doc calls use
`sessionId`, and CAS calls use `tenantId`. The path-based development resolver is
disabled unless `INSECURE_PATH_IDENTITY=true` is explicitly configured.

### Document lifecycle

```
POST   /users/{userId}/docs/{docType}/                              → create document (multipart/form-data)
GET    /users/{userId}/docs/{docType}/                              → list documents
GET    /users/{userId}/docs/{docType}/{docId}/export                → download document (binary)
POST   /users/{userId}/docs/{docType}/{docId}/query                 → query document → { data, version }
POST   /users/{userId}/docs/{docType}/{docId}/apply                 → apply delta → { version }
GET    /users/{userId}/docs/{docType}/{docId}/history               → get delta history
POST   /users/{userId}/docs/{docType}/{docId}/rollback              → rollback to version
POST   /users/{userId}/docs/{docType}/{docId}/run                   → Operator ReAct loop
POST   /users/{userId}/docs/{docType}/{docId}/reset                 → reset Operator session
```

### CAS

```
GET    /users/{userId}/cas/nodes/{hash}/content    → read node bytes
GET    /users/{userId}/cas/nodes/{hash}/metadata   → read metadata + state
POST   /users/{userId}/cas/nodes/{hash}            → lease with content
POST   /users/{userId}/cas/nodes/{hash}/lease      → extend a ready node
GET    /users/{userId}/cas/usage                   → storage usage
```

CAS GC and root management are internal service operations. Usage requires
tenant-administration authorization at Gateway.

See [CAS Architecture](docs/cas-architecture.md) for lease-with-content and lease-extend.

### Create document

```
POST /users/{userId}/docs/{docType}/
Content-Type: multipart/form-data

Fields (mutually exclusive):
- file: binary file to initialize from
- sourceId: existing document ID to clone from
- (empty): create empty document

Response: { success: true, docId: string, version: 1 }
```

Clone flow:
1. Gateway resolves `sourceId` in the authenticated user's document directory
2. Gateway verifies the source is ready, uses the same Doc service, and belongs
  to the resolved tenant
3. Gateway obtains the source snapshot and reserves the target document/session
4. Gateway calls the target session's internal `/init-from-hash` endpoint
5. the destination retains the same snapshot DAG without copying content

Snapshot hashes are never accepted as public clone capabilities. Cross-user or
cross-tenant clone is rejected; cross-tenant content copy requires a future
authorized recursive DAG-copy operation.

### Query

```
POST /users/{userId}/docs/{docType}/{docId}/query
Content-Type: application/vnd.unidocs.svalue+cbor;version=1

{ "kind": "...", "payload": {...} }

Response: { success: true, data: any, version: number }
```

Every query response includes the current document version.

JSON remains a compatibility transport for values that contain no SBlob.

### Apply (delta)

```
POST /users/{userId}/docs/{docType}/{docId}/apply
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
POST /users/{userId}/docs/{docType}/{docId}/rollback
Content-Type: application/json

{ "version": 10 }

Response: { success: true, version: 43 }
```

Rollback implementation:
1. Find nearest snapshot ≤ target version (from sqlite snapshots table)
2. Load the retained TDoc root from user CAS
3. Replay retained SValue delta roots to the target
4. Insert a restore delta that references the reconstructed standalone TDoc root

### Operator (AI agent interface)

```
POST /users/{userId}/docs/{docType}/{docId}/run
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
POST /users/{userId}/docs/{docType}/{docId}/reset

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

Set the Doc worker's own `SERVICE_ACCESS_KEY` and outbound `CAS_ACCESS_KEY`.

5. Add a deployment-time Gateway registration (secure
`DOC_SERVICES_JSON`); do not add a runtime KV row or Gateway DO binding:

```json
{
  "mytype": {
    "serviceId": "mytype",
    "url": "https://mytype.internal",
    "accessKey": "..."
  }
}
```

6. Azure side — no Durable Objects, so no DO bindings to wire up. Instead:
   - New `packages/azure-mytype/` (`package.json`, `tsconfig.json`, `src/main.ts`, `scripts/bundle.mjs`) — copy `packages/azure-docx` as the template rather than `packages/azure-markdown`: its `bundle.mjs` explicitly externalizes only `pg`/`@azure/storage-blob` instead of using `packages: "external"`, which matters the moment your doc type pulls in a real (non-`@unidocs/*`) npm dependency that isn't also a root `package.json` devDependency — `packages: "external"` would leave that import unresolvable at runtime. `src/main.ts` should differ from the docx entry by nothing but the doc type string and the default port; if it needs more than that, the gap belongs in `@unidocs/azure-sdk`, not in the entry point.
   - Add a `mytype: <port>` row to `AZURE_DOC_TYPE_PORT_BASE` in `scripts/azure-ports.mjs` (pick a base at least `AZURE_PORT_STRIDE` past the last one).
   - Add `"mytype"` to `SUPPORTED_DOC_TYPES` in `scripts/azure-runtime.mjs`.
   - Add `{ "path": "packages/azure-mytype" }` to the root `tsconfig.json`'s `references`.
   - Provision a service-owned database and migration job, then include its URL
     and access key in Gateway's static registry.

## Development

```bash
pnpm dev                     # Gateway + every Doc type, Miniflare backend
pnpm dev docx                # Gateway + DOCX only
pnpm dev docx markdown       # explicit Doc type selection
```

The Miniflare runtime injects one static `DOC_SERVICES_JSON` containing only
the selected Doc services. Gateway, each Doc service, and CAS receive distinct
development access keys. Gateway alone binds `GATEWAY_DB`; Doc workers own only
their Durable Objects and call CAS through `CAS_SERVICE`.

```text
POST http://127.0.0.1:8787/users/{userId}/docs/markdown/
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
probe authenticates with the dedicated CAS key and calls the tenant-scoped CAS
service URL directly.

The Azure ports are intentionally offset from Miniflare, so both stacks can run
side by side. `Ctrl+C` stops Node child processes; run `pnpm azure:down` to stop
the Postgres container.

### Tests

| Command | Coverage |
|---|---|
| `pnpm test` | package tests under `packages/*/tests` |
| `pnpm test:local` | script tests and HTTP integration tests for both local stacks |
| treespec | clean-install YAML scenarios under `tests/treespec` |

Do not run `pnpm test:local`, `pnpm test`, and `pnpm dev --azure` concurrently.
They share the local Postgres server process and Azurite port even though each
service uses its own database and Blob containers.

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

Configure Gateway's secure `DOC_SERVICES_JSON` and `CAS_ACCESS_KEY`. Configure
each Doc worker's own `SERVICE_ACCESS_KEY` plus its outbound `CAS_ACCESS_KEY`.
There is no KV registry or runtime registration step.

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
