import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";
import { clearBrowserCasNodeCaches, createBrowserCasNodeCache, type BrowserCasNodeCache, type BrowserCasNodeCacheOptions } from "../src/index.js";

const key = { stackId: "stack", tenantId: "tenant", hash: "a".repeat(64) };
const metadata = { hash: key.hash, size: 6, contentType: "text/plain", refs: [] };
const caches: BrowserCasNodeCache[] = [];
let databaseNumber = 0;
function setup(overrides: Partial<BrowserCasNodeCacheOptions> = {}) {
  const options = { namespace: { endpoint: "https://cas.example", principal: "issuer:subject" }, databaseName: `test-cache-${++databaseNumber}`, ...overrides };
  const cache = createBrowserCasNodeCache(options);
  caches.push(cache);
  return { cache, options };
}
const source = (text = "abcdef") => new Blob([text]).stream();
const text = async (stream: Promise<ReadableStream<Uint8Array>>) => new Response(await stream).text();
afterEach(() => { for (const cache of caches.splice(0)) cache.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("persists metadata and complete content across instances with independent range streams", async () => {
  const { cache, options } = setup();
  await cache.metadata(key, async () => metadata);
  expect(await text(cache.read(key, undefined, async () => source()))).toBe("abcdef");
  cache.close();
  const reopened = setup(options).cache;
  const load = vi.fn(async () => source("network"));
  const loadMetadata = vi.fn(async () => metadata);
  expect(await reopened.metadata(key, loadMetadata)).toEqual(metadata);
  expect(await Promise.all([
    text(reopened.read(key, undefined, load)),
    text(reopened.read(key, { offset: 1, length: 3 }, load)),
    text(reopened.read(key, { offset: 4 }, load)),
    text(reopened.read(key, { offset: 99, length: 0 }, load)),
  ])).toEqual(["abcdef", "bcd", "ef", ""]);
  expect(load).not.toHaveBeenCalled();
  expect(loadMetadata).not.toHaveBeenCalled();
  await expect(reopened.read(key, { offset: 6 }, load)).rejects.toThrow("beyond");
});

test("isolates endpoint, principal, stack and tenant, and clones metadata", async () => {
  const { cache, options } = setup();
  const first = await cache.metadata(key, async () => metadata);
  (first.refs as string[]).push("mutated");
  expect((await cache.metadata(key, async () => metadata)).refs).toEqual([]);
  const load = vi.fn(async () => metadata);
  for (const namespace of [
    { endpoint: "https://other.example", principal: options.namespace.principal },
    { ...options.namespace, principal: "other" },
  ]) await setup({ ...options, namespace }).cache.metadata(key, load);
  await cache.metadata({ ...key, stackId: "other" }, load);
  await cache.metadata({ ...key, tenantId: "other" }, load);
  expect(load).toHaveBeenCalledTimes(4);
});

test("range misses and oversized reads are not persisted", async () => {
  const { cache } = setup({ maxEntryBytes: 3 });
  const load = vi.fn(async () => source());
  await text(cache.read(key, { offset: 0, length: 2 }, load));
  await text(cache.read(key, undefined, load));
  await text(cache.read(key, undefined, load));
  expect(load).toHaveBeenCalledTimes(3);
});

test("cancelled, failed and aborted reads never populate the cache", async () => {
  const { cache } = setup();
  const reader = (await cache.read(key, undefined, async () => source())).getReader();
  await reader.read();
  await reader.cancel();
  await expect(text(cache.read(key, undefined, async () => new ReadableStream({
    pull(controller) { controller.error(new Error("broken")); },
  })))).rejects.toThrow("broken");
  const abort = new AbortController();
  const cancel = vi.fn();
  const stalled = await cache.read(key, undefined, async () => new ReadableStream({ cancel }), { signal: abort.signal });
  const pending = stalled.getReader().read();
  abort.abort();
  await expect(pending).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
  const load = vi.fn(async () => source("fresh"));
  expect(await text(cache.read(key, undefined, load))).toBe("fresh");
  expect(load).toHaveBeenCalledOnce();
});

test("a full cache hit honors abort without affecting another reader", async () => {
  const { cache } = setup();
  await text(cache.read(key, undefined, async () => source()));
  const abort = new AbortController();
  const cached = await cache.read(key, undefined, async () => source(), { signal: abort.signal });
  abort.abort();
  await expect(new Response(cached).text()).rejects.toThrow();
  expect(await text(cache.read(key, undefined, async () => source()))).toBe("abcdef");
});

test("clear invalidates sibling memory and prevents in-flight write resurrection", async () => {
  const { cache, options } = setup();
  await cache.metadata(key, async () => metadata);
  const sibling = setup(options).cache;
  await sibling.metadata(key, async () => metadata);
  const stream = await cache.read(key, undefined, async () => source());
  await cache.clear();
  await new Response(stream).text();
  const load = vi.fn(async () => source("fresh"));
  expect(await text(sibling.read(key, undefined, load))).toBe("fresh");
  const loadMetadata = vi.fn(async () => metadata);
  await sibling.metadata(key, loadMetadata);
  expect(load).toHaveBeenCalledOnce();
  expect(loadMetadata).toHaveBeenCalledOnce();
});

test("disk and memory LRU budgets evict oldest content", async () => {
  const { cache, options } = setup({ maxBytes: 12, maxMemoryBytes: 6 });
  const secondKey = { ...key, hash: "b".repeat(64) };
  const thirdKey = { ...key, hash: "c".repeat(64) };
  await text(cache.read(key, undefined, async () => source()));
  await text(cache.read(secondKey, undefined, async () => source()));
  await text(cache.read(key, undefined, async () => source()));
  await text(cache.read(thirdKey, undefined, async () => source()));
  cache.close();
  const reopened = setup(options).cache;
  const load = vi.fn(async () => source());
  await text(reopened.read(key, undefined, load));
  expect(load).not.toHaveBeenCalled();
  await text(reopened.read(secondKey, undefined, load));
  expect(load).toHaveBeenCalledOnce();
});

test("unavailable IndexedDB and quota errors fall back to bounded memory", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const { cache } = setup();
  await text(cache.read(key, undefined, async () => source()));
  const load = vi.fn(async () => source());
  expect(await text(cache.read(key, undefined, load))).toBe("abcdef");
  expect(load).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  const quotaCache = setup().cache;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  await text(quotaCache.read(key, undefined, async () => source()));
  expect(await text(quotaCache.read(key, undefined, load))).toBe("abcdef");
});

test("only unsignaled metadata loads coalesce", async () => {
  const { cache } = setup();
  let resolve!: (value: typeof metadata) => void;
  const load = vi.fn(() => new Promise<typeof metadata>((done) => { resolve = done; }));
  const first = cache.metadata(key, load);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  const second = cache.metadata(key, load);
  const signaled = vi.fn(async () => metadata);
  await cache.metadata(key, signaled, { signal: new AbortController().signal });
  resolve(metadata);
  await Promise.all([first, second]);
  expect(load).toHaveBeenCalledOnce();
  expect(signaled).toHaveBeenCalledOnce();
});

test("clears all endpoints for a logged-out principal without touching another identity", async () => {
  const { cache, options } = setup();
  const otherEndpoint = setup({ ...options, namespace: { ...options.namespace, endpoint: "https://other.example" } }).cache;
  const otherPrincipal = setup({ ...options, namespace: { ...options.namespace, principal: "someone-else" } }).cache;
  for (const current of [cache, otherEndpoint, otherPrincipal]) await text(current.read(key, undefined, async () => source()));
  cache.close();
  await clearBrowserCasNodeCaches({ principal: options.namespace.principal, databaseName: options.databaseName });
  const load = vi.fn(async () => source("fresh"));
  expect(await text(otherPrincipal.read(key, undefined, load))).toBe("abcdef");
  expect(load).not.toHaveBeenCalled();
  expect(await text(setup(options).cache.read(key, undefined, load))).toBe("fresh");
  expect(await text(otherEndpoint.read(key, undefined, load))).toBe("fresh");
  expect(load).toHaveBeenCalledTimes(2);
});

test("a blocked database open times out to memory without delaying future reads", async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(indexedDB, "open").mockImplementation(() => new EventTarget() as IDBOpenDBRequest);
    const { cache } = setup();
    const reading = cache.read(key, undefined, async () => source());
    await vi.advanceTimersByTimeAsync(1001);
    expect(await text(reading)).toBe("abcdef");
    const load = vi.fn(async () => source());
    expect(await text(cache.read(key, undefined, load))).toBe("abcdef");
    expect(load).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});