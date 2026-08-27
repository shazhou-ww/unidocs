# CAS Worker Split and DOCX insertImage Implementation Plan

> **Superseded CAS contract (2026-08-26):** This is a historical implementation
> record. Owner assignments, portable-node HTTP, shared keys, tenantless routes,
> and tenant-only CAS namespaces are not current guidance. See
> [CAS Middleware](./2026-08-26-cas-middleware.md) and
> [CAS Architecture](../../cas-architecture.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move user-scoped CAS into `packages/cloudflare-cas`, connect Gateway and document workers via `CAS_SERVICE`, wire Editor apply to architecture §13, and add DOCX `insertImage` / `getImages`.

**Architecture:** CAS worker owns the Durable Object, D1, and R2. Gateway allowlist-proxies public CAS HTTP. Editors call CAS through a service binding with `X-Internal-Token` + `X-User-Id`. `insertImage` stores a CAS hash in the delta; apply reads bytes and embeds them in the DOCX.

**Tech Stack:** Cloudflare Workers, service bindings, Miniflare, `@unidocs/cas`, `@ariadng/office` `addImage` / `images()`, Vitest, treespec.

**Spec:** `docs/superpowers/specs/2026-08-19-cas-worker-and-docx-images-design.md`

## Global Constraints

- Public CAS paths stay under `/users/{userId}/cas/` and go through Gateway only.
- CAS worker requires `X-Internal-Token` on every request; it never reads end-user Bearer.
- `updateRootRefs` is `POST /_internal/root-refs` and is not Gateway-proxied.
- Document-snapshot R2 binding remains named `CAS`; the service binding is `CAS_SERVICE`.
- `refsFromSnapshot` for DOCX stays `{}`.
- Replay / rollback / load / query / clone must not call `leaseExisting` or `updateRootRefs`.
- bun/pnpm on Windows: do not use bun cache; PowerShell paths.

## File map

| Path | Role |
|------|------|
| `packages/cloudflare-cas/` | New worker: DO, routes, schema, fetch handler |
| `packages/cloudflare-gateway/src/worker.ts` | Proxy allowlisted CAS routes to `CAS_SERVICE` |
| `scripts/doc-types.mjs` | Bundle + Miniflare worker for `unidocs-cas`; bind `CAS_SERVICE` |
| `packages/cloudflare-sdk/src/cas-client.ts` | Service-binding mode + `updateRootRefs` |
| `packages/cloudflare-sdk/src/editor-do.ts` | Apply §13; pass `DocumentTypeContext` on load/apply/query |
| `packages/doctype-docx/` | `insertImage`, `getImages`, `refsFromOp` |
| `packages/cloudflare-docx/wrangler.toml` | `CAS_SERVICE` |
| `packages/cloudflare-markdown/wrangler.toml` | `CAS_SERVICE` |
| `docs/cas-architecture.md` | §11, §13, §16 |
| `tests/bootstrap/create-new-docx/edit/` | treespec for insertImage |

---

### Task 1: CAS worker package

Move Gateway CAS modules into `@unidocs/cloudflare-cas`. Worker `fetch`:

1. Reject missing/wrong `X-Internal-Token` with 401.
2. `POST /_internal/root-refs` → DO `/updateRootRefs` with `X-User-Id`.
3. Else `isCasRoute` → existing `handleCasRequest`.
4. Run `migrateCasSchema` before handling.

Keep `cas-server.test.ts` against the DO. Add worker-level tests for 401 and that `/_internal/root-refs` exists.

Remove `packages/cloudflare-gateway/src/cas/` after the move. Gateway package.json drops `@unidocs/cas` until Task 2 if unused.

Verify: `pnpm --filter @unidocs/cloudflare-cas test`

### Task 2: Gateway proxy + Miniflare

Gateway `CAS_PUBLIC` allowlist only:

- `GET .../nodes/{hash}/content|metadata`
- `POST .../nodes/{hash}`
- `POST .../nodes/{hash}/lease`
- `GET .../usage`
- `POST .../gc`

Forward to `env.CAS_SERVICE.fetch(request)` after setting `X-Internal-Token` and `X-User-Id`. Unknown CAS paths (including `root-refs`) → 404.

`scripts/doc-types.mjs`:

- Always bundle `packages/cloudflare-cas/src/worker.ts` → `cas.js`
- Add worker `unidocs-cas` with `CAS_DO`, `CAS_DB`, `CAS_R2`, `INTERNAL_TOKEN`; no public socket
- Gateway: drop `CAS_DO`/`CAS_DB`/`CAS_R2`; add `serviceBindings: { CAS_SERVICE: "unidocs-cas" }`
- Doc workers: add the same `serviceBindings` and `INTERNAL_TOKEN` (already present)

`bundleTargets` always includes cas.js even when no doc types are selected (Gateway still proxies CAS).

Verify: `pnpm exec vitest run scripts/doc-types.test.mjs scripts/cas-e2e.test.mjs`

### Task 3: CasClient Editor mode

```ts
export type CasClientConfig =
  | { baseUrl: string; userId: string; authToken?: string }
  | { fetcher: Fetcher; userId: string; internalToken: string };
```

Internal mode sets `X-Internal-Token` and `X-User-Id` on every call. `updateRootRefs` posts to `/_internal/root-refs`. Public mode has no `updateRootRefs` (or throws if called).

Verify: `pnpm --filter @unidocs/cloudflare-sdk test`

### Task 4: EditorDO apply wiring

Extend `EditorEnv` with `CAS_SERVICE: Fetcher` and `INTERNAL_TOKEN: string`.

Helper `casContext(request)`: require `X-User-Id`, return `{ cas: new CasClient({ fetcher, userId, internalToken }) }`.

Apply path: aggregateRefs → leaseExisting each hash → `config.apply(ops, doc, ctx)` → insert delta → `updateRootRefs({ requestId: \`apply:${userId}:${docId}:${version}\`, changes })` → then commit memory + KV. On root-refs failure delete the new delta row.

Pass `ctx` into `load`/`apply`/`query` on replay, rollback, create, clone. Do not lease or updateRootRefs there.

Empty `refsFromOp` (markdown, current docx) is a no-op for steps 2 and 6.

Verify: SDK unit tests with a mock Fetcher; existing markdown/docx e2e still pass.

### Task 5: DOCX insertImage + getImages

Types, `refsFromOp`, `ops/image-ops.ts`, queries, tools, instructions.

`insertImage` validates hash, `cas.read`, `document.addImage(bytes, { widthPx, altText })`.

`getImages` maps `document.images()`.

Verify: `pnpm --filter @unidocs/doctype-docx test`

### Task 6: Treespec + architecture docs

DOCX edit child (or new `image` branch): upload 1×1 PNG via CAS digest helper, apply `insertImage`, query `getImages`.

Update `docs/cas-architecture.md` §11, §13, §16.

Verify: `treespec run bootstrap/create-new-docx` covering the new steps (or the image child only plus ancestors).

---

Each task ends with tests green and a commit.
