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

## Development

```bash
pnpm install
pnpm dev
```

Starts gateway (`:8787`), markdown (`:8788`), and docx (`:8789`) in one Miniflare process with shared D1/R2. The KV registry is seeded with each worker's URL:

```
POST http://127.0.0.1:8787/users/{userId}/docs/markdown/
POST http://127.0.0.1:8787/users/{userId}/docs/docx/
```

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
