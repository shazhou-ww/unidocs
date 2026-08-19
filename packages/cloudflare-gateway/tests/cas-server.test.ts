import { describe, it, expect, beforeEach } from "vitest";
import { CasDurableObject } from "../src/cas/do";
import { computeNodeDigest, encodeHeader, hashToHex } from "@unidocs/cas";

// Mock D1 database
class MockD1Database {
  private tables: Map<string, any[]> = new Map();

  async exec(sql: string) {
    const createMatch = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
    if (createMatch) {
      const tableName = createMatch[1];
      if (!this.tables.has(tableName)) {
        this.tables.set(tableName, []);
      }
    }
  }

  prepare(sql: string) {
    return new MockD1PreparedStatement(sql, this.tables);
  }

  async batch(statements: MockD1PreparedStatement[]) {
    for (const stmt of statements) {
      await stmt.run();
    }
  }
}

class MockD1PreparedStatement {
  private sql: string;
  private params: any[] = [];
  private tables: Map<string, any[]>;

  constructor(sql: string, tables: Map<string, any[]>) {
    this.sql = sql;
    this.tables = tables;
  }

  bind(...params: any[]) {
    this.params = params;
    return this;
  }

  async run() {
    const insertMatch = this.sql.match(/INSERT INTO (\w+)/);
    if (insertMatch) {
      const tableName = insertMatch[1];
      const table = this.tables.get(tableName) || [];
      table.push({ ...this.params });
      this.tables.set(tableName, table);
    }

    const updateMatch = this.sql.match(/UPDATE (\w+) SET (\w+) = (\w+) \+ (\d+)/);
    if (updateMatch) {
      const tableName = updateMatch[1];
      const column = updateMatch[2];
      const table = this.tables.get(tableName) || [];
      const row = table.find((r) => r[1] === this.params[1]);
      if (row) {
        row[column] = (row[column] || 0) + parseInt(updateMatch[4]);
      }
    }

    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    // Handle SELECT * FROM table
    const selectAllMatch = this.sql.match(/SELECT \* FROM (\w+)/);
    if (selectAllMatch) {
      const tableName = selectAllMatch[1];
      const table = this.tables.get(tableName) || [];
      
      const row = table.find((r) => {
        for (let i = 0; i < this.params.length; i++) {
          if (r[i] !== this.params[i]) return false;
        }
        return true;
      });
      
      if (row) {
        return {
          content_size: row[2],
          content_type: row[3],
          lease_started_at: row[4] || 0,
          lease_expires_at: row[5] || 0,
          child_ref_count: row[6] || 0,
          root_ref_count: row[7] || 0,
        } as T;
      }
    }

    // Handle SELECT column FROM table
    const selectColMatch = this.sql.match(/SELECT (\w+) FROM (\w+)/);
    if (selectColMatch) {
      const column = selectColMatch[1];
      const tableName = selectColMatch[2];
      const table = this.tables.get(tableName) || [];
      
      const row = table.find((r) => {
        for (let i = 0; i < this.params.length; i++) {
          if (r[i] !== this.params[i]) return false;
        }
        return true;
      });
      
      if (row) {
        // Map column name to index
        const columnMap: Record<string, number> = {
          content_size: 2,
          content_type: 3,
          lease_started_at: 4,
          lease_expires_at: 5,
          child_ref_count: 6,
          root_ref_count: 7,
        };
        const idx = columnMap[column];
        if (idx !== undefined) {
          return { [column]: row[idx] || 0 } as T;
        }
      }
    }

    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
}

// Mock R2 bucket
class MockR2Bucket {
  private objects: Map<string, { body: Uint8Array; head: any }> = new Map();

  async head(key: string) {
    return this.objects.has(key) ? this.objects.get(key)?.head : null;
  }

  async get(key: string) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(obj.body);
          controller.close();
        },
      }),
      bodyUsed: false,
      arrayBuffer: async () => obj.body.buffer,
      text: async () => new TextDecoder().decode(obj.body),
      json: async () => JSON.parse(new TextDecoder().decode(obj.body)),
    };
  }

  async put(key: string, value: Uint8Array | ReadableStream) {
    let body: Uint8Array;
    if (value instanceof ReadableStream) {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      body = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      body = value;
    }

    this.objects.set(key, {
      body,
      head: { size: body.length },
    });
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

async function computeHash(content: Uint8Array, contentType: string): Promise<string> {
  const header = encodeHeader(content.length, contentType, 0);
  const hashBytes = await computeNodeDigest(header, contentType, [], content);
  return hashToHex(hashBytes);
}

describe("CAS Durable Object", () => {
  let db: MockD1Database;
  let r2: MockR2Bucket;
  let doInstance: CasDurableObject;

  beforeEach(async () => {
    db = new MockD1Database();
    r2 = new MockR2Bucket();

    await db.exec("CREATE TABLE IF NOT EXISTS cas_nodes");
    await db.exec("CREATE TABLE IF NOT EXISTS cas_edges");
    await db.exec("CREATE TABLE IF NOT EXISTS cas_root_ref_requests");

    doInstance = new CasDurableObject({} as any, {
      CAS_DB: db as any,
      CAS_R2: r2 as any,
    });
  });

  describe("lease", () => {
    it("creates a new node lease", async () => {
      const content = new TextEncoder().encode("test content");
      const hash = await computeHash(content, "text/plain");

      const request = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: content.length,
          contentType: "text/plain",
          refs: [],
          requestedDurationMs: 60000,
        }),
      });

      const response = await doInstance.fetch(request);
      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result.hash).toBe(hash);
      expect(result.uploadRequired).toBe(true);
      expect(result.uploadToken).toBeDefined();
    });

    it("rejects invalid hash format", async () => {
      const request = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": "invalid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: 100,
          contentType: "text/plain",
          refs: [],
          requestedDurationMs: 60000,
        }),
      });

      const response = await doInstance.fetch(request);
      expect(response.status).toBe(500);
    });

    it("rejects invalid content type", async () => {
      const request = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": "a".repeat(64),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: 100,
          contentType: "invalid\x00type",
          refs: [],
          requestedDurationMs: 60000,
        }),
      });

      const response = await doInstance.fetch(request);
      expect(response.status).toBe(500);
    });
  });

  describe("upload", () => {
    it("completes upload and verifies digest", async () => {
      const content = new TextEncoder().encode("upload test");
      const hash = await computeHash(content, "text/plain");

      const leaseRequest = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: content.length,
          contentType: "text/plain",
          refs: [],
          requestedDurationMs: 60000,
        }),
      });

      const leaseResponse = await doInstance.fetch(leaseRequest);
      const lease = await leaseResponse.json();

      const uploadRequest = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "X-CAS-Upload-Token": lease.uploadToken,
        },
        body: content,
      });

      const uploadResponse = await doInstance.fetch(uploadRequest);
      expect(uploadResponse.status).toBe(200);

      const result = await uploadResponse.json();
      expect(result.ready).toBe(true);
    });

    it("rejects upload without token", async () => {
      const content = new TextEncoder().encode("no token");
      const hash = await computeHash(content, "text/plain");

      const uploadRequest = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
        },
        body: content,
      });

      const uploadResponse = await doInstance.fetch(uploadRequest);
      expect(uploadResponse.status).toBe(500);
    });
  });

  describe("read", () => {
    it("reads uploaded content", async () => {
      const content = new TextEncoder().encode("read test");
      const hash = await computeHash(content, "text/plain");

      const leaseRequest = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: content.length,
          contentType: "text/plain",
          refs: [],
          requestedDurationMs: 60000,
        }),
      });

      const leaseResponse = await doInstance.fetch(leaseRequest);
      const lease = await leaseResponse.json();

      const uploadRequest = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "X-CAS-Upload-Token": lease.uploadToken,
        },
        body: content,
      });

      await doInstance.fetch(uploadRequest);

      const readRequest = new Request("http://localhost/read", {
        method: "GET",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
        },
      });

      const readResponse = await doInstance.fetch(readRequest);
      expect(readResponse.status).toBe(200);

      const text = await readResponse.text();
      expect(text).toBe("read test");
    });

    it("returns 404 for non-existent node", async () => {
      const readRequest = new Request("http://localhost/read", {
        method: "GET",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": "a".repeat(64),
        },
      });

      const readResponse = await doInstance.fetch(readRequest);
      expect(readResponse.status).toBe(404);
    });
  });

  describe("metadata", () => {
    it("returns node metadata", async () => {
      const content = new TextEncoder().encode("metadata test");
      const hash = await computeHash(content, "application/json");

      const leaseRequest = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: content.length,
          contentType: "application/json",
          refs: [],
          requestedDurationMs: 60000,
        }),
      });

      const leaseResponse = await doInstance.fetch(leaseRequest);
      const lease = await leaseResponse.json();

      const uploadRequest = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "X-CAS-Upload-Token": lease.uploadToken,
        },
        body: content,
      });

      await doInstance.fetch(uploadRequest);

      const metadataRequest = new Request("http://localhost/metadata", {
        method: "GET",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
        },
      });

      const metadataResponse = await doInstance.fetch(metadataRequest);
      expect(metadataResponse.status).toBe(200);

      const result = await metadataResponse.json();
      expect(result.metadata.hash).toBe(hash);
      expect(result.metadata.size).toBe(content.length);
      expect(result.metadata.contentType).toBe("application/json");
      expect(result.metadata.refs).toEqual([]);
      expect(result.state.childRefCount).toBe(0);
      expect(result.state.rootRefCount).toBe(0);
    });
  });

  describe("usage", () => {
    it("returns usage statistics", async () => {
      const usageRequest = new Request("http://localhost/usage", {
        method: "GET",
        headers: {
          "X-User-Id": "user1",
        },
      });

      const usageResponse = await doInstance.fetch(usageRequest);
      expect(usageResponse.status).toBe(200);

      const result = await usageResponse.json();
      expect(result).toHaveProperty("nodeCount");
      expect(result).toHaveProperty("readyContentBytes");
      expect(result).toHaveProperty("notReadyNodeCount");
      expect(result).toHaveProperty("leasedNodeCount");
    });
  });

  describe("gc", () => {
    it("triggers garbage collection", async () => {
      const gcRequest = new Request("http://localhost/gc", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ maxNodes: 10 }),
      });

      const gcResponse = await doInstance.fetch(gcRequest);
      expect(gcResponse.status).toBe(200);

      const result = await gcResponse.json();
      expect(result).toHaveProperty("examined");
      expect(result).toHaveProperty("deleted");
      expect(result).toHaveProperty("reclaimedContentBytes");
    });
  });

  describe("error handling", () => {
    it("returns 401 for missing user ID", async () => {
      const request = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-CAS-Hash": "a".repeat(64),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: 100,
          contentType: "text/plain",
          refs: [],
          requestedDurationMs: 60000,
        }),
      });

      const response = await doInstance.fetch(request);
      expect(response.status).toBe(401);
    });

    it("returns 404 for unknown action", async () => {
      const request = new Request("http://localhost/unknown", {
        method: "GET",
        headers: {
          "X-User-Id": "user1",
        },
      });

      const response = await doInstance.fetch(request);
      expect(response.status).toBe(404);
    });
  });
});
