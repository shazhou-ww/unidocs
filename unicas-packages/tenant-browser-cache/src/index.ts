import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CasNodeCache, CasNodeCacheKey, CasNodeMetadata, CasNodeRange } from "@unicas/tenant-client";

export interface BrowserCasNodeCacheOptions {
  readonly namespace: { readonly endpoint: string; readonly principal: string };
  readonly databaseName?: string;
  readonly maxBytes?: number;
  readonly maxMemoryBytes?: number;
  readonly maxEntryBytes?: number;
}

export interface BrowserCasNodeCache extends CasNodeCache {
  clear(): Promise<void>;
  close(): void;
}

interface Entry {
  id: string;
  namespace: string;
  principal: string;
  bytes: number;
  touched: number;
  metadata?: CasNodeMetadata;
  content?: Blob;
}

interface CacheSchema extends DBSchema {
  nodes: { key: string; value: Entry; indexes: { namespace: string; principal: string } };
}

const defaultDatabaseName = "unicas-node-cache-v1";
const liveCaches = new Set<{ namespace: string; principal: string; databaseName: string; invalidate: () => void }>();

function openDatabase(databaseName: string): Promise<IDBPDatabase<CacheSchema> | undefined> {
  return new Promise((resolve) => {
    let finished = false;
    let connection: IDBPDatabase<CacheSchema> | undefined;
    const finish = (value?: IDBPDatabase<CacheSchema>) => {
      if (finished) { value?.close(); return; }
      finished = true;
      clearTimeout(timer);
      connection = value;
      resolve(value);
    };
    const timer = setTimeout(() => finish(), 1000);
    try {
      void openDB<CacheSchema>(databaseName, 1, {
        upgrade(store) {
          const nodes = store.createObjectStore("nodes", { keyPath: "id" });
          nodes.createIndex("namespace", "namespace");
          nodes.createIndex("principal", "principal");
        },
        blocking() { connection?.close(); },
      }).then(finish, () => finish());
    } catch { finish(); }
  });
}

function invalidationChannel(databaseName: string): BroadcastChannel | undefined {
  try { return typeof BroadcastChannel === "function" ? new BroadcastChannel(`${databaseName}:invalidate`) : undefined; }
  catch { return undefined; }
}

export async function clearBrowserCasNodeCaches(options: { readonly principal: string; readonly databaseName?: string }): Promise<void> {
  const databaseName = options.databaseName ?? defaultDatabaseName;
  for (const live of liveCaches) if (live.principal === options.principal && live.databaseName === databaseName) live.invalidate();
  const channel = invalidationChannel(databaseName);
  channel?.postMessage({ principal: options.principal });
  channel?.close();
  const store = await openDatabase(databaseName);
  if (!store) return;
  try {
    const transaction = store.transaction("nodes", "readwrite");
    const keys = await transaction.store.index("principal").getAllKeys(options.principal);
    for (const key of keys) await transaction.store.delete(key);
    await transaction.done;
  } catch { }
  finally { store.close(); }
}

export function createBrowserCasNodeCache(options: BrowserCasNodeCacheOptions): BrowserCasNodeCache {
  const endpoint = new URL(options.namespace.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError("Cache endpoint must not contain credentials, query, or fragment");
  if (!options.namespace.principal) throw new TypeError("Cache principal is required");
  const principal = options.namespace.principal;
  const namespace = JSON.stringify([endpoint.href.replace(/\/$/, ""), principal]);
  const databaseName = options.databaseName ?? defaultDatabaseName;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxMemoryBytes = options.maxMemoryBytes ?? 8 * 1024 * 1024;
  const maxEntryBytes = options.maxEntryBytes ?? 4 * 1024 * 1024;
  for (const limit of [maxBytes, maxMemoryBytes, maxEntryBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("Cache limits must be non-negative safe integers");
  }
  const memory = new Map<string, Entry>();
  const pendingMetadata = new Map<string, Promise<CasNodeMetadata>>();
  let memoryBytes = 0;
  let generation = 0;
  let closed = false;
  let database: Promise<IDBPDatabase<CacheSchema> | undefined> | undefined;
  let connection: IDBPDatabase<CacheSchema> | undefined;
  let clock = Date.now();
  const tick = () => clock = Math.max(clock + 1, Date.now());
  const invalidate = () => {
    generation += 1;
    memory.clear();
    memoryBytes = 0;
    pendingMetadata.clear();
  };
  const registration = { namespace, principal, databaseName, invalidate };
  liveCaches.add(registration);
  const channel = invalidationChannel(databaseName);
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data === namespace || (typeof event.data === "object" && event.data !== null && "principal" in event.data && event.data.principal === principal)) invalidate();
  };

  function db(): Promise<IDBPDatabase<CacheSchema> | undefined> {
    if (closed) return Promise.resolve(undefined);
    database ??= openDatabase(databaseName).then((value) => {
      if (closed) { value?.close(); return undefined; }
      connection = value;
      return value;
    });
    return database;
  }

  function keyId(key: CasNodeCacheKey, kind: "metadata" | "content"): string {
    return JSON.stringify([namespace, key.stackId, key.tenantId, key.hash, kind]);
  }

  function remember(entry: Entry) {
    const old = memory.get(entry.id);
    if (old) { memoryBytes -= old.bytes; memory.delete(entry.id); }
    if (entry.bytes > maxMemoryBytes) return;
    memory.set(entry.id, entry);
    memoryBytes += entry.bytes;
    while (memoryBytes > maxMemoryBytes) {
      const oldest = memory.entries().next().value!;
      memory.delete(oldest[0]);
      memoryBytes -= oldest[1].bytes;
    }
  }

  async function get(id: string): Promise<Entry | undefined> {
    if (closed) return undefined;
    const epoch = generation;
    let entry = memory.get(id);
    try {
      const store = await db();
      entry ??= await store?.get("nodes", id);
      if (closed || epoch !== generation) return undefined;
      if (entry) {
        entry.touched = tick();
        remember(entry);
        if (store) {
          const transaction = store.transaction("nodes", "readwrite");
          const persisted = await transaction.store.get(id);
          if (persisted) await transaction.store.put({ ...persisted, touched: entry.touched });
          await transaction.done;
        }
      }
    } catch { }
    return closed || epoch !== generation ? undefined : entry;
  }

  async function put(entry: Entry, epoch: number): Promise<void> {
    if (closed || epoch !== generation || entry.bytes > maxBytes || entry.bytes > maxEntryBytes) return;
    remember(entry);
    try {
      const store = await db();
      if (!store || closed || epoch !== generation) return;
      const transaction = store.transaction("nodes", "readwrite");
      await transaction.store.put(entry);
      const entries = await transaction.store.index("namespace").getAll(namespace);
      let total = entries.reduce((sum, candidate) => sum + candidate.bytes, 0);
      for (const candidate of entries.sort((left, right) => left.touched - right.touched)) {
        if (total <= maxBytes) break;
        await transaction.store.delete(candidate.id);
        total -= candidate.bytes;
      }
      await transaction.done;
    } catch { }
  }

  const cache: BrowserCasNodeCache = {
    async metadata(key, load, request) {
      const epoch = generation;
      request?.signal?.throwIfAborted();
      const id = keyId(key, "metadata");
      const entry = await get(id);
      request?.signal?.throwIfAborted();
      if (entry?.metadata) return structuredClone(entry.metadata);
      const pending = request?.signal ? undefined : pendingMetadata.get(id);
      if (pending) return structuredClone(await pending);
      const operation = (async () => {
        const loaded = await load();
        request?.signal?.throwIfAborted();
        const metadata: CasNodeMetadata = { hash: loaded.hash, size: loaded.size, contentType: loaded.contentType, refs: [...loaded.refs] };
        if (metadata.hash === key.hash) await put({ id, namespace, principal, metadata, bytes: new TextEncoder().encode(JSON.stringify(metadata)).length, touched: tick() }, epoch);
        return metadata;
      })();
      if (!request?.signal) pendingMetadata.set(id, operation);
      try { return structuredClone(await operation); }
      finally { if (pendingMetadata.get(id) === operation) pendingMetadata.delete(id); }
    },

    async read(key, range, load, request) {
      const epoch = generation;
      request?.signal?.throwIfAborted();
      validateRange(range);
      if (range?.length === 0) return new Blob([]).stream();
      const id = keyId(key, "content");
      const entry = await get(id);
      request?.signal?.throwIfAborted();
      if (entry?.content) {
        if (range && range.offset >= entry.content.size) throw new RangeError("Range starts beyond cached node content");
        const blob = range ? entry.content.slice(range.offset, range.length === undefined ? undefined : range.offset + range.length) : entry.content;
        return abortable(blob.stream(), request?.signal);
      }
      if (range || closed || maxEntryBytes === 0 || maxBytes === 0) return load();
      const reader = (await load()).getReader();
      let parts: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      let cacheable = true;
      return abortable(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            request?.signal?.throwIfAborted();
            const chunk = await reader.read();
            request?.signal?.throwIfAborted();
            if (chunk.done) {
              if (cacheable) await put({ id, namespace, principal, bytes: Math.max(1, bytes), content: new Blob(parts), touched: tick() }, epoch);
              parts = [];
              controller.close();
              reader.releaseLock();
            } else {
              bytes += chunk.value.byteLength;
              if (bytes > Math.min(maxEntryBytes, maxBytes)) { cacheable = false; parts = []; }
              if (cacheable) parts.push(Uint8Array.from(chunk.value));
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            parts = [];
            controller.error(error);
            await reader.cancel(error).catch(() => undefined);
          }
        },
        async cancel(reason) { cacheable = false; parts = []; await reader.cancel(reason); },
      }, { highWaterMark: 0 }), request?.signal);
    },

    async clear() {
      for (const live of liveCaches) if (live.namespace === namespace && live.databaseName === databaseName) live.invalidate();
      channel?.postMessage(namespace);
      const store = await db();
      if (!store) return;
      try {
        const transaction = store.transaction("nodes", "readwrite");
        const keys = await transaction.store.index("namespace").getAllKeys(namespace);
        for (const key of keys) await transaction.store.delete(key);
        await transaction.done;
      } catch { }
    },

    close() {
      closed = true;
      invalidate();
      connection?.close();
      channel?.close();
      liveCaches.delete(registration);
    },
  };
  return cache;
}

function validateRange(range?: CasNodeRange) {
  if (range && (!Number.isSafeInteger(range.offset) || range.offset < 0 || (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0)))) {
    throw new TypeError("CAS node range must contain non-negative safe integers");
  }
}

function abortable(source: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  if (!signal) return source;
  const reader = source.getReader();
  let stopped = false;
  let abort: () => void;
  const cleanup = () => signal.removeEventListener("abort", abort);
  return new ReadableStream({
    start(controller) {
      abort = () => {
        stopped = true;
        cleanup();
        controller.error(signal.reason);
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (stopped) return;
        signal.throwIfAborted();
        if (chunk.done) { stopped = true; cleanup(); controller.close(); reader.releaseLock(); }
        else controller.enqueue(chunk.value);
      } catch (error) { if (!stopped) controller.error(error); stopped = true; cleanup(); await reader.cancel(error).catch(() => undefined); }
    },
    cancel(reason) { stopped = true; cleanup(); return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}