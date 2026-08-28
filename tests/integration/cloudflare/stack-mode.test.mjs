/**
 * Stack mode: the Cloudflare application stack talks to the LOCAL canonical
 * middleware with stack-scoped capabilities instead of the legacy shared-key
 * CAS worker. The gateway signs delegated CAS capabilities with the
 * registered unidocs-cloudflare stack key (carrying the refDomain claim), the
 * editor DO routes /stacks/{stackId}/tenants/{tenantId}/... to the middleware,
 * and the full markdown doc flow (create -> apply -> query -> history ->
 * rollback) must work end-to-end.
 */

import { afterEach, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

let runtime;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

const PORTS = {
  gateway: 36787,
  markdown: 36788,
  cas: 36791,
  admin: 36792,
  mockOidc: 36793,
  edge: 36794,
};

function gwFetch(path, init = {}) {
  return fetch(`${runtime.urls.gateway}${path}`, {
    ...init,
    headers: { Connection: "close", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
}

test("stack mode: markdown doc flow runs through the middleware", async () => {
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: PORTS,
  });
  const stackId = runtime.stackFixture.stackId;

  const create = await gwFetch("/tenants/alice/docs/markdown/", { method: "POST" });
  const createText = await create.clone().text();
  expect(create.ok, `${create.status}: ${createText}`).toBe(true);
  const created = JSON.parse(createText);
  expect(created).toMatchObject({ success: true, version: 1 });
  const { docId } = created;

  const apply = await gwFetch(`/tenants/alice/docs/markdown/${docId}/apply`, {
    method: "POST",
    body: JSON.stringify({
      baseVersion: 1,
      description: "set content",
      opId: "stack-set-1",
      operations: [{ kind: "setContent", payload: { content: "# Stack mode" } }],
    }),
  });
  const applied = await apply.json();
  expect(apply.ok, JSON.stringify(applied)).toBe(true);
  expect(applied).toMatchObject({ success: true, version: 2 });

  const query = await gwFetch(`/tenants/alice/docs/markdown/${docId}/query`, {
    method: "POST",
    body: JSON.stringify({ kind: "getContent" }),
  });
  const result = await query.json();
  expect(result).toMatchObject({ success: true, data: "# Stack mode", version: 2 });

  const history = await gwFetch(`/tenants/alice/docs/markdown/${docId}/history`);
  const historyBody = await history.json();
  expect(historyBody.data.map((entry) => entry.version)).toEqual([1, 2]);

  const rollback = await gwFetch(`/tenants/alice/docs/markdown/${docId}/rollback`, {
    method: "POST",
    body: JSON.stringify({ version: 1 }),
  });
  const rolledBack = await rollback.json();
  expect(rollback.ok, JSON.stringify(rolledBack)).toBe(true);
  expect(rolledBack).toMatchObject({ success: true, version: 3 });

  // The middleware storage holds exactly the retained set: current delta + current snapshot.
  const retained = await runtime.storage.middlewareRetainedRoots(stackId, "alice");
  expect(retained).toHaveLength(2);
  expect(retained.every((row) => row.count === 1)).toBe(true);

  // The public edge is up and isolated.
  const health = await fetch(`${runtime.urls.edge}/health`, { headers: { Connection: "close" } });
  expect(health.status).toBe(200);
  const internal = await fetch(`${runtime.urls.edge}/_internal/health`, { headers: { Connection: "close" } });
  expect(internal.status).toBe(404);
}, 90_000);

test("stack mode: docx apply/query also runs through the middleware", async () => {
  runtime = await startLocalRuntime({
    docTypes: ["docx"],
    ports: { ...PORTS, markdown: 36789, docx: 36788 },
  });
  const stackId = runtime.stackFixture.stackId;

  const create = await gwFetch("/tenants/alice/docs/docx/", { method: "POST" });
  const created = await create.json();
  expect(create.ok, JSON.stringify(created)).toBe(true);
  const { docId } = created;

  const apply = await gwFetch(`/tenants/alice/docs/docx/${docId}/apply`, {
    method: "POST",
    body: JSON.stringify({
      baseVersion: 1,
      description: "append",
      operations: [{ kind: "appendParagraph", payload: { text: "Stack docx" } }],
    }),
  });
  const applied = await apply.json();
  expect(apply.ok, JSON.stringify(applied)).toBe(true);
  expect(applied).toMatchObject({ success: true, version: 2 });

  const query = await gwFetch(`/tenants/alice/docs/docx/${docId}/query`, {
    method: "POST",
    body: JSON.stringify({ kind: "getText" }),
  });
  const result = await query.json();
  expect(result).toMatchObject({ success: true, data: "Stack docx", version: 2 });

  const retained = await runtime.storage.middlewareRetainedRoots(stackId, "alice");
  expect(retained).toHaveLength(2);
  expect(retained.every((row) => row.count === 1)).toBe(true);
}, 90_000);
