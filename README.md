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

### Current storage layout

The table below describes the implementation before the user-scoped CAS migration. The accepted target design is documented in [CAS Architecture](docs/cas-architecture.md).

| Layer | Storage | Purpose |
|-------|---------|---------|
| KV | `docType`, `docId`, `snapshot` | Immutable facts + latest snapshot cache |
| DO sqlite | `deltas`, `snapshots` | Operation history + snapshot index |
| Shared D1 | `snapshots` | Global snapshot index (cross-DO clone support) |
| R2 CAS | `hash → bytes` | Content-addressed snapshot storage (dedup) |

### Current consistency model

Write order on every delta:
1. sqlite INSERT delta (source of truth)
2. KV PUT snapshot cache (may lag on crash, never inconsistent)
3. (if threshold met) R2 PUT + D1 INSERT snapshot

### Versioning

- **Version**: monotonically increasing integer (auto-increment)
- **Delta**: a batch of operations applied atomically (all-or-nothing)
- **Snapshot**: full document state at a point in time

### Snapshot strategy

Snapshots are created every 20 deltas since the last snapshot.

## Packages

```
packages/
├── core/                  @unidocs/core                  — Cloud-neutral document contracts
├── doctype-markdown/      @unidocs/doctype-markdown      — Cloud-neutral Markdown document type
├── doctype-docx/          @unidocs/doctype-docx          — Cloud-neutral DOCX document type
├── cloudflare-sdk/        @unidocs/cloudflare-sdk        — Durable Object runtime factories
├── cloudflare-gateway/    @unidocs/cloudflare-gateway    — Cloudflare API Gateway
└── cloudflare-markdown/   @unidocs/cloudflare-markdown   — Cloudflare Markdown deployment
```

## API

All endpoints go through the Gateway. Document type is determined by URL path.

### Document lifecycle

```
POST   /{docType}/                              → create document (multipart/form-data)
GET    /{docType}/{docId}/export                → download document (binary)
POST   /{docType}/{docId}/query                 → query document → { data, version }
POST   /{docType}/{docId}/apply                 → apply delta → { version }
GET    /{docType}/{docId}/history               → get delta history
POST   /{docType}/{docId}/rollback              → rollback to version
POST   /{docType}/{docId}/run                   → Operator ReAct loop
POST   /{docType}/{docId}/reset                 → reset Operator session
```

### Create document

```
POST /{docType}/
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
4. R2 CAS ensures no duplicate storage

### Query

```
POST /{docType}/{docId}/query
Content-Type: application/json

{ "kind": "...", "payload": {...} }

Response: { success: true, data: any, version: number }
```

Every query response includes the current document version.

### Apply (delta)

```
POST /{docType}/{docId}/apply
Content-Type: application/json

{
  "operations": [ { "kind": "...", "payload": {...} }, ... ],
  "description": "human-readable description",
  "baseVersion": 42
}

Response: { success: true, version: 43 }
```

**Optimistic locking**: `baseVersion` must match current version. Returns `409` on conflict.

**Transactional**: all operations in a delta succeed or fail together. If any operation throws, the entire delta is rejected.

### Rollback

```
POST /{docType}/{docId}/rollback
Content-Type: application/json

{ "version": 10 }

Response: { success: true, version: 43 }
```

Rollback implementation:
1. Find nearest snapshot ≤ target version (from sqlite snapshots table)
2. Load snapshot from R2
3. Replay deltas from snapshot version to target version
4. Insert rollback as a synthetic delta (new version, empty operations)

### Operator (AI agent interface)

```
POST /{docType}/{docId}/run
Content-Type: application/json

{ "instruction": "natural language task description" }

Response: { success: true, data: { response: string, iterations: number } }
```

Operator behavior:
- Maintains conversation history
- `query_*` tools return `{ data, version }` — version is tracked internally
- `apply_*` tools require a known version (must query first)
- On `409` conflict, error includes `currentVersion` and retry hint
- Max 10 iterations per run (configurable)

```
POST /{docType}/{docId}/reset

Response: { success: true }
```

Clears conversation history and version tracking.

## Adding a document type

1. Create a cloud-neutral package: `packages/doctype-mytype/`
2. Export a configured `DocumentType` factory:

```typescript
import type { DocumentTypeFactory } from "@unidocs/core";

export interface MytypeOptions {
  renderPage(page: number): Promise<string>;
}

export const createMytypeDocumentType:
  DocumentTypeFactory<MytypeOptions, MyDocument, MyQuery, MyOperation> =
  options => ({
    init: ...,
    query: ...,
    apply: ...,
    load: ...,
    save: ...,
    tools: ...,
    instructions: ...,
  });
```

3. Create a separate Cloudflare adapter package and use the runtime factories:

```typescript
import { createEditorDO, createOperatorDO } from "@unidocs/cloudflare-sdk";
import { createMytypeDocumentType } from "@unidocs/doctype-mytype";

const mytype = createMytypeDocumentType(options);

export const MytypeEditor = createEditorDO(mytype);
export const MytypeOperator = createOperatorDO({
  ...mytype,
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

[[r2_buckets]]
binding = "CAS"
bucket_name = "unidocs-cas"
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

## Development

```bash
pnpm install
pnpm dev
```

Starts gateway (`:8787`), markdown (`:8788`), and docx (`:8789`) in one Miniflare process with shared D1/R2. The KV registry is seeded with each worker's URL:

```
POST http://127.0.0.1:8787/users/{userId}/markdown/
POST http://127.0.0.1:8787/users/{userId}/docx/
```

## Infrastructure

- **Cloudflare Workers** — runtime
- **Durable Objects** — per-document state + isolation
- **D1** — shared snapshot index (SQLite-compatible)
- **R2** — content-addressed snapshot storage
- **KV** — per-DO metadata + snapshot cache

## Roadmap

See [open issues](https://git.shazhou.work/shazhou/unidocs/issues) for upcoming work.

## License

TBD
