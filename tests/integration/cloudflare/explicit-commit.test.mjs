import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

const ports = { gateway: 35787, markdown: 35788, cas: 35791, admin: 35792, mockOidc: 35793 };
const bindingDefaults = { markdown: { DOC_EXPLICIT_COMMITS: "1" } };
let runtime;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

async function call(path, body) {
  const response = await fetch(`${runtime.urls.gateway}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Connection: "close", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function create(tenant = "receipt-user") {
  const response = await fetch(`${runtime.urls.gateway}/tenants/${tenant}/docs/markdown/`, { method: "POST", headers: { Connection: "close" } });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return { tenant, docId: body.docId, path: `/tenants/${tenant}/docs/markdown/${body.docId}` };
}

function candidate(opId = "receipt-op", baseVersion = 1) {
  return { commitMode: "receipt-v1", opId, baseVersion, description: "explicit edit",
    operations: [{ kind: "setContent", payload: { content: "# Original candidate" } }] };
}

test("explicit commit remains pending across lost CAS acknowledgement, blocks old writes and returns its original receipt after restart", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "explicit-commit-"));
  try {
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, persistPath, casFault: "after-commit" });
    const { stackFixture, capabilityFixture } = runtime;
    const { tenant, docId, path } = await create();
    const { sessionId } = await runtime.storage.sessionIdentity("markdown", docId, tenant);
    const request = candidate();
    const first = await call(`${path}/apply`, request);
    expect(first.status, JSON.stringify(first.body)).toBe(503);
    expect(first.body).toMatchObject({ success: false, version: 1, receipt: { state: "pending", opId: request.opId, baseVersion: 1 } });
    const roots = await runtime.storage.middlewareRetainedRoots(stackFixture.stackId, tenant);
    expect(roots).toHaveLength(2);
    const rootRequest = `session:${sessionId}:commit:${request.opId}:roots`;
    expect(await runtime.storage.middlewareRootRefRequestIds(stackFixture.stackId, tenant)).toContain(rootRequest);
    expect((await call(`${path}/apply`, { ...request, commitMode: undefined, opId: "old-client" })).status).toBe(409);
    expect((await call(`${path}/rollback`, { version: 1 })).status).toBe(409);
    expect((await call(`${path}/apply`, { ...request, opId: "another-intent" })).body.error).toBe("pending_exists");
    expect((await call(`${path}/apply`, { ...request, description: "different" })).body.error).toBe("payload_mismatch");
    expect((await call(`${path}/query`, { kind: "getContent" })).body).toMatchObject({ version: 1, data: "" });
    expect((await call(`${path}/history`)).status).toBe(200);
    await runtime.dispose(); runtime = undefined;
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, persistPath, stackFixture, capabilityFixture });
    expect((await call(`${path}/apply`, { ...request, commitMode: undefined, opId: "old-flag-disabled" })).status).toBe(409);
    expect((await call(`${path}/apply`, request)).status).toBe(400);
    expect((await call(`${path}/query`, { kind: "getContent" })).body).toMatchObject({ version: 1, data: "" });
    await runtime.dispose(); runtime = undefined;
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, persistPath, stackFixture, capabilityFixture });
    expect((await call(`${path}/apply`, { ...request, commitMode: undefined, opId: "old-after-restart" })).status).toBe(409);
    const recovered = await call(`${path}/apply`, request);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body).toEqual({ success: true, version: 2, receipt: { ...first.body.receipt, state: "committed", version: 2 } });
    expect((await call(`${path}/query`, { kind: "getContent" })).body).toMatchObject({ version: 2, data: "# Original candidate" });
    expect((await call(`${path}/apply`, request)).body).toEqual(recovered.body);
    const retained = await runtime.storage.middlewareRetainedRoots(stackFixture.stackId, tenant);
    expect(retained).toHaveLength(roots.length); expect(retained).toEqual(expect.arrayContaining(roots));
    expect((await runtime.storage.middlewareRootRefRequestIds(stackFixture.stackId, tenant)).filter(value => value === rootRequest)).toHaveLength(1);
    expect((await call(`${path}/apply`, { ...candidate("old-ok", 2), commitMode: undefined })).body).toMatchObject({ success: true, version: 3 });
    await runtime.dispose(); runtime = undefined;
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, persistPath, stackFixture, capabilityFixture });
    expect((await call(`${path}/apply`, request)).body).toEqual(recovered.body);
    expect((await call(`${path}/query`, { kind: "getContent" })).body.version).toBe(3);
  } finally {
    await runtime?.dispose(); runtime = undefined;
    await rm(persistPath, { recursive: true, force: true });
  }
}, 120_000);

test("explicit success, stale base and invalid operations have stable receipts without changing legacy dedup", async () => {
  runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults });
  const { path } = await create();
  const request = candidate();
  const first = await call(`${path}/apply`, request);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.receipt).toMatchObject({ state: "committed", version: 2 });
  expect([403, 404]).toContain((await call(path.replace("/tenants/receipt-user/", "/tenants/other-user/") + "/apply", request)).status);
  expect((await call(`${path}/apply`, { ...request, opId: "bad/id" })).status).toBe(400);
  expect((await call(`${path}/apply`, { ...request, description: "different" })).body.error).toBe("payload_mismatch");
  const stale = candidate("stale", 1);
  const rejected = await call(`${path}/apply`, stale);
  expect(rejected.body.receipt).toMatchObject({ state: "rejected", reason: "version_conflict", headVersion: 2 });
  expect((await call(`${path}/apply`, stale)).body.receipt).toEqual(rejected.body.receipt);
  const invalid = { ...candidate("invalid", 2), operations: [{ kind: "setContent" }] };
  const refused = await call(`${path}/apply`, invalid);
  expect(refused.body.receipt).toMatchObject({ state: "rejected", reason: "invalid_operations" });
  expect((await call(`${path}/apply`, invalid)).body.receipt).toEqual(refused.body.receipt);
  const legacy = { ...candidate("legacy", 2), commitMode: undefined };
  expect((await call(`${path}/apply`, legacy)).body).toMatchObject({ success: true, version: 3 });
  expect((await call(`${path}/apply`, { ...legacy, baseVersion: 3, description: "legacy rebase" })).body).toMatchObject({ success: true, version: 3 });
}, 60_000);

test("explicit mode fails closed when disabled and does not apply the candidate", async () => {
  runtime = await startLocalRuntime({ docTypes: ["markdown"], ports });
  const { path } = await create();
  expect((await call(`${path}/apply`, candidate())).status).toBe(400);
  expect((await call(`${path}/query`, { kind: "getContent" })).body).toMatchObject({ version: 1, data: "" });
  expect((await call(`${path}/apply`, { ...candidate(), commitMode: undefined })).body).toMatchObject({ success: true, version: 2 });
}, 60_000);

test("failure before CAS confirmation keeps the intent pending and concurrent identical retries share one result", async () => {
  runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, casFault: true });
  const { path, tenant, docId } = await create();
  const request = candidate("before-confirmation");
  const first = await call(`${path}/apply`, request);
  expect(first.status).toBe(503);
  expect(first.body.receipt.state).toBe("pending");
  const { sessionId } = await runtime.storage.sessionIdentity("markdown", docId, tenant);
  const rootRequest = `session:${sessionId}:commit:${request.opId}:roots`;
  expect(await runtime.storage.middlewareRootRefRequestIds(runtime.stackFixture.stackId, tenant)).not.toContain(rootRequest);
  const [retry, duplicate] = await Promise.all([call(`${path}/apply`, request), call(`${path}/apply`, request)]);
  expect(retry.status).toBe(200);
  expect(duplicate).toEqual(retry);
  expect(retry.body.receipt).toMatchObject({ state: "committed", version: 2 });
  expect((await call(`${path}/query`, { kind: "getContent" })).body.version).toBe(2);
}, 60_000);

test("explicit snapshot-threshold commit recovers both roots and its terminal receipt after response loss", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "explicit-snapshot-"));
  try {
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, persistPath });
    const { stackFixture, capabilityFixture } = runtime;
    const { path, docId, tenant } = await create();
    for (let baseVersion = 1; baseVersion < 20; baseVersion++) {
      const result = await call(`${path}/apply`, { ...candidate(`warmup-${baseVersion}`, baseVersion), commitMode: undefined });
      expect(result.status).toBe(200);
    }
    await runtime.dispose(); runtime = undefined;
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, persistPath, stackFixture, capabilityFixture, casFault: "after-commit" });
    const request = candidate("snapshot-op", 20);
    const pending = await call(`${path}/apply`, request);
    expect(pending.status).toBe(503);
    expect(pending.body.receipt).toMatchObject({ state: "pending", baseVersion: 20 });
    await runtime.dispose(); runtime = undefined;
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, persistPath, stackFixture, capabilityFixture });
    const recovered = await call(`${path}/apply`, request);
    expect(recovered.body).toMatchObject({ success: true, version: 21, receipt: { state: "committed", version: 21 } });
    expect((await runtime.storage.snapshotIndex("markdown", docId)).map(row => row.version)).toEqual([1, 21]);
    const roots = await runtime.storage.middlewareRetainedRoots(stackFixture.stackId, tenant);
    expect(roots).toHaveLength(2);
    expect(roots.every(row => row.count === 1)).toBe(true);
    expect((await call(`${path}/apply`, request)).body).toEqual(recovered.body);
    expect((await call(`${path}/query`, { kind: "getContent" })).body).toMatchObject({ version: 21, data: "# Original candidate" });
  } finally {
    await runtime?.dispose(); runtime = undefined;
    await rm(persistPath, { recursive: true, force: true });
  }
}, 120_000);