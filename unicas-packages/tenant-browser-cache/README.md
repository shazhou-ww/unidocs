# @unicas/tenant-browser-cache

Optional browser implementation of `CasNodeCache`. The HTTP client remains
platform-neutral and has no dependency on this package. No server or application
manifest types are imported; the tenant-client dependency is type-only in source.

```ts
import { createTenantCasClient } from "@unicas/tenant-client";
import { createBrowserCasNodeCache, clearBrowserCasNodeCaches } from "@unicas/tenant-browser-cache";

const principal = JSON.stringify([identity.identityIssuer, identity.subject]);
const cache = createBrowserCasNodeCache({
  namespace: { endpoint: casBaseUrl, principal },
  maxBytes: 64 * 1024 * 1024,
  maxMemoryBytes: 8 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
});
const cas = createTenantCasClient({ baseUrl: casBaseUrl, stackId, tenantId, getToken, cache });

// At logout, stop new reads before clearing every endpoint for this principal.
await clearBrowserCasNodeCaches({ principal });
cache.close();
```

## Contract

- Keys include endpoint, authenticated principal, stack, tenant, hash and read kind.
  Use an immutable identity key, never an access token or display email. The endpoint
  must not contain credentials, a query or a fragment.
- Stores only immutable node metadata (`hash`, `size`, `contentType`, `refs`) and
  completely consumed node own-content. Neither mutable node state nor file-root
  working copies, catalog revisions, leases, GC results or usage are persisted.
- Complete content hits return independent streams; range hits slice the full Blob.
  Range misses pass through and are not stored. Reads above the per-entry limit
  discard the bounded buffer and continue streaming. No `tee()` or background drain
  is used. Cancelled/incomplete and failed streams do not populate the cache.
- Only metadata loads without a signal coalesce. Content misses are independent,
  so a slow or abandoned reader cannot block another caller. Pass the optional
  request signal to abort a cache-hit stream too.
- Memory uses per-instance LRU; IndexedDB uses per-endpoint/principal LRU shared by
  that partition's stacks and tenants. Limits count payload bytes, not browser
  storage overhead, and buffering is bounded per concurrent read. Empty content
  counts as one byte. Metadata counts its UTF-8 JSON size.
- IndexedDB unavailable, open blocked for over one second, or a failed storage
  operation falls back to bounded memory/network. Storage failure does not fail a
  successful CAS read. Clearing is likewise best-effort if browser storage fails.
- `clear()` deletes one endpoint/principal partition and invalidates live caches
  and earlier in-flight writes. `clearBrowserCasNodeCaches({principal})` clears all
  endpoints for that principal, including prior page sessions. Other identities
  remain untouched. BroadcastChannel invalidation is best-effort across tabs.
- `close()` releases memory and browser resources, prevents further cache writes,
  and leaves persisted content intact. Call it on owner disposal. When clearing,
  await deletion before closing connections.

## Authorization Boundary

A cache hit does not request a token or check current server permissions. Gate
cache creation/use on successful session discovery, refresh mutable catalogs from
the server, and stop reads at logout. IndexedDB is not an authentication boundary
or encrypted secret store; any same-origin script can access it. Cached bytes do
not prove that a node is still leased, retained, present on the server, or accessible
under current permissions. Use explicit live server operations for those decisions.

Default database: `unicas-node-cache-v1`. `databaseName` can isolate independent
applications/tests; pass the same name to principal-wide clearing.

## Verification

```sh
pnpm --filter @unicas/tenant-browser-cache test
pnpm --filter @unicas/tenant-browser-cache typecheck
```