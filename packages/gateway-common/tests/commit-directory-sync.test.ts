import { afterEach, expect, it, vi } from "vitest";
import { createGatewayHandler } from "../src/gateway-handler.js";
import { GatewayCapabilityAuthority } from "../src/capability-authority.js";
import { MemoryGatewayDocumentDirectory } from "../src/document-directory.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const pending = { opId: "commit-1", baseVersion: 1, requestDigest: "ab".repeat(32), state: "pending" };
const committed = { ...pending, state: "committed", version: 2 };

async function harness() {
  const directory = new MemoryGatewayDocumentDirectory();
  await directory.reserve({ docId: "doc", tenantId: "tenant", docType: "markdown", serviceId: "markdown", sessionId: "session", idempotencyKey: "create", requestedDocId: null, now: 100 });
  await directory.markReady("tenant", "doc", 1, 100);
  const issuer = { keyId: "test", issue: async () => "test-token" };
  let now = 200;
  const handler = createGatewayHandler({
    directory, now: () => now++, casStackId: "test",
    capabilityAuthority: new GatewayCapabilityAuthority({ issuer, casIssuer: issuer, casAudience: "cas", casStackId: "test" }),
    identityResolver: { resolve: async () => ({ userId: "user", tenantId: "tenant", canManageTenant: false }) },
    resolveDocService: async () => ({ serviceId: "markdown", url: "https://doc.test", audience: "markdown" }),
    casFetcher: { fetch: async () => new Response(null, { status: 501 }) },
    isGatewayExposedCasRoute: () => false,
  });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const call = (method: string) => handler(new Request(`https://gw/tenants/tenant/docs/markdown/doc/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
  return { directory, fetch, call, record: () => directory.get("tenant", "doc") };
}

it("synchronizes higher committed versions once but status lookup and old results never change recency", async () => {
  const { fetch, call, record } = await harness();
  fetch.mockImplementation(async () => Response.json({ receipt: committed }));
  await call("commit-status");
  expect(await record()).toMatchObject({ version: 1, updatedAt: 100 });
  await call("commit-recover");
  const recovered = await record();
  expect(recovered).toMatchObject({ version: 2, updatedAt: 200 });
  await call("commit-recover");
  await call("apply");
  expect(await record()).toEqual(recovered);
  fetch.mockImplementation(async () => Response.json({ success: true, version: 5 }));
  await call("rollback");
  const latest = await record();
  expect(latest?.version).toBe(5);
  fetch.mockImplementation(async () => Response.json({ receipt: committed }));
  await call("commit-recover");
  expect(await record()).toEqual(latest);
});

it("returns a successful receipt on directory failure and repairs the projection on retry", async () => {
  const { directory, fetch, call, record } = await harness();
  fetch.mockImplementation(async () => Response.json({ receipt: committed }, { headers: { "Cache-Control": "no-store" } }));
  const update = vi.spyOn(directory, "advanceVersion").mockRejectedValueOnce(new Error("D1 unavailable"));
  const first = await call("commit-recover");
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ receipt: committed });
  expect(first.headers.get("X-UniDocs-Directory-Sync")).toBe("pending");
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  expect(await record()).toMatchObject({ version: 1, updatedAt: 100 });
  const retry = await call("commit-recover");
  expect(retry.headers.get("X-UniDocs-Directory-Sync")).toBeNull();
  expect(await record()).toMatchObject({ version: 2, updatedAt: 201 });
  expect(update).toHaveBeenCalledTimes(2);
});

it.each([
  { ...pending },
  { ...pending, state: "unknown", reason: "not_found" },
  { ...pending, state: "rejected", reason: "invalid_operations" },
])("does not synchronize noncommitted recovery %j", async receipt => {
  const { fetch, call, record } = await harness();
  fetch.mockResolvedValue(Response.json({ receipt }));
  await call("commit-recover");
  expect(await record()).toMatchObject({ version: 1, updatedAt: 100 });
});

it.each([
  JSON.stringify({ success: true, version: 99 }),
  JSON.stringify({ receipt: { ...committed, version: 99 } }),
  "invalid JSON",
  "x".repeat(16_385),
])("preserves malformed upstream results without inventing a directory version", async body => {
  const { fetch, call, record } = await harness();
  fetch.mockResolvedValue(new Response(body));
  const response = await call("commit-recover");
  expect(response.headers.get("X-UniDocs-Directory-Sync")).toBe("pending");
  expect(await response.text()).toBe(body);
  expect(await record()).toMatchObject({ version: 1, updatedAt: 100 });
});