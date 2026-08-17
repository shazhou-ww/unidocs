# UniDocs

**Universal Docs** — online document editing tools for AI agents.

UniDocs provides a framework for building document-type-specific editing infrastructure that AI agents can interact with programmatically. Each supported document type is defined as a declarative configuration, from which the SDK generates a pair of deployable Cloudflare Durable Objects.

## Architecture

### DocumentType — the ten-tuple contract

Every document type is defined by providing:

**Types:**
- `TDocument` — document's in-memory model
- `TQuery` — query types (discriminated union)
- `TOperation` — operation types (discriminated union)

**Functions:**
- `init: () => TDocument` — create a new empty document
- `query: (q: TQuery, doc: TDocument) => JSON` — read document slices
- `apply: (op: TOperation, doc: TDocument) => TDocument` — mutate document
- `load: (data: Uint8Array) => TDocument` — deserialize from storage
- `save: (doc: TDocument) => Uint8Array` — serialize for storage

**Prompts:**
- `tools: Record<string, AgentToolDefinition>` — tool definitions for the Operator
- `instructions: string` — system prompt with operational knowledge

Given this ten-tuple, the SDK generates a complete Editor + Operator service pair.

### Two-layer service per document instance

Each document instance is backed by two Cloudflare Durable Objects:

#### Document Editor (DO)
Pure code logic — **no LLM**. Manages document state with full integrity.

- HTTP API for executing `TQuery` (read) and `TOperation` (write)
- Built-in version tracking and history log
- Rollback support (snapshot-based)
- Future: batch processing of queries/operations

#### Document Operator (DO)
Agent wrapper on top of the Editor. One Operator = one document instance = one agent session.

- Holds all Editor operations as tools
- Carries document-type-specific operational knowledge
- Runs ReAct loop to decompose and fulfill complex edit instructions
- Isolates implementation details from the calling (main) agent

### Two access levels for the main agent

1. **Lightweight** — call Editor API directly for simple reads/writes
2. **Complex** — route through Operator for multi-step, context-aware operations

## Packages

| Package | Description |
|---------|-------------|
| `@unidocs/sdk` | Types + generic runtime (DocumentType → Editor DO + Operator DO) |
| `@unidocs/markdown` | Markdown document type (first implementation) |

## Adding a new document type

1. Create a new package in `packages/`
2. Define `TDocument`, `TQuery`, `TOperation` types
3. Implement the ten-tuple (init, query, apply, load, save, tools, instructions)
4. Use `createEditorDO(config)` and `createOperatorDO(config)` from `@unidocs/sdk`
5. Deploy as a Cloudflare Worker with DO bindings

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Roadmap

- [ ] Stabilize Editor/Operator HTTP API contracts
- [ ] Implement full snapshot-based rollback
- [ ] SSE streaming for Operator ReAct loop
- [ ] Lightweight client SDK for main agents
- [ ] Scaffold template (`pnpm create @unidocs/doc-type`)
- [ ] Additional document types (spreadsheet, slide, etc.)
