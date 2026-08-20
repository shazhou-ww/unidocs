# @unidocs/doctype-psd

Cloud-neutral PSD image document type for UniDocs — lets an agent edit and
re-generate images as replayable operations, persisted as PSD.

- **Full design:** [`docs/design.md`](./docs/design.md) (v0.3)
- **Implementation:** `src/doctype.ts` — a `DocumentType<PsdDoc, PsdQuery, PsdOp>`.
  The document model aligns strictly with Adobe PSD semantics (blend keys,
  adjustment layer keys, layer record fields). Bridges to PSD bytes via `ag-psd`.

This package has no Cloudflare/platform dependencies. The deployment adapter that
wires it into Durable Objects lives in `@unidocs/cloudflare-psd`.

## What the platform gives us (we do NOT build these)

version / delta history / snapshots / rollback / optimistic locking / the agent
(Operator) ReAct loop — all from UniDocs. We only implement the seven
`DocumentType` members.

## Status

Scaffold. `load` / `save` / `apply` / `query` are stubs.

**Next step — DO-runtime spike (design §9):** confirm `ag-psd` can read/write PSD
inside the Workers/DO runtime (likely via `readPsd({ useImageData: true })` to
avoid `node-canvas`; pick a pixel/render approach that runs on Workers) before
implementing the document type for real.

## Open decisions (design §9)

1. Pixel carrying: inline bytes (MVP) vs R2 blob refs injected via factory options.
2. Render engine: node-canvas / canvaskit-wasm / sharp — must run on Workers.
