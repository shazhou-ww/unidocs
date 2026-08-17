# UniDocs

**Universal Docs** — online document editing tools for AI agents.

UniDocs provides a framework for building document-type-specific editing infrastructure that AI agents can interact with programmatically. Each supported document type exposes two layers:

## Architecture

For each document type, a single document instance is backed by two Cloudflare Durable Objects:

### Document Editor (DO)
Pure code logic — **no LLM**. Manages document state with full integrity.

- **TQuery**: Read document content slices via structured query objects
- **TOperation**: Apply edits via structured operation objects
- **History**: Built-in version tracking, snapshot, and rollback
- **Batching**: Supports scripted batch processing of TQuery/TOperation (future)

### Document Operator (DO)
Agent wrapper on top of the Editor. One Operator per document instance = one agent session.

- Holds all Editor TQuery/TOperation as tools
- Carries document-type-specific operational knowledge as prompts
- Runs ReAct loop to decompose and fulfill complex edit instructions
- Isolates implementation details from the calling (main) agent

## Usage

The main agent can interact with documents at two levels:

1. **Lightweight** — Call Editor directly for simple reads/writes
2. **Complex** — Route through Operator for multi-step, context-aware operations

## Packages

| Package | Description |
|---------|-------------|
| `@unidocs/core` | TQuery/TOperation type contracts, history types, abstract Editor |
| `@unidocs/do-editor` | Base Editor Durable Object — HTTP routing, state, history |
| `@unidocs/do-operator` | Base Operator Durable Object — ReAct loop, tool management |

## Adding a Document Type

1. Define TQuery/TOperation types extending core interfaces
2. Implement Editor by extending `EditorDO` with query/apply logic
3. Implement Operator by extending `OperatorDO` with tools + prompts
4. Deploy as Cloudflare Workers with DO bindings

## Development

```bash
pnpm install
pnpm build
pnpm test
```
