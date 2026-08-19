import { describe, it, expect, beforeEach } from "vitest";
import { CasDurableObject } from "../src/cas/do";
import { computeNodeDigest, encodeHeader, hashToHex, hexToHash } from "@unidocs/cas";

// ─── Mock D1 Database ───────────────────────────────────────────────
// Stores rows as plain objects with named columns.

class MockD1Database {
  tables: Map<string, Record<string, any>[]> = new Map();

  async exec(sql: string) {
    const m = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
    if (m && !this.tables.has(m[1])) this.tables.set(m[1], []);
  }

  prepare(sql: string) {
    return new MockD1PreparedStatement(sql, this);
  }

  async batch(stmts: MockD1PreparedStatement[]) {
    for (const s of stmts) await s.run();
  }
}

class MockD1PreparedStatement {
  private sql: string;
  private params: any[] = [];
  private db: MockD1Database;

  constructor(sql: string, db: MockD1Database) {
    this.sql = sql;
    this.db = db;
  }

  bind(...params: any[]) {
    this.params = params;
    return this;
  }

  async run() {
    // INSERT INTO table (cols...) VALUES (?, ...)
    const insertMatch = this.sql.match(/INSERT INTO (\w+)\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const table = insertMatch[1];
      const cols = insertMatch[2].split(",").map((s) => s.trim());
      const rows = this.db.tables.get(table) || [];
      const row: Record<string, any> = {};
      cols.forEach((col, i) => { row[col] = this.params[i]; });
      // Simulate DEFAULT values for columns not in INSERT
      if (table === "cas_nodes") {
        row.child_ref_count ??= 0;
        row.root_ref_count ??= 0;
      }
      rows.push(row);
      this.db.tables.set(table, rows);
      return { success: true };
    }

    // UPDATE table SET col = col + ? WHERE ...
    const updateIncMatch = this.sql.match(/UPDATE (\w+) SET (\w+) = (\w+) \+ (\d+|\?)/i);
    if (updateIncMatch) {
      const table = updateIncMatch[1];
      const col = updateIncMatch[2];
      const rows = this.db.tables.get(table) || [];
      const incrementStr = updateIncMatch[4];
      let increment: number;
      if (incrementStr === "?") {
        increment = this.params[0];
      } else {
        increment = parseInt(incrementStr);
      }
      const whereParams = this.findWhereParams();
      for (const row of rows) {
        if (this.matchesWhere(row, whereParams)) {
          row[col] = (row[col] || 0) + increment;
        }
      }
      return { success: true };
    }

    // UPDATE table SET col = ? WHERE ...
    const updateSetMatch = this.sql.match(/UPDATE (\w+) SET (\w+) = \?/i);
    if (updateSetMatch) {
      const table = updateSetMatch[1];
      const col = updateSetMatch[2];
      const rows = this.db.tables.get(table) || [];
      const whereParams = this.findWhereParams();
      for (const row of rows) {
        if (this.matchesWhere(row, whereParams)) {
          row[col] = this.params[0];
        }
      }
      return { success: true };
    }

    // DELETE FROM table WHERE ...
    const deleteMatch = this.sql.match(/DELETE FROM (\w+)/i);
    if (deleteMatch) {
      const table = deleteMatch[1];
      const rows = this.db.tables.get(table) || [];
      const whereParams = this.findWhereParams();
      const remaining = rows.filter((r) => !this.matchesWhere(r, whereParams));
      this.db.tables.set(table, remaining);
      return { success: true };
    }

    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    const tableMatch = this.sql.match(/FROM (\w+)/i);
    if (!tableMatch) return null;
    const table = tableMatch[1];
    const rows = this.db.tables.get(table) || [];
    const whereParams = this.findWhereParams();
    const row = rows.find((r) => this.matchesWhere(r, whereParams));
    return (row || null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const tableMatch = this.sql.match(/FROM (\w+)/i);
    if (!tableMatch) return { results: [] };
    const table = tableMatch[1];
    const rows = this.db.tables.get(table) || [];
    const whereParams = this.findWhereParams();
    const matched = rows.filter((r) => this.matchesWhere(r, whereParams));

    // Handle ORDER BY ordinal ASC for cas_edges
    if (this.sql.match(/ORDER BY (\w+) ASC/i)) {
      const orderCol = this.sql.match(/ORDER BY (\w+) ASC/i)![1];
      matched.sort((a, b) => (a[orderCol] || 0) - (b[orderCol] || 0));
    }

    // Handle SELECT specific columns
    const selectMatch = this.sql.match(/SELECT\s+(.+?)\s+FROM/i);
    if (selectMatch && !selectMatch[1].includes("*")) {
      const cols = selectMatch[1].split(",").map((s) => s.trim());
      return {
        results: matched.map((r) => {
          const obj: Record<string, any> = {};
          for (const col of cols) {
            obj[col] = r[col];
          }
          return obj as T;
        }),
      };
    }

    return { results: matched as T[] };
  }

  /** Extract WHERE params: everything after the non-WHERE params. */
  private findWhereParams(): any[] {
    // Count the ? placeholders before WHERE
    const whereIdx = this.sql.toUpperCase().indexOf("WHERE");
    if (whereIdx === -1) return [];
    const beforeWhere = this.sql.substring(0, whereIdx);
    const preCount = (beforeWhere.match(/\?/g) || []).length;
    return this.params.slice(preCount);
  }

  /** Check if a row matches WHERE params (assumes col = ? pattern). */
  private matchesWhere(row: Record<string, any>, whereParams: any[]): boolean {
    if (whereParams.length === 0) return true;
    const whereIdx = this.sql.toUpperCase().indexOf("WHERE");
    if (whereIdx === -1) return true;
    const whereClause = this.sql.substring(whereIdx);
    const colMatches = whereClause.match(/(\w+)\s*=\s*\?/gi);
    if (!colMatches) return true;
    for (let i = 0; i < colMatches.length; i++) {
      const col = colMatches[i].match(/(\w+)\s*=\s*\?/i)![1];
      if (row[col] !== whereParams[i]) return false;
    }
    return true;
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

  describe("child refs", () => {
    it("creates parent with child ref and increments child ref count", async () => {
      // Create and upload child node
      const childContent = new TextEncoder().encode("child content");
      const childHash = await computeHash(childContent, "text/plain");

      const childLeaseRequest = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": childHash,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: childContent.length,
          contentType: "text/plain",
          refs: [],
          requestedDurationMs: 60000,
        }),
      });

      const childLeaseResponse = await doInstance.fetch(childLeaseRequest);
      const childLease = await childLeaseResponse.json();

      const childUploadRequest = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": childHash,
          "X-CAS-Upload-Token": childLease.uploadToken,
        },
        body: childContent,
      });

      await doInstance.fetch(childUploadRequest);

      // Create parent node with child ref
      const parentContent = new TextEncoder().encode('{"ref":"child"}');
      const header = encodeHeader(parentContent.length, "application/json", 1);
      const hashBytes = await computeNodeDigest(header, "application/json", [hexToHash(childHash)], parentContent);
      const parentHash = hashToHex(hashBytes);

      const parentLeaseRequest = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": parentHash,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: parentContent.length,
          contentType: "application/json",
          refs: [childHash],
          requestedDurationMs: 60000,
        }),
      });

      const parentLeaseResponse = await doInstance.fetch(parentLeaseRequest);
      expect(parentLeaseResponse.status).toBe(200);

      const parentLease = await parentLeaseResponse.json();
      expect(parentLease.hash).toBe(parentHash);
      expect(parentLease.uploadRequired).toBe(true);

      // Upload parent
      const parentUploadRequest = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": parentHash,
          "X-CAS-Upload-Token": parentLease.uploadToken,
        },
        body: parentContent,
      });

      const parentUploadResponse = await doInstance.fetch(parentUploadRequest);
      expect(parentUploadResponse.status).toBe(200);

      // Verify child's ref count incremented
      const childMetadataRequest = new Request("http://localhost/metadata", {
        method: "GET",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": childHash,
        },
      });

      const childMetadataResponse = await doInstance.fetch(childMetadataRequest);
      expect(childMetadataResponse.status).toBe(200);

      const childMetadata = await childMetadataResponse.json();
      expect(childMetadata.state.childRefCount).toBe(1);

      // Verify parent's metadata includes the ref
      const parentMetadataRequest = new Request("http://localhost/metadata", {
        method: "GET",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": parentHash,
        },
      });

      const parentMetadataResponse = await doInstance.fetch(parentMetadataRequest);
      expect(parentMetadataResponse.status).toBe(200);

      const parentMetadata = await parentMetadataResponse.json();
      expect(parentMetadata.metadata.refs).toEqual([childHash]);
    });

    it("rejects parent creation when child is not ready", async () => {
      const childHash = "b".repeat(64);
      const parentContent = new TextEncoder().encode('{"ref":"not-ready-child"}');
      const header = encodeHeader(parentContent.length, "application/json", 1);
      const hashBytes = await computeNodeDigest(header, "application/json", [hexToHash(childHash)], parentContent);
      const parentHash = hashToHex(hashBytes);

      const leaseRequest = new Request("http://localhost/lease", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": parentHash,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: parentContent.length,
          contentType: "application/json",
          refs: [childHash],
          requestedDurationMs: 60000,
        }),
      });

      const leaseResponse = await doInstance.fetch(leaseRequest);
      expect(leaseResponse.status).toBe(500);

      const error = await leaseResponse.json();
      expect(error.error).toContain("not ready");
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
