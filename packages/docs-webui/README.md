# @unidocs/docs-webui

Shared public product documentation portal. UniCAS guides and Admin/Tenant API references are published under `/unicas`; UniDocs Admin guides and the `@unidocs/protocol-admin-portal` reference are published under `/unidocs`.

The package owns presentation only:

- guide content and navigation;
- Scalar tag grouping and operation ordering;
- the public documentation theme and responsive layout;
- build-time consumption of protocol-owned OpenAPI JSON.

The protocol packages remain the source of truth for routes, schemas, field descriptions, errors, and generated OpenAPI. This package does not use Admin sessions, tenant capabilities, service bindings, or storage bindings.

## Develop

```text
pnpm dev docs
```

The default local URL is `http://127.0.0.1:4071`.

## Validate

```text
pnpm --filter @unidocs/docs-webui typecheck
pnpm --filter @unidocs/docs-webui test
pnpm --filter @unidocs/docs-webui build
```

The build refreshes the two UniCAS protocol documents and the UniDocs Admin Portal protocol document before emitting `dist/`.

## Deploy

Deployment configuration belongs to `stacks/docs`:

```text
pnpm stack:deploy docs --dry-run
pnpm stack:deploy docs
pnpm smoke docs
```

Production is published independently at `https://docs.shazhou.work`; the UniCAS section begins at `/unicas`.
