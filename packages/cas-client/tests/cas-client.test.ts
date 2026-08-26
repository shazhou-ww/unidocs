import { describe, it, expect, beforeEach, vi } from "vitest";
import { CasClient, CasClientError, leaseOpRefs, commitRootRefsOrRollback } from "../src/index.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("CasClient", () => {
  let client: CasClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new CasClient({
      baseUrl: "http://localhost:8787",
      tenantId: "tenant1",
    });
  });

  describe("read", () => {
    it("fetches node content", async () => {
      const content = new TextEncoder().encode("test content");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => content.buffer,
      });

      const result = await client.read({ kind: "cas", hash: "a".repeat(64) });

      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:8787/tenants/tenant1/cas/nodes/${"a".repeat(64)}/content`,
        expect.any(Object)
      );
      expect(result).toEqual(content);
    });

    it("throws on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(client.read({ kind: "cas", hash: "a".repeat(64) })).rejects.toThrow(
        "CAS read failed: 404 Not Found"
      );
    });
  });

  describe("metadata", () => {
    it("fetches node metadata", async () => {
      const hash = "b".repeat(64);
      const metadata = {
        metadata: {
          hash,
          size: 100,
          contentType: "text/plain",
          refs: ["c".repeat(64)],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => metadata,
      });

      const result = await client.metadata({ kind: "cas", hash });

      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:8787/tenants/tenant1/cas/nodes/${hash}/metadata`,
        expect.any(Object)
      );
      expect(result).toEqual(metadata.metadata);
    });

    it("throws on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        client.metadata({ kind: "cas", hash: "a".repeat(64) })
      ).rejects.toThrow("CAS metadata failed: 500 Internal Server Error");
    });
  });

  describe("leaseExisting", () => {
    it("extends lease on existing ready node", async () => {
      const hash = "i".repeat(64);
      const leaseResult = {
        hash,
        ready: true,
        leaseStartedAt: Date.now(),
        leaseExpiresAt: Date.now() + 120000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => leaseResult,
      });

      const result = await client.leaseExisting(hash, 120000);

      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:8787/tenants/tenant1/cas/nodes/${hash}/lease`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "X-CAS-Lease-Duration": "120000",
          }),
        })
      );

      expect(result.ready).toBe(true);
    });

    it("throws on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(client.leaseExisting("j".repeat(64))).rejects.toThrow(
        "CAS leaseExisting failed: 404 Not Found"
      );
    });
  });

  describe("ensureNode", () => {
    it("posts content as a single lease", async () => {
      const hash = "k".repeat(64);
      const content = new TextEncoder().encode("new node");
      const leaseResult = {
        hash,
        ready: true,
        leaseStartedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => leaseResult,
      });

      const result = await client.ensureNode(hash, content, "text/plain", [], 60000);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:8787/tenants/tenant1/cas/nodes/${hash}`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "text/plain",
            "Content-Length": String(content.length),
            "X-CAS-Lease-Duration": "60000",
          }),
          body: content,
        })
      );
      expect(result.ready).toBe(true);
    });

    it("includes child refs header", async () => {
      const hash = "l".repeat(64);
      const child = "c".repeat(64);
      const content = new TextEncoder().encode("parent");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          hash,
          ready: true,
          leaseStartedAt: Date.now(),
          leaseExpiresAt: Date.now() + 60000,
        }),
      });

      await client.ensureNode(hash, content, "application/json", [child]);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-CAS-Refs": child,
          }),
        })
      );
    });

    it("throws on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: "Conflict",
      });
      const content = new TextEncoder().encode("x");
      await expect(
        client.ensureNode("m".repeat(64), content, "text/plain")
      ).rejects.toThrow("CAS lease failed: 409 Conflict");
    });
  });

  describe("auth token", () => {
    it("includes auth token in requests", async () => {
      const clientWithAuth = new CasClient({
        baseUrl: "http://localhost:8787",
        tenantId: "tenant1",
        authToken: "secret123",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array().buffer,
      });

      await clientWithAuth.read({ kind: "cas", hash: "m".repeat(64) });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer secret123",
          }),
        })
      );
    });
  });

  describe("URL handling", () => {
    it("strips trailing slash from baseUrl", () => {
      const clientWithSlash = new CasClient({
        baseUrl: "http://localhost:8787/",
        tenantId: "tenant1",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array().buffer,
      });

      clientWithSlash.read({ kind: "cas", hash: "n".repeat(64) });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8787/tenants/tenant1/cas/nodes/n" + "n".repeat(63) + "/content",
        expect.any(Object)
      );
    });
  });

  describe("Editor service-binding mode", () => {
    it("sets internal headers and uses the fetcher", async () => {
      const fetcherFetch = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
      }));
      const internal = new CasClient({
        fetcher: { fetch: fetcherFetch } as unknown as Fetcher,
        tenantId: "tenant1",
        accessKey: "tok",
      });

      await internal.read({ kind: "cas", hash: "a".repeat(64) });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(fetcherFetch).toHaveBeenCalledWith(
        `https://cas.internal/tenants/tenant1/cas/nodes/${"a".repeat(64)}/content`,
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Internal-Token": "tok",
            "X-Tenant-Id": "tenant1",
          }),
        }),
      );
    });

    it("posts updateRootRefs to /_internal/root-refs", async () => {
      const fetcherFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true }),
      }));
      const internal = new CasClient({
        fetcher: { fetch: fetcherFetch } as unknown as Fetcher,
        tenantId: "tenant1",
        accessKey: "tok",
      });
      const hash = "b".repeat(64);

      const result = await internal.updateRootRefs({
        requestId: "apply:session1:2",
        changes: { [hash]: 1 },
      });

      expect(result).toEqual({ success: true });
      expect(fetcherFetch).toHaveBeenCalledWith(
        "https://cas.internal/_internal/root-refs",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "X-Internal-Token": "tok",
            "X-Tenant-Id": "tenant1",
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("throws if public mode calls updateRootRefs", async () => {
      await expect(
        client.updateRootRefs({ requestId: "x", changes: { ["c".repeat(64)]: 1 } }),
      ).rejects.toThrow(/service-binding/);
    });

    it("uses only a delegated Bearer capability and tenant-prefixed root route", async () => {
      const fetcherFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true }),
      }));
      const internal = new CasClient({
        fetcher: { fetch: fetcherFetch } as unknown as Fetcher,
        tenantId: "tenant1",
        sessionId: "session1",
        capability: "cas-capability",
      });

      await internal.updateRootRefs({ requestId: "apply:session1:2", changes: {} });

      expect(fetcherFetch).toHaveBeenCalledWith(
        "https://cas.internal/tenants/tenant1/_internal/root-refs",
        expect.objectContaining({
          headers: {
            Authorization: "Bearer cas-capability",
            "Content-Type": "application/json",
          },
        }),
      );
    });
  });

  describe("Canonical stack mode", () => {
    it("routes reads, metadata, and leases through /stacks/{stackId}/tenants/{tenantId}", async () => {
      const client = new CasClient({
        baseUrl: "http://cas.example",
        stackId: "unidocs-cloudflare",
        tenantId: "tenant1",
      });
      const hash = "a".repeat(64);
      const prefix = `http://cas.example/stacks/unidocs-cloudflare/tenants/tenant1`;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("x").buffer,
      });
      await client.read({ kind: "cas", hash });
      expect(mockFetch).toHaveBeenCalledWith(`${prefix}/cas/nodes/${hash}/content`, expect.any(Object));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ metadata: { hash, size: 1, contentType: "text/plain", refs: [] } }),
      });
      await client.metadata({ kind: "cas", hash });
      expect(mockFetch).toHaveBeenCalledWith(`${prefix}/cas/nodes/${hash}/metadata`, expect.any(Object));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash, ready: true, leaseStartedAt: 1, leaseExpiresAt: 2 }),
      });
      await client.leaseExisting(hash);
      expect(mockFetch).toHaveBeenCalledWith(`${prefix}/cas/nodes/${hash}/lease`, expect.any(Object));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash, ready: true, leaseStartedAt: 1, leaseExpiresAt: 2 }),
      });
      await client.ensureNode(hash, new TextEncoder().encode("x"), "text/plain");
      expect(mockFetch).toHaveBeenCalledWith(`${prefix}/cas/nodes/${hash}`, expect.any(Object));
    });

    it("posts updateRootRefs to the canonical root-refs route with a typed revision response", async () => {
      const fetcherFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, idempotent: true, revision: 42 }),
      }));
      const client = new CasClient({
        fetcher: { fetch: fetcherFetch } as unknown as Fetcher,
        stackId: "unidocs-cloudflare",
        tenantId: "tenant1",
        sessionId: "session1",
        capability: "cas-capability",
      });

      const result = await client.updateRootRefs({
        requestId: "session:session1:version:2:roots",
        changes: { ["c".repeat(64)]: 1 },
      });

      expect(result).toEqual({ success: true, idempotent: true, revision: 42 });
      expect(fetcherFetch).toHaveBeenCalledWith(
        "https://cas.internal/stacks/unidocs-cloudflare/tenants/tenant1/root-refs",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer cas-capability",
            "Content-Type": "application/json",
          },
        }),
      );
    });

    it("keeps the legacy tenant-prefixed root route when stackId is absent", async () => {
      const fetcherFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true }),
      }));
      const client = new CasClient({
        fetcher: { fetch: fetcherFetch } as unknown as Fetcher,
        tenantId: "tenant1",
        sessionId: "session1",
        capability: "cas-capability",
      });

      await client.updateRootRefs({ requestId: "r", changes: {} });

      expect(fetcherFetch).toHaveBeenCalledWith(
        "https://cas.internal/tenants/tenant1/_internal/root-refs",
        expect.any(Object),
      );
    });
  });
});

describe("leaseOpRefs", () => {
  it("leases each aggregated hash and skips empty maps", async () => {
    const { createSBlob } = await import("@unidocs/svalue-codec");
    const leaseExisting = vi.fn(async () => ({ ready: true }));
    const hash = "d".repeat(64);
    const refs = await leaseOpRefs(
      [{ kind: "insertImage", blob: createSBlob(hash) }, { kind: "appendParagraph" }],
      { leaseExisting },
    );
    expect(refs).toEqual({ [hash]: 1 });
    expect(leaseExisting).toHaveBeenCalledTimes(1);
    expect(leaseExisting).toHaveBeenCalledWith(hash);
  });

  it("maps missing nodes as CasClientError 404", async () => {
    const { createSBlob } = await import("@unidocs/svalue-codec");
    const leaseExisting = vi.fn(async () => {
      throw new CasClientError(404, "Not Found", "leaseExisting");
    });
    await expect(leaseOpRefs(
      [{ blob: createSBlob("e".repeat(64)) }],
      { leaseExisting },
    )).rejects.toMatchObject({ status: 404 });
  });
});

describe("commitRootRefsOrRollback", () => {
  it("skips empty changes", async () => {
    const updateRootRefs = vi.fn();
    const rollback = vi.fn();
    await commitRootRefsOrRollback({ updateRootRefs }, "id", {}, rollback);
    expect(updateRootRefs).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back the delta when root-refs fail", async () => {
    const updateRootRefs = vi.fn(async () => {
      throw new CasClientError(500, "Internal Server Error", "updateRootRefs");
    });
    const rollback = vi.fn();
    const hash = "f".repeat(64);
    await expect(
      commitRootRefsOrRollback({ updateRootRefs }, "apply:u:d:2", { [hash]: 1 }, rollback),
    ).rejects.toThrow(/updateRootRefs/);
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});
