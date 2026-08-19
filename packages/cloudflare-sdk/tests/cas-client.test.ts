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

  describe("claimLease", () => {
    it("claims a lease for a new node", async () => {
      const hash = "d".repeat(64);
      const leaseResult = {
        hash,
        ready: false,
        uploadRequired: true,
        uploadToken: "token123",
        leaseStartedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => leaseResult,
      });

      const result = await client.claimLease(hash, 100, "text/plain", [], 60000);

      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:8787/users/user1/cas/nodes/${hash}/lease`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          body: expect.any(String),
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({
        size: 100,
        contentType: "text/plain",
        refs: [],
        requestedDurationMs: 60000,
      });

      expect(result).toEqual(leaseResult);
    });

    it("claims a lease for an existing node", async () => {
      const hash = "e".repeat(64);
      const leaseResult = {
        hash,
        ready: true,
        uploadRequired: false,
        leaseStartedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => leaseResult,
      });

      const result = await client.claimLease(hash, 100, "text/plain", []);

      expect(result.ready).toBe(true);
      expect(result.uploadRequired).toBe(false);
    });

    it("throws on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
      });

      await expect(
        client.claimLease("f".repeat(64), 100, "text/plain", [])
      ).rejects.toThrow("CAS lease claim failed: 400 Bad Request");
    });
  });

  describe("uploadContent", () => {
    it("uploads content with token", async () => {
      const hash = "g".repeat(64);
      const content = new TextEncoder().encode("upload content");
      const uploadToken = "token456";
      const leaseResult = {
        hash,
        ready: true,
        uploadRequired: false,
        leaseStartedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => leaseResult,
      });

      const result = await client.uploadContent(hash, content, uploadToken);

      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:8787/users/user1/cas/nodes/${hash}/content`,
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            "Content-Type": "application/octet-stream",
            "Content-Length": String(content.length),
            "X-CAS-Upload-Token": uploadToken,
          }),
          body: content,
        })
      );

      expect(result).toEqual(leaseResult);
    });

    it("throws on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      const content = new TextEncoder().encode("forbidden");
      await expect(
        client.uploadContent("h".repeat(64), content, "token")
      ).rejects.toThrow("CAS upload failed: 403 Forbidden");
    });
  });

  describe("leaseExisting", () => {
    it("extends lease on existing ready node", async () => {
      const hash = "i".repeat(64);
      const leaseResult = {
        hash,
        ready: true,
        uploadRequired: false,
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
          body: expect.stringContaining('"requestedDurationMs":120000'),
        })
      );

      expect(result.ready).toBe(true);
      expect(result.uploadRequired).toBe(false);
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
    it("creates and uploads new node", async () => {
      const hash = "k".repeat(64);
      const content = new TextEncoder().encode("new node");
      const leaseResult = {
        hash,
        ready: false,
        uploadRequired: true,
        uploadToken: "token789",
        leaseStartedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60000,
      };
      const uploadResult = {
        hash,
        ready: true,
        uploadRequired: false,
        leaseStartedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60000,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => leaseResult,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => uploadResult,
        });

      const result = await client.ensureNode(hash, content, "text/plain");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.ready).toBe(true);
    });

    it("skips upload for existing ready node", async () => {
      const hash = "l".repeat(64);
      const content = new TextEncoder().encode("existing");
      const leaseResult = {
        hash,
        ready: true,
        uploadRequired: false,
        leaseStartedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => leaseResult,
      });

      const result = await client.ensureNode(hash, content, "text/plain");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.ready).toBe(true);
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
