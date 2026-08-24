# UniDocs

Universal document editing framework for AI agents. Built on Cloudflare Workers + Durable Objects.

## Design documents

- [CAS Architecture](docs/cas-architecture.md) — user-scoped storage, leases, reference counts, GC, APIs, and DocumentType integration
- [CAS Binary Format](docs/cas-binary-format.md) — canonical SHA-256 Merkle DAG node encoding derived from CASFA

## Architecture

```
Client → Gateway (auth + routing) → Editor DO / Operator DO (per document instance)
```

### Three-layer system

- **Gateway** — unified API entry point, authentication, request routing
- **Editor DO** — document state management, CRUD operations, history, snapshots
- **Operator DO** — AI agent interface, ReAct loop, tool dispatch to Editor

### Storage layout

| Layer | Storage | Purpose |
|-------|---------|---------|
| DO KV | `docType`, `docId`, `userId` | Immutable document identity |
| DO sqlite | `svalue_deltas`, `svalue_snapshots`, `svalue_pending` | Root indexes + recoverable outbox |
| Shared D1 | `docs`, `snapshots` | Global listing and clone index |
| User CAS D1/R2 | nodes, edges, root owners + content | SValue/SBlob Merkle DAG storage |

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

Every delta is retained as an SValue root. Snapshots default to every 10 deltas
and share unchanged Blob descendants through CAS.

## Packages

```
packages/
├── cas/                   @unidocs/cas                   — CAS binary/digest kernel
├── core/                  @unidocs/core                  — Cloud-neutral document contracts
├── doctype-markdown/      @unidocs/doctype-markdown      — Cloud-neutral Markdown document type
├── doctype-docx/          @unidocs/doctype-docx          — Cloud-neutral DOCX document type
├── cloudflare-sdk/        @unidocs/cloudflare-sdk        — Durable Object runtime factories
├── cloudflare-cas/        @unidocs/cloudflare-cas        — User-scoped CAS worker
├── cloudflare-gateway/    @unidocs/cloudflare-gateway    — Cloudflare API Gateway
└── cloudflare-markdown/   @unidocs/cloudflare-markdown   — Cloudflare Markdown deployment
```

## API

All endpoints go through the Gateway. Document APIs live under `/users/{userId}/docs/{docType}/`. CAS APIs live under `/users/{userId}/cas/`. The path `userId` is the current identity; future Bearer tokens must bind to that userId.

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
POST   /users/{userId}/cas/gc                      → trigger GC
```

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
1. Gateway calls source Editor's `/snapshot` to get current hash
2. Gateway creates new Editor DO
3. Gateway calls new Editor's `/init_from_hash` with the hash
4. the destination retains the same snapshot DAG without copying content

Clone hashes are scoped to one user. Cross-user clone is rejected until an
authorized recursive DAG-copy operation is provided.

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
import type { DocumentTypeFactory } from "@unidocs/core";

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

[[d1_databases]]
binding = "SNAPSHOTS_DB"
database_name = "unidocs-snapshots"
database_id = "..."

[[services]]
binding = "CAS_SERVICE"
service = "unidocs-cas"
```

5. Add binding to Gateway's `wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "MYTYPE_EDITOR"
class_name = "MytypeEditor"
script_name = "unidocs-mytype"

[[durable_objects.bindings]]
name = "MYTYPE_OPERATOR"
class_name = "MytypeOperator"
script_name = "unidocs-mytype"
```

6. Azure side — no Durable Objects, so no DO bindings to wire up. Instead:
   - New `packages/azure-mytype/` (`package.json`, `tsconfig.json`, `src/main.ts`, `scripts/bundle.mjs`) — copy `packages/azure-docx` as the template rather than `packages/azure-markdown`: its `bundle.mjs` explicitly externalizes only `pg`/`@azure/storage-blob` instead of using `packages: "external"`, which matters the moment your doc type pulls in a real (non-`@unidocs/*`) npm dependency that isn't also a root `package.json` devDependency — `packages: "external"` would leave that import unresolvable at runtime. `src/main.ts` should differ from the docx entry by nothing but the doc type string and the default port; if it needs more than that, the gap belongs in `@unidocs/azure-sdk`, not in the entry point.
   - Add a `mytype: <port>` row to `AZURE_DOC_TYPE_PORT_BASE` in `scripts/azure-ports.mjs` (pick a base at least `AZURE_PORT_STRIDE` past the last one).
   - Add `"mytype"` to `SUPPORTED_DOC_TYPES` in `scripts/azure-runtime.mjs`.
   - Add `{ "path": "packages/azure-mytype" }` to the root `tsconfig.json`'s `references`.
   - `resolveWorkerUrl()` in `packages/azure-gateway/src/main.ts` and the replica/env wiring in `scripts/azure-runtime.mjs` already generalise over `docTypes`/`{TYPE}_WORKER_URL` — nothing to change there.

## Development

```bash
pnpm install
pnpm dev                     # gateway :8787 + every doc type, Miniflare backend
pnpm dev docx                # gateway + docx only
pnpm dev docx markdown       # explicit doc type selection
```

Starts gateway (`:8787`), markdown (`:8788`), and docx (`:8789`) in one Miniflare process with shared D1/R2. The KV registry is seeded with each worker's URL:

```
POST http://127.0.0.1:8787/users/{userId}/docs/markdown/
POST http://127.0.0.1:8787/users/{userId}/docs/docx/
```

### Running against the local Azure stack

```bash
pnpm dev --azure              # gateway :41787 + markdown :41800 + docx :41810, Postgres + Azurite backend
pnpm dev --azure markdown     # markdown only, explicit
pnpm dev --azure docx         # docx only — see the CAS prerequisite below
```

Prerequisites:

- **Docker must be running**, for Postgres. `pnpm dev --azure` starts a `docker compose` stack with just Postgres in it (`:5433`) and fails fast with an actionable message if the Docker daemon isn't up, rather than surfacing the raw `docker compose` error. Azurite is *not* a container — it's the `azurite` npm package's `azurite-blob` CLI, spawned directly as a Node child process on `:10000`, the same way the gateway/doc-type services themselves are spawned. There's no image to pull for it.
- **`docx` needs the Miniflare stack running too, in a second terminal.** `docx`'s image path depends on user-scoped CAS, which the Azure backend doesn't implement natively yet (planned for phase 4). Until then, `pnpm dev --azure docx` (or `pnpm dev --azure` with no doc type filter, since `docx` is included by default) points `CAS_BASE_URL` at the Cloudflare CAS worker from the Miniflare stack (`http://127.0.0.1:8790` by default — `startLocalRuntime()`'s direct-socket port for the CAS worker, *not* the Miniflare gateway, since `CasClient.updateRootRefs` calls `/_internal/root-refs`, which no gateway proxies). Before starting anything, `pnpm dev --azure docx` probes that address; if nothing answers, it exits immediately with the actionable fix (start `pnpm dev docx` in another terminal first) instead of letting the first image-touching `apply` fail with a bare `ECONNREFUSED`. `pnpm dev --azure markdown` has no such prerequisite — markdown's `refsFromOp` never touches CAS.

Migrations run automatically as part of startup — no separate command needed. The Azure ports (gateway `41787`, markdown `41800`s band, docx `41810`s band — see `scripts/azure-ports.mjs`) are deliberately offset from Miniflare's (`8787`/`8788`/`8789`) so both backends can run side by side, which `docx` on Azure now requires. `pnpm dev --azure`'s startup banner prints a ready-to-use `psql` connection string for Postgres and the Azurite blob endpoint, for poking at storage directly. `Ctrl+C` stops the gateway/doc-type/azurite-blob processes; it does **not** tear down the docker compose Postgres container (the signal handler that would await that teardown loses the race with `azure-runtime.mjs`'s own `process.exit()` on the same signal). Run `pnpm azure:down` afterwards to stop and remove it.

**First run only:** if `postgres:18-alpine` isn't cached locally yet, `docker compose up` pulls it (~100 MB) before anything else can start; every run after that is instant. There's no equivalent cost for Azurite — it installed with `pnpm install` like any other dependency.

### Tests that need Docker

`pnpm test:local` (via `scripts/azure-behavior.test.mjs`) and `pnpm -r test` (via `packages/azure-sdk`'s Vitest `globalSetup`, `packages/azure-sdk/tests/containers.ts`) both bring up the same `docker-compose.azure.yml` Postgres container (host port `:5433`, unnamed default compose project) and each spawn their own `azurite-blob` process on `:10000`. `pnpm dev --azure` starts the identical stack for interactive use.

**Do not run `pnpm test:local`, `pnpm -r test`, and `pnpm dev --azure` at the same time.** They still share the Postgres container: whichever one tears it down first (`docker compose ... down -v`) pulls the database out from under whichever else is still using it, mid-test or mid-session. They also all bind `:10000` for their own `azurite-blob` process, so a second one starting up simply fails to claim the port. Run them one at a time, or stop `pnpm dev --azure` before running either test command.

Docker must be running before invoking `pnpm test:local` or `pnpm -r test` for the first time — both will start the Postgres container themselves and run migrations against it, but the Docker daemon itself has to already be up. The first-run Postgres image pull noted above applies here too, and both entry points print an explicit notice before it happens so a slow pull doesn't read as a hang.
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
(`Failed to resolve entry for package "@unidocs/cas"`). Pointing the workspace-facing
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

**New environment only — before the first `wrangler deploy`:** run
`wrangler d1 migrations apply unidocs-snapshots` (from any package whose
`wrangler.toml` points `migrations_dir` at `../../migrations`, e.g.
`packages/cloudflare-gateway`). `wrangler deploy` does **not** apply
migrations automatically — `migrations_dir` is just configuration. The
shared `docs`/`snapshots` tables used to be created lazily by
`listDocuments`/`D1DocIndex.register`; they no longer are. Skipping this
step is harmless on an already-provisioned database, but on a brand-new one
every query/apply/list call will 500 with `no such table: docs`.

## Infrastructure

- **Cloudflare Workers** — runtime
- **Durable Objects** — per-document state + isolation
- **D1** — CAS metadata/root owners and shared document indexes
- **R2** — user-scoped immutable CAS node content
- **KV** — immutable per-document identity only

## Roadmap

See [open issues](https://git.shazhou.work/shazhou/unidocs/issues) for upcoming work.

## License

TBD
