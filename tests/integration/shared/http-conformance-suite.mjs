import { describe, expect, test } from "vitest";
import { SValueContentType } from "../../../packages/protocol/src/index.ts";
import {
  decodeSValue,
  encodeSValue,
} from "../../../packages/svalue-codec/src/index.ts";

function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

export function runHttpConformanceSuite(getRuntime, options) {
  const {
    provider,
    snapshotHashPattern,
    svalueResponses,
    validatesExportFormat,
  } = options;
  const gateway = () => getRuntime().urls.gateway;

  describe(`${provider} HTTP wire conformance`, () => {
    test("preserves Gateway and Markdown request/response contracts", async () => {
      const tenantId = `wire-${provider}`;
      const docId = `wire-${provider}-doc`;
      const base = `${gateway()}/tenants/${tenantId}/docs/markdown`;

      const create = await closeFetch(`${base}/`, {
        method: "POST",
        headers: {
          "X-Doc-Id": docId,
          "Idempotency-Key": "wire-create",
        },
      });
      const created = await create.json();
      expect(create.status).toBe(200);
      expect(create.headers.get("content-type")).toContain("application/json");
      expect(created).toEqual({ success: true, docId, version: 1, state: "ready" });

      const list = await closeFetch(`${base}/`);
      const listed = await list.json();
      expect(list.status).toBe(200);
      expect(listed.count).toBe(1);
      expect(listed.data).toHaveLength(1);
      expect(Object.keys(listed.data[0]).sort()).toEqual([
        "created_at",
        "doc_id",
        "doc_type",
        "owner_id",
        "updated_at",
        "version",
      ]);
      expect(listed.data[0]).toMatchObject({
        doc_id: docId,
        doc_type: "markdown",
        owner_id: tenantId,
        version: 1,
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      });

      const status = await closeFetch(`${base}/${docId}`);
      const statusBody = await status.json();
      expect(status.status).toBe(200);
      expect(Object.keys(statusBody.data).sort()).toEqual([
        "created_at",
        "doc_id",
        "doc_type",
        "state",
        "updated_at",
        "version",
      ]);
      expect(statusBody).toMatchObject({
        success: true,
        data: {
          doc_id: docId,
          doc_type: "markdown",
          state: "ready",
          version: 1,
          created_at: expect.any(Number),
          updated_at: expect.any(Number),
        },
      });

      const firstApply = await applyMarkdown(base, docId, {
        baseVersion: 1,
        description: "wire v2",
        opId: "wire-op-v2",
        operations: [{ kind: "setContent", payload: { content: "# Wire v2" } }],
      });
      await expect(firstApply.json()).resolves.toEqual({ success: true, version: 2 });
      const secondApply = await applyMarkdown(base, docId, {
        baseVersion: 2,
        description: "wire v3",
        operations: [{ kind: "setContent", payload: { content: "# Wire v3" } }],
      });
      await expect(secondApply.json()).resolves.toEqual({ success: true, version: 3 });

      const query = await closeFetch(`${base}/${docId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "getContent" }),
      });
      expect(query.headers.get("content-type")).toContain("application/json");
      await expect(query.json()).resolves.toEqual({
        success: true,
        data: "# Wire v3",
        version: 3,
      });

      const history = await closeFetch(`${base}/${docId}/history?from=2&to=2`);
      const historyBody = await history.json();
      expect(history.status).toBe(200);
      expect(history.headers.get("content-type")).toContain("application/json");
      expect(Object.keys(historyBody).sort()).toEqual(["data", "success", "version"]);
      expect(historyBody.version).toBe(3);
      expect(historyBody.data).toHaveLength(1);
      expect(Object.keys(historyBody.data[0]).sort()).toEqual([
        "description",
        "operations",
        "timestamp",
        "version",
      ]);
      expect(historyBody.data[0]).toMatchObject({
        version: 2,
        timestamp: expect.any(String),
        description: "wire v2",
        operations: [{ kind: "setContent", payload: { content: "# Wire v2" } }],
      });

      const snapshot = await closeFetch(`${base}/${docId}/snapshot`);
      const snapshotBody = await snapshot.json();
      expect(snapshotBody).toEqual({
        success: true,
        version: 3,
        hash: expect.stringMatching(snapshotHashPattern),
        docType: "markdown",
      });

      const ir = await closeFetch(`${base}/${docId}/ir`);
      expect(ir.status).toBe(200);
      expect(ir.headers.get("content-type")).toBe(SValueContentType);
      expect(ir.headers.get("X-Doc-Version")).toBe("3");
      expect(decodeSValue(new Uint8Array(await ir.arrayBuffer())))
        .toEqual({ content: "# Wire v3" });

      const exported = await closeFetch(`${base}/${docId}/export?format=markdown`);
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toContain("text/markdown");
      expect(exported.headers.get("content-disposition"))
        .toMatch(/^attachment; filename="document(?:\.md)?"$/);
      expect(await exported.text()).toBe("# Wire v3");

      const rollback = await closeFetch(`${base}/${docId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      });
      await expect(rollback.json()).resolves.toEqual({ success: true, version: 4 });

      const badFormat = await closeFetch(`${base}/${docId}/export?format=missing`);
      if (validatesExportFormat) {
        const badFormatBody = await badFormat.json();
        expect(badFormat.status).toBe(400);
        expect(badFormatBody).toMatchObject({ success: false });
        expect(badFormatBody.error).toContain("Unknown format");
      } else {
        expect(badFormat.status).toBe(200);
        expect(badFormat.headers.get("content-type")).toContain("text/markdown");
      }

      const nakedHash = await closeFetch(`${base}/${docId}/init_from_hash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: "a".repeat(64), sourceVersion: 1 }),
      });
      expect(nakedHash.status).toBe(404);

      const run = await closeFetch(`${base}/${docId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "wire probe" }),
      });
      const runBody = await run.json();
      expect(run.status).toBe(provider === "azure" ? 501 : 500);
      expect(runBody).toMatchObject({ success: false, error: expect.any(String) });

      const reset = await closeFetch(`${base}/${docId}/reset`, { method: "POST" });
      const resetBody = await reset.json();
      if (provider === "azure") {
        expect(reset.status).toBe(501);
        expect(resetBody).toMatchObject({ success: false, error: expect.any(String) });
      } else {
        expect(reset.status).toBe(200);
        expect(resetBody).toEqual({ success: true });
      }
    }, 60_000);

    test("preserves SValue request and response negotiation", async () => {
      const tenantId = `wire-svalue-${provider}`;
      const docId = `wire-svalue-${provider}-doc`;
      const base = `${gateway()}/tenants/${tenantId}/docs/markdown`;
      const create = await closeFetch(`${base}/`, {
        method: "POST",
        headers: { "X-Doc-Id": docId },
      });
      expect(create.status, await create.clone().text()).toBe(200);

      const apply = await closeFetch(`${base}/${docId}/apply`, {
        method: "POST",
        headers: { "Content-Type": SValueContentType },
        body: encodeSValue({
          baseVersion: 1,
          description: "SValue wire",
          operations: [{ kind: "setContent", payload: { content: "# SValue" } }],
        }).buffer,
      });
      expect(apply.status).toBe(200);
      expect(apply.headers.get("content-type")).toContain("application/json");
      await expect(apply.json()).resolves.toEqual({ success: true, version: 2 });

      const query = await closeFetch(`${base}/${docId}/query`, {
        method: "POST",
        headers: {
          Accept: SValueContentType,
          "Content-Type": SValueContentType,
        },
        body: encodeSValue({ kind: "getContent" }).buffer,
      });
      const history = await closeFetch(`${base}/${docId}/history?from=2&to=2`, {
        headers: { Accept: SValueContentType },
      });
      if (svalueResponses) {
        expect(query.headers.get("content-type")).toBe(SValueContentType);
        expect(decodeSValue(new Uint8Array(await query.arrayBuffer()))).toEqual({
          success: true,
          data: "# SValue",
          version: 2,
        });
        expect(history.headers.get("content-type")).toBe(SValueContentType);
        const body = decodeSValue(new Uint8Array(await history.arrayBuffer()));
        expect(body).toMatchObject({ success: true, version: 2 });
        expect(body.data).toHaveLength(1);
      } else {
        expect(query.headers.get("content-type")).toContain("application/json");
        await expect(query.json()).resolves.toEqual({
          success: true,
          data: "# SValue",
          version: 2,
        });
        expect(history.headers.get("content-type")).toContain("application/json");
        const body = await history.json();
        expect(body).toMatchObject({ success: true, version: 2 });
        expect(body.data).toHaveLength(1);
      }
    }, 30_000);
  });
}

function applyMarkdown(base, docId, value) {
  return closeFetch(`${base}/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}