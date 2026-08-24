import { afterEach, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSValue, SValueContentType } from "../packages/core/src/index.ts";
import { startLocalRuntime } from "./local-runtime.mjs";

let runtime;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

function request(path, init = {}) {
  return fetch(`${runtime.urls.gateway}${path}`, {
    ...init,
    headers: {
      Connection: "close",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

test("SValue Editor retains deltas and snapshots across rollback and restart", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-svalue-editor-"));
  const ports = { gateway: 33787, markdown: 33788 };
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    persistPath,
    ports,
  });

  const create = await request("/users/alice/docs/markdown/", { method: "POST" });
  const created = await create.json();
  expect(create.ok, JSON.stringify(created)).toBe(true);
  expect(created).toMatchObject({ success: true, version: 1 });
  const { docId } = created;

  const apply = await request(`/users/alice/docs/markdown/${docId}/apply`, {
    method: "POST",
    body: JSON.stringify({
      baseVersion: 1,
      description: "set content",
      opId: "set-content-1",
      operations: [{ kind: "setContent", payload: { content: "# Durable" } }],
    }),
  });
  const applied = await apply.json();
  expect(apply.ok, JSON.stringify(applied)).toBe(true);
  expect(applied).toMatchObject({ success: true, version: 2 });

  const retry = await request(`/users/alice/docs/markdown/${docId}/apply`, {
    method: "POST",
    body: JSON.stringify({
      baseVersion: 1,
      description: "set content",
      opId: "set-content-1",
      operations: [{ kind: "setContent", payload: { content: "# Durable" } }],
    }),
  });
  const retried = await retry.json();
  expect(retry.ok, JSON.stringify(retried)).toBe(true);
  expect(retried).toMatchObject({ success: true, version: 2 });

  const stateResponse = await request(`/users/alice/docs/markdown/${docId}/ir`);
  const stateError = stateResponse.ok ? "" : await stateResponse.clone().text();
  expect(stateResponse.ok, `${stateResponse.status}: ${stateError}`).toBe(true);
  expect(stateResponse.headers.get("content-type")).toContain(SValueContentType);
  expect(stateResponse.headers.get("X-Doc-Version")).toBe("2");
  expect(decodeSValue(new Uint8Array(await stateResponse.arrayBuffer()))).toEqual({
    content: "# Durable",
  });

  const query = await request(`/users/alice/docs/markdown/${docId}/query`, {
    method: "POST",
    body: JSON.stringify({ kind: "getContent" }),
  });
  await expect(query.json()).resolves.toMatchObject({
    success: true,
    data: "# Durable",
    version: 2,
  });

  const history = await request(`/users/alice/docs/markdown/${docId}/history`);
  const historyBody = await history.json();
  expect(history.ok, JSON.stringify(historyBody)).toBe(true);
  expect(historyBody.data).toEqual([
    expect.objectContaining({ version: 1, description: "Document created", operations: [] }),
    expect.objectContaining({
      version: 2,
      description: "set content",
      operations: [{ kind: "setContent", payload: { content: "# Durable" } }],
    }),
  ]);

  const snapshot = await request(`/users/alice/docs/markdown/${docId}/snapshot`);
  const snapshotBody = await snapshot.json();
  expect(snapshot.ok, JSON.stringify(snapshotBody)).toBe(true);
  expect(snapshotBody).toMatchObject({ success: true, version: 2 });
  expect(snapshotBody.hash).toMatch(/^[0-9a-f]{64}$/);

  const cloneId = "markdown-clone";
  const clone = await request(`/users/alice/docs/markdown/${cloneId}/init_from_hash`, {
    method: "POST",
    body: JSON.stringify({ hash: snapshotBody.hash, sourceVersion: 2 }),
  });
  const cloned = await clone.json();
  expect(clone.ok, JSON.stringify(cloned)).toBe(true);
  expect(cloned).toMatchObject({ success: true, docId: cloneId, version: 1 });

  const cloneQuery = await request(`/users/alice/docs/markdown/${cloneId}/query`, {
    method: "POST",
    body: JSON.stringify({ kind: "getContent" }),
  });
  await expect(cloneQuery.json()).resolves.toMatchObject({
    success: true,
    data: "# Durable",
    version: 1,
  });

  const crossUserClone = await request("/users/bob/docs/markdown/foreign/init_from_hash", {
    method: "POST",
    body: JSON.stringify({ hash: snapshotBody.hash, sourceVersion: 2 }),
  });
  expect(crossUserClone.ok).toBe(false);

  const rollback = await request(`/users/alice/docs/markdown/${docId}/rollback`, {
    method: "POST",
    body: JSON.stringify({ version: 1 }),
  });
  const rolledBack = await rollback.json();
  expect(rollback.ok, JSON.stringify(rolledBack)).toBe(true);
  expect(rolledBack).toMatchObject({ success: true, version: 3 });

  await runtime.dispose();
  runtime = undefined;
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    persistPath,
    ports,
  });

  const afterRestart = await request(`/users/alice/docs/markdown/${docId}/query`, {
    method: "POST",
    body: JSON.stringify({ kind: "getContent" }),
  });
  const restarted = await afterRestart.json();
  expect(afterRestart.ok, JSON.stringify(restarted)).toBe(true);
  expect(restarted).toMatchObject({ success: true, data: "", version: 3 });

  const afterHistory = await request(`/users/alice/docs/markdown/${docId}/history`);
  const afterHistoryBody = await afterHistory.json();
  expect(afterHistoryBody.data).toHaveLength(3);
  expect(afterHistoryBody.data[2]).toMatchObject({
    version: 3,
    description: "Rollback to version 1",
    operations: [],
  });
}, 60_000);

test("DOCX reconstructs its manifest from snapshot plus retained delta", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-svalue-docx-"));
  const ports = { gateway: 33887, docx: 33889 };
  runtime = await startLocalRuntime({
    docTypes: ["docx"],
    persistPath,
    ports,
  });

  const create = await request("/users/alice/docs/docx/", { method: "POST" });
  const created = await create.json();
  expect(create.ok, JSON.stringify(created)).toBe(true);

  const apply = await request(`/users/alice/docs/docx/${created.docId}/apply`, {
    method: "POST",
    body: JSON.stringify({
      baseVersion: 1,
      description: "append",
      operations: [{ kind: "appendParagraph", payload: { text: "Recovered" } }],
    }),
  });
  const applied = await apply.json();
  expect(apply.ok, JSON.stringify(applied)).toBe(true);
  expect(applied.version).toBe(2);

  await runtime.dispose();
  runtime = undefined;
  runtime = await startLocalRuntime({
    docTypes: ["docx"],
    persistPath,
    ports,
  });

  const query = await request(`/users/alice/docs/docx/${created.docId}/query`, {
    method: "POST",
    body: JSON.stringify({ kind: "getText" }),
  });
  const result = await query.json();
  expect(query.ok, JSON.stringify(result)).toBe(true);
  expect(result).toMatchObject({ success: true, data: "Recovered", version: 2 });
}, 60_000);
