import { describe, it, expect, beforeEach, vi } from "vitest";
import { computeNodeDigest, encodeHeader, hashToHex } from "@unicas/server-common";
import { CasClient } from "@unicas/client";
import { MemoryCas } from "../src/memory-ports";

/** The CAS service's canonical leaf-node digest (no children). */
async function casHash(bytes: Uint8Array, contentType: string): Promise<string> {
  const header = encodeHeader(bytes.length, contentType, 0);
  return hashToHex(await computeNodeDigest(header, contentType, [], bytes));
}

// Mock fetch globally (same harness as cas-client.test.ts).
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("CasClient.store", () => {
  let client: CasClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new CasClient({
      baseUrl: "http://localhost:8787",
      tenantId: "tenant1",
    });
  });

  it("uploads content and returns the content hash", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const expected = await casHash(bytes, "image/png");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hash: expected,
        ready: true,
        leaseStartedAt: 0,
        leaseExpiresAt: 1,
      }),
    });

    const hash = await client.store(bytes, "image/png");

    expect(hash).toBe(expected);
    // store() = canonical CAS node digest + ensureNode (POST /nodes/{hash}).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      `http://localhost:8787/tenants/tenant1/cas/nodes/${expected}`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "image/png" }),
        body: bytes,
      }),
    );
  });

  it("is content-addressed: identical bytes → identical hash", async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ready: true }) });

    const h1 = await client.store(a, "application/octet-stream");
    const h2 = await client.store(b, "application/octet-stream");

    expect(h1).toBe(h2);
  });
});

describe("MemoryCas.store", () => {
  it("round-trips: store then read returns the same bytes", async () => {
    const cas = new MemoryCas();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

    const hash = await cas.store(bytes, "image/png");
    const back = await cas.read({ kind: "cas", hash });

    expect(hash).toBe(await casHash(bytes, "image/png"));
    expect(back).toEqual(bytes);
  });

  it("is content-addressed: identical bytes → identical hash", async () => {
    const cas = new MemoryCas();
    const h1 = await cas.store(new Uint8Array([5, 5, 5]), "image/png");
    const h2 = await cas.store(new Uint8Array([5, 5, 5]), "image/png");
    expect(h1).toBe(h2);
  });

  it("exposes metadata for stored content", async () => {
    const cas = new MemoryCas();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await cas.store(bytes, "image/png");

    const meta = await cas.metadata({ kind: "cas", hash });
    expect(meta).toMatchObject({ hash, size: bytes.length, contentType: "image/png" });
  });
});
