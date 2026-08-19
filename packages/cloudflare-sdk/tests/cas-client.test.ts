import { describe, it, expect, beforeEach, vi } from "vitest";
import { CasClient } from "../src/cas-client";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("CasClient", () => {
  let client: CasClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new CasClient({
      baseUrl: "http://localhost:8787",
      userId: "user1",
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
        `http://localhost:8787/users/user1/cas/nodes/${"a".repeat(64)}/content`,
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
        `http://localhost:8787/users/user1/cas/nodes/${hash}/metadata`,
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
        `http://localhost:8787/users/user1/cas/nodes/${hash}/lease`,
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
        `http://localhost:8787/users/user1/cas/nodes/${hash}`,
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
        userId: "user1",
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
        userId: "user1",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array().buffer,
      });

      clientWithSlash.read({ kind: "cas", hash: "n".repeat(64) });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8787/users/user1/cas/nodes/n" + "n".repeat(63) + "/content",
        expect.any(Object)
      );
    });
  });
});
