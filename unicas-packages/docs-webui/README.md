# @unicas/docs-webui

Public UniCAS documentation site containing Markdown guides and the Admin and Tenant API references.

The package owns presentation only:

- guide content and navigation;
- Scalar tag grouping and operation ordering;
- the public documentation theme and responsive layout;
- build-time consumption of protocol-owned OpenAPI JSON.

The protocol packages remain the source of truth for routes, schemas, field descriptions, errors, and generated OpenAPI. This package does not use Admin sessions, tenant capabilities, service bindings, or storage bindings.

## Develop

```text
pnpm dev unicas-docs
```

The default local URL is `http://127.0.0.1:4071`.

## Validate

```text
pnpm --filter @unicas/docs-webui typecheck
pnpm --filter @unicas/docs-webui test
pnpm --filter @unicas/docs-webui build
```

The build refreshes both protocol OpenAPI files before emitting `dist/`.

## Deploy

Deployment configuration belongs to `stacks/unicas-docs`:

```text
pnpm stack:deploy unicas-docs --dry-run
pnpm stack:deploy unicas-docs
pnpm smoke unicas-docs
```

Production is published independently at `https://unicas-docs.shazhou.work`.
