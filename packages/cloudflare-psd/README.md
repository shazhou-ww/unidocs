# @unidocs/cloudflare-psd

Thin Cloudflare deployment adapter for the PSD image document type. Wires
`@unidocs/doctype-psd` into UniDocs Durable Objects.

- **Implementation & design live in [`@unidocs/doctype-psd`](../doctype-psd)** —
  this package contains no editing logic, only the worker glue.
- `src/worker.ts` exports the `PsdEditor` / `PsdOperator` Durable Objects
  (built from the DocumentType via `createEditorDO` / `createOperatorDO`) and
  routes Gateway requests to them.
- `wrangler.toml` declares the DO bindings + shared D1/R2.

That's the whole package. All model, `load`/`save`/`apply`/`query`, tools, and
instructions are in `doctype-psd`.
