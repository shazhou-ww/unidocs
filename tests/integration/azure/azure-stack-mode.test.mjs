/**
 * Azure stack mode: the Azure application stack talks to the EMBEDDED local
 * CAS middleware (registered unidocs-azure stack) with stack-scoped
 * capabilities instead of the transitional shared-key cf legacy CAS worker.
 * The azure gateway signs delegated CAS capabilities with the azure stack
 * key, the azure doc services route /stacks/unidocs-azure/tenants/... to the
 * middleware edge, and the markdown doc flow runs end-to-end.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { startAzureRuntime } from "../../../stacks/unidocs-azure/local/runtime.mjs";
import { casReadPermission, createPkcs8CapabilityIssuer } from "../../../packages/service-auth/src/index.ts";

let runtime;

beforeAll(async () => {
  runtime = await startAzureRuntime({
    docTypes: ["markdown"],
    internalAuthMode: "stack",
  });
}, 240_000);

afterAll(async () => {
  await runtime?.dispose();
}, 60_000);

function gwFetch(path, init = {}) {
  return fetch(`${runtime.urls.gateway}${path}`, {
    ...init,
    headers: { Connection: "close", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
}

test("azure stack mode: markdown doc flow runs through the embedded middleware", async () => {
  expect(runtime.stackFixture).toBeDefined();
  expect(runtime.stackFixture.stackId).toBe("unidocs-azure");
  expect(runtime.middleware.urls.edge).toBeDefined();

  const create = await gwFetch("/tenants/alice/docs/markdown/", { method: "POST" });
  const created = await create.json();
  expect(create.ok, JSON.stringify(created)).toBe(true);
  const { docId } = created;

  const apply = await gwFetch(`/tenants/alice/docs/markdown/${docId}/apply`, {
    method: "POST",
    body: JSON.stringify({
      baseVersion: 1,
      description: "set content",
      opId: "azure-stack-set-1",
      operations: [{ kind: "setContent", payload: { content: "# Azure stack" } }],
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
  expect(result).toMatchObject({ success: true, data: "# Azure stack", version: 2 });

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

  // The embedded middleware is reachable and the azure stack is registered.
  const edgeHealth = await fetch(`${runtime.middleware.urls.edge}/health`, { headers: { Connection: "close" } });
  expect(edgeHealth.status).toBe(200);

  // Direct middleware probe: an azure stack capability must be verifiable at the edge.
  const fixture = runtime.stackFixture;
  const issuer = await createPkcs8CapabilityIssuer({
    issuer: fixture.issuer,
    kid: fixture.kid,
    privateKeyPkcs8: fixture.privateKeyPkcs8,
  });
  const readerToken = await issuer.issue({
    subject: "azure-probe",
    audience: fixture.audience,
    tenantId: "alice",
    permissions: [casReadPermission("alice")],
  });
  const probe = await fetch(
    `${runtime.middleware.urls.edge}/stacks/unidocs-azure/tenants/alice/cas/nodes/${"a".repeat(64)}/metadata`,
    { headers: { Authorization: `Bearer ${readerToken}`, Connection: "close" } },
  );
  expect(probe.status).toBe(404); // authenticated; node simply absent
  const probeBody = await probe.json();
  expect(probeBody.error).toBe("NODE_NOT_FOUND");

  // markdown 无 SBlob：会话不写 CAS 根（内容图为空），中间件无残留 ——
  // 这是文档流程的正确默认，不是接线错误。
  const retained = await runtime.middleware.storage.middlewareRetainedRoots("unidocs-azure", "alice");
  expect(retained).toEqual([]);
}, 60_000);
