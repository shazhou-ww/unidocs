import { describe, it, expect, beforeEach } from "vitest";
import { CasDurableObject } from "../src/cas/do";
import {
  computeNodeDigest,
  concatenateNodeBytes,
  encodeHeader,
  hashToHex,
  hexToHash,
} from "@unidocs/cas-server-common";
import { createSBlob, encodeSValueWithRefs, SValueContentType } from "@unidocs/protocol/internal";

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

async function computeHash(content: Uint8Array, contentType: string, refs: string[] = []): Promise<string> {
  const childHashes = refs.map(hexToHash);
  const header = encodeHeader(content.length, contentType, childHashes.length);
  const hashBytes = await computeNodeDigest(header, contentType, childHashes, content);
  return hashToHex(hashBytes);
}

async function leaseWithContent(
  doInstance: CasDurableObject,
  content: Uint8Array,
  contentType: string,
  options: { userId?: string; refs?: string[]; durationMs?: number; hash?: string } = {},
) {
  const userId = options.userId ?? "user1";
  const refs = options.refs ?? [];
  const hash = options.hash ?? await computeHash(content, contentType, refs);
  const headers: Record<string, string> = {
    "X-User-Id": userId,
    "X-CAS-Hash": hash,
    "Content-Type": contentType,
    "Content-Length": String(content.length),
    "X-CAS-Lease-Duration": String(options.durationMs ?? 60000),
  };
  if (refs.length > 0) headers["X-CAS-Refs"] = refs.join(",");
  const response = await doInstance.fetch(new Request("http://localhost/leaseWithContent", {
    method: "POST",
    headers,
    body: content,
  }));
  return { hash, response };
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
    await db.exec("CREATE TABLE IF NOT EXISTS cas_root_owners");

    doInstance = new CasDurableObject({} as any, {
      CAS_DB: db as any,
      CAS_R2: r2 as any,
    });
  });

  describe("lease with content", () => {
    it("creates a ready node in one request", async () => {
      const content = new TextEncoder().encode("test content");
      const { hash, response } = await leaseWithContent(doInstance, content, "text/plain");

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.hash).toBe(hash);
      expect(result.ready).toBe(true);
      expect(result.uploadToken).toBeUndefined();
      expect(result.uploadRequired).toBeUndefined();
    });

    it("extends a ready node without requiring a second upload", async () => {
      const content = new TextEncoder().encode("idempotent");
      const first = await leaseWithContent(doInstance, content, "text/plain");
      expect(first.response.status).toBe(200);

      const second = await leaseWithContent(doInstance, content, "text/plain", { hash: first.hash });
      expect(second.response.status).toBe(200);
      const result = await second.response.json();
      expect(result.ready).toBe(true);
      expect(result.hash).toBe(first.hash);
    });

    it("rejects invalid hash format", async () => {
      const content = new TextEncoder().encode("x");
      const { response } = await leaseWithContent(doInstance, content, "text/plain", { hash: "invalid" });
      expect(response.status).toBe(400);
    });

    it("rejects missing content type", async () => {
      const content = new TextEncoder().encode("x");
      const hash = await computeHash(content, "text/plain");
      const response = await doInstance.fetch(new Request("http://localhost/leaseWithContent", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "Content-Length": String(content.length),
        },
        body: content,
      }));
      expect(response.status).toBe(400);
    });

    it("rejects digest mismatch", async () => {
      const content = new TextEncoder().encode("real bytes");
      const { response } = await leaseWithContent(doInstance, content, "text/plain", {
        hash: "a".repeat(64),
      });
      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain("Digest mismatch");
    });

    it("rejects immutable metadata mismatch on a ready node", async () => {
      const content = new TextEncoder().encode("same bytes");
      const first = await leaseWithContent(doInstance, content, "text/plain");
      expect(first.response.status).toBe(200);

      const second = await leaseWithContent(doInstance, content, "application/json", {
        hash: first.hash,
      });
      expect(second.response.status).toBe(409);
      expect((await second.response.json()).error).toContain("metadata mismatch");
    });

    it("creates a node from portable canonical bytes", async () => {
      const content = new TextEncoder().encode("portable upload");
      const contentType = "text/plain";
      const header = encodeHeader(content.length, contentType, 0);
      const bytes = concatenateNodeBytes(
        header,
        new TextEncoder().encode(contentType),
        [],
        content,
      );
      const hash = await computeHash(content, contentType);
      const response = await doInstance.fetch(new Request("http://localhost/leasePortableNode", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.unidocs.cas-node",
          "X-CAS-Hash": hash,
          "X-User-Id": "user1",
        },
        body: bytes,
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ hash, ready: true });
    });
  });

  describe("read", () => {
    it("reads uploaded content", async () => {
      const content = new TextEncoder().encode("read test");
      const { hash, response } = await leaseWithContent(doInstance, content, "text/plain");
      expect(response.status).toBe(200);

      const readResponse = await doInstance.fetch(new Request("http://localhost/read", {
        method: "GET",
        headers: { "X-User-Id": "user1", "X-CAS-Hash": hash },
      }));
      expect(readResponse.status).toBe(200);
      expect(await readResponse.text()).toBe("read test");
    });

    it("returns 404 for non-existent node", async () => {
      const readResponse = await doInstance.fetch(new Request("http://localhost/read", {
        method: "GET",
        headers: { "X-User-Id": "user1", "X-CAS-Hash": "a".repeat(64) },
      }));
      expect(readResponse.status).toBe(404);
    });

    it("returns portable full-node bytes", async () => {
      const content = new TextEncoder().encode("portable");
      const { hash } = await leaseWithContent(doInstance, content, "text/plain");
      const response = await doInstance.fetch(new Request("http://localhost/readNode", {
        headers: { "X-User-Id": "user1", "X-CAS-Hash": hash },
      }));

      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(content.length);
      expect(response.headers.get("Content-Type")).toBe("application/vnd.unidocs.cas-node");
    });
  });

  describe("metadata", () => {
    it("returns node metadata", async () => {
      const content = new TextEncoder().encode("metadata test");
      const { hash, response } = await leaseWithContent(doInstance, content, "application/json");
      expect(response.status).toBe(200);

      const metadataResponse = await doInstance.fetch(new Request("http://localhost/metadata", {
        method: "GET",
        headers: { "X-User-Id": "user1", "X-CAS-Hash": hash },
      }));
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
      const childContent = new TextEncoder().encode("child content");
      const child = await leaseWithContent(doInstance, childContent, "text/plain");
      expect(child.response.status).toBe(200);

      const parentContent = new TextEncoder().encode('{"ref":"child"}');
      const parent = await leaseWithContent(doInstance, parentContent, "application/json", {
        refs: [child.hash],
      });
      expect(parent.response.status).toBe(200);
      const parentLease = await parent.response.json();
      expect(parentLease.hash).toBe(parent.hash);
      expect(parentLease.ready).toBe(true);

      const childMetadataResponse = await doInstance.fetch(new Request("http://localhost/metadata", {
        method: "GET",
        headers: { "X-User-Id": "user1", "X-CAS-Hash": child.hash },
      }));
      expect(childMetadataResponse.status).toBe(200);
      expect((await childMetadataResponse.json()).state.childRefCount).toBe(1);

      const parentMetadataResponse = await doInstance.fetch(new Request("http://localhost/metadata", {
        method: "GET",
        headers: { "X-User-Id": "user1", "X-CAS-Hash": parent.hash },
      }));
      expect(parentMetadataResponse.status).toBe(200);
      expect((await parentMetadataResponse.json()).metadata.refs).toEqual([child.hash]);
    });

    it("rejects parent creation when child is not ready", async () => {
      const childHash = "b".repeat(64);
      const parentContent = new TextEncoder().encode('{"ref":"not-ready-child"}');
      const parent = await leaseWithContent(doInstance, parentContent, "application/json", {
        refs: [childHash],
      });
      expect(parent.response.status).toBe(409);
      expect((await parent.response.json()).error).toContain("not ready");
    });

    it("derives and validates SValue child refs", async () => {
      const child = await leaseWithContent(
        doInstance,
        new TextEncoder().encode("stored child"),
        "text/plain",
      );
      const encoded = encodeSValueWithRefs({ blob: createSBlob(child.hash) });
      const parent = await leaseWithContent(doInstance, encoded.data, SValueContentType, {
        refs: [...encoded.refs],
      });

      expect(parent.response.status).toBe(200);
      const metadata = await doInstance.fetch(new Request("http://localhost/metadata", {
        headers: { "X-User-Id": "user1", "X-CAS-Hash": parent.hash },
      }));
      expect((await metadata.json()).metadata.refs).toEqual([child.hash]);
    });

    it("rejects SValue refs that disagree with encoded tags", async () => {
      const child = await leaseWithContent(
        doInstance,
        new TextEncoder().encode("stored child"),
        "text/plain",
      );
      const encoded = encodeSValueWithRefs({ blob: createSBlob(child.hash) });
      const parent = await leaseWithContent(doInstance, encoded.data, SValueContentType);

      expect(parent.response.status).toBe(400);
      expect((await parent.response.json()).error).toContain("refs do not match");
    });

    it("rejects non-canonical SValue content", async () => {
      const nonCanonicalOne = new Uint8Array([0x18, 0x01]);
      const parent = await leaseWithContent(doInstance, nonCanonicalOne, SValueContentType);

      expect(parent.response.status).toBe(400);
      expect((await parent.response.json()).error).toContain("Invalid SValue content");
    });
  });

  describe("lease existing", () => {
    it("extends a ready node", async () => {
      const content = new TextEncoder().encode("lease existing");
      const { hash, response } = await leaseWithContent(doInstance, content, "text/plain");
      expect(response.status).toBe(200);

      const extend = await doInstance.fetch(new Request("http://localhost/leaseExisting", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": hash,
          "X-CAS-Lease-Duration": "120000",
        },
      }));
      expect(extend.status).toBe(200);
      const result = await extend.json();
      expect(result.ready).toBe(true);
      expect(result.hash).toBe(hash);
    });

    it("returns 404 for unknown hash", async () => {
      const extend = await doInstance.fetch(new Request("http://localhost/leaseExisting", {
        method: "POST",
        headers: {
          "X-User-Id": "user1",
          "X-CAS-Hash": "a".repeat(64),
        },
      }));
      expect(extend.status).toBe(404);
    });
  });

  describe("root assignments", () => {
    async function assign(
      requestId: string,
      assignments: { owner: string; hash: string | null }[],
    ): Promise<Response> {
      return doInstance.fetch(new Request("http://localhost/assignRoots", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": "user1",
        },
        body: JSON.stringify({ requestId, assignments }),
      }));
    }

    async function rootCount(hash: string): Promise<number> {
      const response = await doInstance.fetch(new Request("http://localhost/metadata", {
        headers: { "X-CAS-Hash": hash, "X-User-Id": "user1" },
      }));
      return (await response.json()).state.rootRefCount;
    }

    it("moves one owner between roots and releases it", async () => {
      const first = await leaseWithContent(doInstance, new TextEncoder().encode("first"), "text/plain");
      const second = await leaseWithContent(doInstance, new TextEncoder().encode("second"), "text/plain");

      expect((await assign("assign:1", [{ owner: "doc:d:delta:1", hash: first.hash }])).status).toBe(200);
      expect(await rootCount(first.hash)).toBe(1);

      expect((await assign("assign:2", [{ owner: "doc:d:delta:1", hash: second.hash }])).status).toBe(200);
      expect(await rootCount(first.hash)).toBe(0);
      expect(await rootCount(second.hash)).toBe(1);

      expect((await assign("assign:3", [{ owner: "doc:d:delta:1", hash: null }])).status).toBe(200);
      expect(await rootCount(second.hash)).toBe(0);
      expect(db.tables.get("cas_root_owners")).toEqual([]);
    });

    it("is idempotent and rejects request ID conflicts", async () => {
      const node = await leaseWithContent(doInstance, new TextEncoder().encode("root"), "text/plain");
      const assignment = [{ owner: "doc:d:snapshot:1", hash: node.hash }];

      expect((await assign("same", assignment)).status).toBe(200);
      const retry = await assign("same", assignment);
      expect(retry.status).toBe(200);
      expect((await retry.json()).idempotent).toBe(true);
      expect(await rootCount(node.hash)).toBe(1);

      expect((await assign("same", [{ owner: "doc:d:snapshot:1", hash: null }])).status).toBe(409);
      expect(await rootCount(node.hash)).toBe(1);
    });

    it("counts distinct owners of the same root", async () => {
      const node = await leaseWithContent(doInstance, new TextEncoder().encode("shared"), "text/plain");
      const response = await assign("two", [
        { owner: "doc:d:delta:1", hash: node.hash },
        { owner: "doc:d:snapshot:1", hash: node.hash },
      ]);

      expect(response.status).toBe(200);
      expect(await rootCount(node.hash)).toBe(2);
    });

    it("rejects duplicate owners and missing roots", async () => {
      expect((await assign("duplicate", [
        { owner: "same", hash: null },
        { owner: "same", hash: null },
      ])).status).toBe(400);
      expect((await assign("missing", [
        { owner: "doc:d:delta:1", hash: "f".repeat(64) },
      ])).status).toBe(404);
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
      const request = new Request("http://localhost/leaseWithContent", {
        method: "POST",
        headers: {
          "X-CAS-Hash": "a".repeat(64),
          "Content-Type": "text/plain",
          "Content-Length": "1",
        },
        body: "x",
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
