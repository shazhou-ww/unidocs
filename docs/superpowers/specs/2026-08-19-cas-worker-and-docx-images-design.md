# CAS worker split and DOCX insertImage

Status: accepted design (2026-08-19)

Extracts user-scoped CAS from the Gateway into its own Worker so document Editors can call CAS without hairpinning through the public Gateway. Wires `EditorDO` apply to architecture §13. Adds the first CAS-backed DOCX operation: `insertImage` plus `getImages`. Updates [CAS Architecture](../../cas-architecture.md) sections 11–13 and 16.

## Decision

Public clients keep talking to Gateway. CAS storage and the per-user Durable Object live in a dedicated CAS worker. Gateway and every document-type worker depend on that CAS worker via **service bindings**. CAS depends on nobody. Document Editors never `fetch` the Gateway.

This avoids a Gateway ↔ Editor cycle and keeps future Bearer checks on Gateway only. CAS trusts `X-Internal-Token` + `X-User-Id`, never an end-user Bearer.

## Topology

```text
Client
  └── Gateway
        ├── CAS worker          public /users/{userId}/cas/* (allowlisted)
        └── DOCX / Markdown worker
              └── CAS worker    service binding (read, leaseExisting, updateRootRefs)
```

Dependencies are one-way: Gateway → {CAS, doctypes}; doctypes → CAS.

## Workers and bindings

New package `packages/cloudflare-cas` owns:

- `CasDurableObject`
- D1 `CAS_DB` and R2 `CAS_R2`
- HTTP handler for public CAS routes and internal `updateRootRefs`
- schema migration

Gateway **loses** `CAS_DO`, `CAS_DB`, and `CAS_R2`. It gains service binding `CAS_SERVICE` (`Fetcher`). It allowlist-proxies public CAS routes and injects `X-Internal-Token` plus `X-User-Id` from the path.

DOCX and Markdown workers gain the same `CAS_SERVICE` binding. They keep the existing R2 binding named `CAS` (document snapshot blobs). That name stays; the service binding must not reuse it.

Local Miniflare starts `unidocs-cas` alongside Gateway and the selected document-type workers. CAS has no public socket. Treespec and e2e keep hitting Gateway `:8787`.

## Auth

| Hop | Identity | Proof |
|-----|----------|--------|
| Client → Gateway | path `userId` | future Bearer must equal that userId |
| Gateway → CAS | `X-User-Id` from path | `X-Internal-Token` |
| Editor → CAS | `X-User-Id` from the apply request | `X-Internal-Token` |
| Anyone → CAS worker | — | missing/wrong internal token → `401` |

CAS never inspects `Authorization`. Gateway never forwards `updateRootRefs`.

## CAS HTTP surface

Public routes (unchanged; Gateway allowlist only):

```
GET  /users/{userId}/cas/nodes/{hash}/content
GET  /users/{userId}/cas/nodes/{hash}/metadata
POST /users/{userId}/cas/nodes/{hash}
POST /users/{userId}/cas/nodes/{hash}/lease
GET  /users/{userId}/cas/usage
POST /users/{userId}/cas/gc
```

Internal (CAS worker only, not proxied):

```
POST /_internal/root-refs
X-Internal-Token: ...
X-User-Id: {userId}
Content-Type: application/json

{ "requestId": "...", "changes": { "<hash>": 1 } }
```

Gateway must not proxy unknown `/users/{userId}/cas/...` paths. A public `POST .../root-refs` is a spec bug.

## Editor apply

`createEditorDO` builds a `CasClient` per request from `env.CAS_SERVICE`, `env.INTERNAL_TOKEN`, and `X-User-Id`. Missing user id → `401`.

### New delta (`POST /_internal/apply`)

Follow architecture §13. Do not commit in-memory doc/version until root-refs succeed.

1. Optimistic lock on `baseVersion`.
2. `aggregateRefs(operations, refsFromOp)`.
3. For each hash, `leaseExisting`. Not found → fail apply (`404` from CAS → Editor `400`). Not ready → fail apply (`409`).
4. `apply(operations, doc, { cas })` where `cas` is the `CasReadContext`.
5. Insert the delta row (source of truth).
6. `updateRootRefs` with `requestId = apply:{userId}:{docId}:{version}` and the aggregated positive counts.
7. On success: set in-memory doc/version, write KV snapshot, maybe R2 document snapshot.
8. On step 6 failure: `DELETE` the new delta row, discard the working document, leave version unchanged. Residual: delta delete also fails (architecture §13).

`refsFromOp` never uploads. Clients `POST` lease-with-content before apply.

### Replay, rollback, load, query, clone

Pass `{ cas }` so `insertImage` can `cas.read` during replay. Do **not** call `leaseExisting` or `updateRootRefs`. Root counts change only on persist/retention.

## `CasClient`

Keep the public helper (Gateway `baseUrl` + optional Bearer) for tests and external callers.

Add an Editor mode:

- `fetch` is `env.CAS_SERVICE`
- every request sets `X-Internal-Token` and `X-User-Id`
- `read` / `metadata` / `leaseExisting` use the public path shape on the CAS worker
- new `updateRootRefs(update)` → `POST /_internal/root-refs`

## DOCX image ops

```ts
{ kind: "insertImage"; payload: { hash: string; widthPx?: number; altText?: string } }
{ kind: "getImages"; payload: undefined }
```

`insertImage` appends an inline image at the end of the document via `@ariadng/office` `Document.addImage`. PNG/JPEG are sniffed from magic bytes. Invalid hash syntax fails before CAS. Non-image bytes fail in `addImage` and fail the delta.

`refsFromOp("insertImage")` → `{ [hash]: 1 }`. Other ops stay `{}`.

`refsFromSnapshot` stays `{}`. The saved DOCX embeds image bytes; snapshots do not retain source CAS nodes.

`getImages` returns `document.images()` as JSON (index, format, partName, width/height as exposed by office). It does **not** return a `CasRef`; the live document no longer stores the CAS hash.

Client loop: `POST /users/{userId}/cas/nodes/{hash}` with the image bytes, then `apply` `insertImage`.

Tools/instructions: expose `insertImage` and `getImages`. The operator is expected to already have a hash (upload is not a document tool).

## Testing

- Unit: `refsFromOp` for `insertImage`; `insertImage` with a fake `CasReadContext`; Editor apply mocks `leaseExisting` then `updateRootRefs`; compensating delta delete when root-refs fail.
- Gateway: public CAS proxy allowlist; `/_internal/root-refs` is not reachable via Gateway.
- E2E / treespec (DOCX branch): upload a 1×1 PNG to CAS, create a doc, `apply insertImage`, `query getImages` has one entry, `export` is a non-empty docx.

## Architecture doc

- §11: Gateway proxies allowlisted CAS HTTP; CAS worker owns the DO.
- §13: Editor uses `CAS_SERVICE`, not Gateway HTTP.
- §16: remove “CAS-backed DOCX image operations” from deferred; first image op is `insertImage`.

## Out of scope

- Bearer binding to path `userId`
- Replace / delete / resize / floating images
- Header/footer images
- Returning `CasRef` from queries
- History truncation and root-ref decrements
- Automatic GC scheduling
- Renaming the legacy document-snapshot R2 binding (`CAS`)
