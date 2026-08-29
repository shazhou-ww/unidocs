# UniDocs

Universal document editing framework for AI agents. Built on Cloudflare Workers + Durable Objects.

## Design documents

- [Microservice Architecture](docs/microservice-architecture.md) — service ownership, identity translation, static registration, and deployment boundaries
- [CAS Architecture](docs/cas-architecture.md) — tenant-scoped storage, leases, reference counts, GC, APIs, and DocumentType integration
- [CAS Binary Format](docs/cas-binary-format.md) — canonical SHA-256 Merkle DAG node encoding derived from CASFA
- [CAS Control-Plane MCP](docs/cas-control-plane-mcp.md) — OAuth-protected GitHub Copilot operations tools and deployment

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
├── protocol-doc/          @unidocs/protocol-doc          — Doc HTTP routes, wire contracts, and errors
├── protocol-gateway/      @unidocs/protocol-gateway      — Gateway HTTP routes and pass-through contracts
├── service-auth/          @unidocs/service-auth          — Capability claims, permissions, issuance, and verification
├── svalue-codec/          @unidocs/svalue-codec          — SValue/SBlob codec + protocol helpers
├── gateway-common/        @unidocs/gateway-common        — Cloud-neutral API Gateway routing
├── doctype-server-common/ @unidocs/doctype-server-common — Cloud-neutral doctype 服务公共实现 (session/ports/operator)
├── doctype-markdown/      @unidocs/doctype-markdown      — Cloud-neutral Markdown document type
├── doctype-docx/          @unidocs/doctype-docx          — Cloud-neutral DOCX document type
├── doctype-psd/           @unidocs/doctype-psd           — Cloud-neutral PSD image document type
├── psd-client/            @unidocs/psd-client            — Browser-side PSD render client
├── cloudflare-sdk/        @unidocs/cloudflare-sdk        — Durable Object runtime factories
├── cloudflare-gateway/    @unidocs/cloudflare-gateway    — Cloudflare API Gateway
├── cloudflare-markdown/   @unidocs/cloudflare-markdown   — Cloudflare Markdown deployment
├── cloudflare-docx/       @unidocs/cloudflare-docx       — Cloudflare DOCX deployment
├── cloudflare-psd/        @unidocs/cloudflare-psd        — Cloudflare PSD deployment
├── azure-sdk/             @unidocs/azure-sdk             — Azure (Postgres + Blob) storage adapters
├── azure-gateway/         @unidocs/azure-gateway         — Azure/Node API Gateway
├── azure-markdown/        @unidocs/azure-markdown        — Azure/Node Markdown service
├── azure-docx/            @unidocs/azure-docx            — Azure/Node DOCX service
└── web-psd/               @unidocs/web-psd               — PSD dev frontend (Vite)

unicas-packages/           (the independently deployable CAS middleware; future standalone monorepo)
                           boundary/naming rules in unicas-packages/README.md
├── codec/                 @unicas/codec                 — CAS wire encodings: canonical node binary format, digest, streaming parse, validation limits
├── tenant-protocol/       @unicas/tenant-protocol       — Tenant data-plane CAS HTTP contracts: types/routes + capability claims
├── tenant-client/         @unicas/tenant-client         — Node-level CAS HTTP client (1:1 with routes, no encoding)
├── tenant-blob-client/    @unicas/tenant-blob-client    — Blob layer: chunked writes, handle-style random reads, usage/gc
├── server-cloudflare/     @unicas/server-cloudflare     — Canonical stack-scoped tenant server (Cloudflare)
├── admin-protocol/        @unicas/admin-protocol        — CAS control-plane contracts
├── control-plane/         @unicas/control-plane         — CAS control plane service (issuers/stacks/members/sessions)
├── control-auth/          @unicas/control-auth          — Shared server-only control-plane OIDC client
├── control-plane-mcp/     @unicas/control-plane-mcp     — OAuth-protected remote MCP operations ingress
├── admin-webui/           @unicas/admin-webui           — Stack administration WebUI + OIDC BFF
├── admin-cli/             @unicas/admin-cli             — Stack administration CLI + stdio MCP (bin `unicas`)
└── edge/                  @unicas/edge                  — Public CAS edge (/stacks + /admin + MCP/OAuth dispatch)
```

## API

All end-user endpoints go through Gateway under `/tenants/{tenantId}/...`.
Gateway authenticates the user, authorizes tenant membership, and never forwards
end-user credentials or `userId` downstream. Doc calls use a private `sessionId`;
CAS calls use `tenantId`. The path-based development resolver is disabled unless
`INSECURE_PATH_IDENTITY=true` is explicitly configured. Legacy `/users/*` routes
are rejected.

See [Doc Service HTTP Protocol](docs/doc-service-http-protocol.md) for the full
Gateway, Doc edge, adapter-internal, capability, SValue, and error contracts.

### Document lifecycle

```
POST   /tenants/{tenantId}/docs/{docType}/                              → create document (multipart/form-data)
GET    /tenants/{tenantId}/docs/{docType}/                              → list documents
GET    /tenants/{tenantId}/docs/{docType}/{docId}                       → get create/status state
GET    /tenants/{tenantId}/docs/{docType}/{docId}/export                → download document (binary)
POST   /tenants/{tenantId}/docs/{docType}/{docId}/query                 → query document → { data, version }
POST   /tenants/{tenantId}/docs/{docType}/{docId}/apply                 → apply delta → { version }
GET    /tenants/{tenantId}/docs/{docType}/{docId}/history               → get delta history
POST   /tenants/{tenantId}/docs/{docType}/{docId}/rollback              → rollback to version
GET    /tenants/{tenantId}/docs/{docType}/{docId}/snapshot              → get retained snapshot root
GET    /tenants/{tenantId}/docs/{docType}/{docId}/ir                    → get canonical SValue document IR
POST   /tenants/{tenantId}/docs/{docType}/{docId}/init_from_hash        → initialize clone target
POST   /tenants/{tenantId}/docs/{docType}/{docId}/run                   → Operator ReAct loop
POST   /tenants/{tenantId}/docs/{docType}/{docId}/reset                 → reset Operator session
```

### CAS

The public Gateway ingress currently exposes this allowlisted subset:

```
GET    /tenants/{tenantId}/cas/nodes/{hash}/content    → read node bytes
GET    /tenants/{tenantId}/cas/nodes/{hash}/metadata   → read metadata + state
POST   /tenants/{tenantId}/cas/nodes/{hash}            → lease with content
POST   /tenants/{tenantId}/cas/nodes/{hash}/lease      → extend a ready node
GET    /tenants/{tenantId}/cas/usage                   → storage usage
POST   /tenants/{tenantId}/cas/gc                      → tenant-admin GC
```

These are ingress paths, not the native middleware contract. Native CAS routes
include `/stacks/{stackId}/tenants/{tenantId}/...`; the registered issuer and
signed tenant claim must match that path. Root Ref writes are a native CAS
service operation but are absent from the Gateway allowlist. Usage and GC
require tenant-administration authorization at Gateway.

See [CAS Architecture](docs/cas-architecture.md) for lease-with-content and lease-extend.

### Create document

```
POST /tenants/{tenantId}/docs/{docType}/
Content-Type: multipart/form-data

Fields (mutually exclusive):
- file: binary file to initialize from
- sourceId: existing document ID to clone from
- (empty): create empty document

Ready response: { success: true, docId: string, state: "ready", version: 1 }
Uncertain in-progress response (HTTP 202): { success: true, docId: string, state: "creating" }
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
tools may accept explicit uploaded hashes; the tool's `toOps` turns a hash into
an SBlob synchronously (`createSBlob`, see
`packages/doctype-docx/tests/agent.test.ts`) as it builds the op, before typed
apply and persistence. Direct `/apply` never performs this conversion.

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
- Agent apply reads the current head version itself (`GET /_internal/status`) as its baseVersion; the agent does not track a version
- Structured results are JSON; optional media content is rendered by the model-provider adapter
- On `409` conflict, error includes `currentVersion` and retry hint
- Max 10 iterations per run (configurable)

```
POST /tenants/{tenantId}/docs/{docType}/{docId}/reset

Response: { success: true }
```

Clears conversation history.

## Adding a document type

1. Create a cloud-neutral package: `packages/doctype-mytype/`
2. Export a context-curried `DocumentType` factory. Optional doctype settings
  belong in an outer function (`Options -> Context -> DocumentType`), not in
  the core factory generic:

```typescript
import type { DocumentAgent, DocumentTypeFactory } from "@unidocs/protocol";

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

// The agent is a constant, not a factory: a plain table of tools plus the
// system prompt. Each tool says whether it reads or writes and turns the
// model's arguments into a query or a batch of operations with a pure
// function. The document type never touches the editor, an LLM, or a CAS —
// the kernel (AgentSession) is the only caller of the platform.
export const mytypeAgent: DocumentAgent<MyQuery, MyOperation> = {
  instructions: ...,
  tools: [
    {
      kind: "query",
      name: "getSomething",
      description: ...,
      inputSchema: { type: "object", properties: { ... } },
      toQuery: args => ({ kind: "getSomething", payload: args }),
      // Optional. Omit it and the kernel wraps {data, version} as JSON.
      // A tool that returns a picture or a file must supply it and emit an
      // image/file content part.
      toResult: (data, version) => ({ structuredContent: ... }),
    },
    {
      kind: "op",
      name: "doSomething",
      description: ...,
      inputSchema: { type: "object", properties: { ... } },
      toOps: args => [{ kind: "doSomething", payload: args }],
    },
  ],
};
```

3. Create a separate Cloudflare adapter package and use the runtime factories:

```typescript
import { createEditorDO, createOperatorDO } from "@unidocs/cloudflare-sdk";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";
import { createMytypeDocumentType, mytypeAgent } from "@unidocs/doctype-mytype";

export const MytypeEditor = createEditorDO(createMytypeDocumentType);
export const MytypeOperator = createOperatorDO({
  agent: mytypeAgent,
  provider: (env: Env) => createAnthropicProvider(env),
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
   - New `packages/azure-mytype/` (`package.json`, `tsconfig.json`, `src/main.ts`, `scripts/bundle.mjs`) — copy either existing `packages/azure-*` package as the template, they're equivalent now: every `bundle.mjs` in the repo uses the same explicit `EXTERNAL_NPM_PACKAGES` list (from `scripts/workspace-aliases.mjs`) instead of esbuild's `packages: "external"`, which matters the moment your doc type pulls in a real (non-`@unidocs/*`) npm dependency that isn't also a root `package.json` devDependency — `packages: "external"` would leave that import unresolvable at runtime. `tests/unit/scripts/bundle-deps.test.mjs` enforces this choice repo-wide, so a new `bundle.mjs` that reaches for `packages: "external"` fails that test rather than only failing at runtime. `src/main.ts` should differ from an existing entry by nothing but the doc type string and the default port; if it needs more than that, the gap belongs in `@unidocs/azure-sdk`, not in the entry point. Also add an `azure.service.json` declaring `docType`, `targetPort`,
     `localPortBase` (at least `AZURE_PORT_STRIDE` past the last one), `minReplicas`,
     `maxReplicas` and `needsCas`. Everything else — local ports, the dev stack's
     supported list, the deploy script's images and secrets, and the Bicep templates —
     expands from that one file, with one exception: `stacks/unidocs-azure/deploy/smoke.mjs` still
     needs a hand-written `<docType>Flow()` function for the new doc type. Forgetting it
     doesn't fail silently — `tests/unit/workspace/doc-type-coverage.test.mjs` asserts every
     Azure doc type has a matching `Flow()` in `smoke.mjs` and goes red if one is missing.
   - Add `{ "path": "packages/azure-mytype" }` to the root `tsconfig.json`'s `references`.
   - Provision a service-owned database and migration job, then include its URL
     and exact capability audience in Gateway's static registry.

## Development

```bash
pnpm dev                                        # local Gateway/Docs + local UniCAS
pnpm dev docx                                   # DOCX only
pnpm dev docx markdown                          # explicit Doc type selection
pnpm dev --cas remote                           # deployed UniCAS edge instead
pnpm dev unidocs-cloudflare --docker            # run the local stack in Compose
```

The stack name may be omitted: `pnpm dev` alone means
`pnpm dev unidocs-cloudflare`. A first positional argument that is not a known
stack (`docx`, `--cas`, …) belongs to the stack, so it is forwarded unchanged.
`deploy` and `smoke` never guess — they still require an explicit stack.

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
pnpm dev unidocs-azure              # Gateway :41787 + Docs + local UniCAS
pnpm dev unidocs-azure markdown     # Markdown only
pnpm dev unidocs-azure --cas remote # deployed UniCAS edge instead
```

Docker must be running for Postgres on `:5433`. Azurite runs as a Node child
process on `:10000`. Startup creates and migrates independent
`unidocs_gateway`, `unidocs_markdown`, and `unidocs_docx` databases; replicas
of one Doc service share only that service's database and Blob containers.

Interactive development defaults to an embedded ephemeral UniCAS, so a fresh
clone starts with nothing configured. `--cas remote` switches to a UniCAS edge
and requires a registered stack credential at `.wrangler/unidocs/stack.json`;
`UNIDOCS_CAS_ORIGIN` and `UNIDOCS_CAS_STACK_CREDENTIAL` override where those
come from — pointing `UNIDOCS_CAS_ORIGIN` at a locally running `pnpm dev
unicas` exercises the same registered-stack path without the network. Tests
always use the embedded UniCAS.

Migrations run automatically as part of startup — no separate command needed. The Azure ports (gateway `41787`, markdown `41800`s band, docx `41810`s band — see `stacks/unidocs-azure/local/ports.mjs`) are deliberately offset from Miniflare's (`8787`/`8788`/`8789`) so both backends can run side by side. `pnpm dev unidocs-azure` prints a ready-to-use `psql` connection string for Postgres and the Azurite blob endpoint, for poking at storage directly. `Ctrl+C` stops the gateway/doc-type/azurite-blob processes; it does **not** tear down the docker compose Postgres container (the signal handler that would await that teardown loses the race with `stacks/unidocs-azure/local/runtime.mjs`'s own `process.exit()` on the same signal). Run `pnpm azure:down` afterwards to stop and remove it.

**First run only:** if `postgres:18-alpine` isn't cached locally yet, `docker compose up` pulls it (~100 MB) before anything else can start; every run after that is instant. There's no equivalent cost for Azurite — it installed with `pnpm install` like any other dependency.

### Tests

| Command | Coverage |
|---|---|
| `pnpm test` | 各包 `packages/*/tests` 单测 |
| `pnpm test:local` | `tests/unit`（脚本单测）+ `tests/integration/cloudflare` + `tests/integration/shared`（起 Miniflare 的 HTTP） |
| `pnpm test:azure` | `tests/integration/azure`（起本地 Azure 栈的 HTTP，需要 Docker） |
| treespec | `tests/treespec/`（容器里从干净安装跑 YAML 树；镜像见同目录 `Dockerfile`） |

`pnpm test:azure` (via `tests/integration/azure/azure-behavior.test.mjs`) and `pnpm -r test` (via `packages/azure-sdk`'s Vitest `globalSetup`, `packages/azure-sdk/tests/containers.ts`) both bring up the same `packages/azure-sdk/docker-compose.yml` Postgres container (host port `:5433`, unnamed default compose project) and each spawn their own `azurite-blob` process on `:10000`. `pnpm dev unidocs-azure` starts the identical stack for interactive use.

**Do not run `pnpm test:azure`, `pnpm -r test`, and `pnpm dev unidocs-azure` at the same time.** They still share the Postgres container: whichever one tears it down first (`docker compose ... down -v`) pulls the database out from under whichever else is still using it, mid-test or mid-session. They also all bind `:10000` for their own `azurite-blob` process, so a second one starting up simply fails to claim the port. Run them one at a time, or stop `pnpm dev unidocs-azure` before running either test command.

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
(`Failed to resolve entry for package "@unicas/tenant-protocol"`). Pointing the workspace-facing
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
