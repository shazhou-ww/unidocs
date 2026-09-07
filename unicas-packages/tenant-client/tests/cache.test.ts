import { expect, test, vi } from "vitest";
import { createTenantCasClient } from "../src/client.js";

test("validates ranges and aborted reads before consulting a cache", () => {
  const cache = { metadata: vi.fn(), read: vi.fn() };
  const client = createTenantCasClient({ baseUrl: "https://cas.example", stackId: "stack", tenantId: "tenant", getToken: async () => "token", cache });
  expect(() => client.readContent("a".repeat(64), { offset: -1 })).toThrow("non-negative");
  const signal = AbortSignal.abort();
  expect(() => client.readMetadata("a".repeat(64), { signal })).toThrow();
  expect(() => client.readContent("a".repeat(64), undefined, { signal })).toThrow();
  expect(cache.metadata).not.toHaveBeenCalled();
  expect(cache.read).not.toHaveBeenCalled();
});

test("passes request cancellation to cache strategies without obtaining a token on hits", async () => {
  const hash = "a".repeat(64);
  const value = { hash, size: 0, contentType: "text/plain", refs: [] };
  const cache = {
    metadata: vi.fn(async () => value),
    read: vi.fn(async () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } })),
  };
  const getToken = vi.fn(async () => "token");
  const client = createTenantCasClient({ baseUrl: "https://cas.example", stackId: "stack", tenantId: "tenant", getToken, cache });
  const options = { signal: new AbortController().signal };
  await client.readMetadata(hash, options);
  await client.readContent(hash, undefined, options);
  const key = { stackId: "stack", tenantId: "tenant", hash };
  expect(cache.metadata).toHaveBeenCalledWith(key, expect.any(Function), options);
  expect(cache.read).toHaveBeenCalledWith(key, undefined, expect.any(Function), options);
  expect(getToken).not.toHaveBeenCalled();
});