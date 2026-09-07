import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { docSessionObjectName } from "../../../packages/doctype-server-common/src/session-object-name.ts";

const ports = { gateway: 36787, markdown: 36788, cas: 36791, admin: 36792, mockOidc: 36793 };
const bindingDefaults = { markdown: { DOC_EXPLICIT_COMMITS: "1" } };
const bundleEntryOverrides = { "packages/cloudflare-markdown/src/worker.ts": "tests/integration/cloudflare/explicit-commit-fault-worker.ts" };

test.each(["before-roots", "before-pending", "after-pending", "after-delta", "after-snapshot", "after-clear", "after-receipt", "after-finalize"])("recovers original intent after %s failure in the real editor", async fault => {
  const persistPath = await mkdtemp(join(tmpdir(), "explicit-fault-"));
  let runtime;
  const send = async (url, body) => {
    const response = await fetch(url, { method: "POST", headers: { Connection: "close", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, bundleEntryOverrides, persistPath });
    const { stackFixture, capabilityFixture } = runtime;
    const tenant = "fault-user";
    const created = await send(`${runtime.urls.gateway}/tenants/${tenant}/docs/markdown/`);
    expect(created.status).toBe(200);
    const docId = created.body.docId;
    const { sessionId } = await runtime.storage.sessionIdentity("markdown", docId, tenant);
    const object = encodeURIComponent(docSessionObjectName(tenant, sessionId));
    const inspect = () => send(`${runtime.urls.markdown}/_test/inspect?object=${object}`, {});
    const path = `${runtime.urls.gateway}/tenants/${tenant}/docs/markdown/${docId}`;
    const baseVersion = fault === "after-snapshot" ? 20 : 1;
    for (let version = 1; version < baseVersion; version++) {
      const warmup = await send(`${path}/apply`, { baseVersion: version, description: "snapshot warmup", operations: [{ kind: "setContent", payload: { content: "" } }] });
      expect(warmup.status).toBe(200);
    }
    const originalDeltas = Array.from({ length: baseVersion }, (_, index) => ({ version: index + 1 }));
    const nextVersion = baseVersion + 1;
    const candidate = { commitMode: "receipt-v1", opId: "fault-op", baseVersion, description: "original append",
      operations: [{ kind: "appendSection", payload: { heading: "Once", content: "Original candidate" } }] };
    expect((await send(`${runtime.urls.markdown}/_test/arm?object=${object}`, { fault })).status).toBe(200);
    const failed = await send(`${path}/apply`, candidate);
    if (fault === "after-finalize") {
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
      expect(failed.body.receipt).toMatchObject({ state: "committed", version: nextVersion });
      expect((await inspect()).body).toMatchObject({ fired: true, pending: [], receipts: [{ op_id: "fault-op", state: "committed" }] });
      expect((await send(`${path}/query`, { kind: "getContent" })).body).toMatchObject({ version: nextVersion, data: "\n\n## Once\n\nOriginal candidate" });
      const control = { opId: "fault-op", baseVersion, requestDigest: failed.body.receipt.requestDigest };
      await runtime.dispose(); runtime = undefined;
      runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, bundleEntryOverrides, persistPath, stackFixture, capabilityFixture });
      expect((await send(`${path}/commit-recover`, control)).body.receipt).toEqual(failed.body.receipt);
      expect((await send(`${path}/query`, { kind: "getContent" })).body).toMatchObject({ version: nextVersion, data: "\n\n## Once\n\nOriginal candidate" });
      return;
    }
    expect(failed.status, JSON.stringify(failed.body)).toBe(503);
    expect(failed.body.receipt).toMatchObject({ state: "pending", opId: "fault-op", baseVersion });
    const before = (await inspect()).body;
    const hasPendingRoot = !["before-roots", "before-pending"].includes(fault);
    expect(before).toMatchObject({ fired: true, deltas: originalDeltas, snapshots: [{ version: 1 }], receipts: [{ op_id: "fault-op", state: "pending" }],
      pending: hasPendingRoot ? [{ version: nextVersion, commit_op_id: "fault-op" }] : [] });
    const control = { opId: "fault-op", baseVersion, requestDigest: failed.body.receipt.requestDigest };
    expect((await send(`${path}/commit-status`, control)).body.receipt.state).toBe("pending");
    expect((await send(`${path}/query`, { kind: "getContent" })).body).toMatchObject({ version: baseVersion, data: "" });
    expect((await send(`${path}/apply`, { ...candidate, commitMode: undefined, opId: "legacy-attempt" })).status).toBe(409);
    const rootRequest = `session:${sessionId}:commit:fault-op:roots`;
    const requestsBefore = await runtime.storage.middlewareRootRefRequestIds(stackFixture.stackId, tenant);
    if (["after-delta", "after-snapshot", "after-clear", "after-receipt"].includes(fault)) expect(requestsBefore).toContain(rootRequest);
    else expect(requestsBefore).not.toContain(rootRequest);
    await runtime.dispose(); runtime = undefined;
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, bindingDefaults, bundleEntryOverrides, persistPath, stackFixture, capabilityFixture });
    expect((await send(`${path}/commit-status`, control)).body.receipt).toEqual(failed.body.receipt);
    expect((await inspect()).body).toMatchObject({ deltas: before.deltas, snapshots: before.snapshots, pending: before.pending, receipts: before.receipts });
    const recovered = await send(`${path}/commit-recover`, control);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.receipt).toEqual({ ...failed.body.receipt, state: "committed", version: nextVersion });
    const query = await send(`${path}/query`, { kind: "getContent" });
    expect(query.body).toMatchObject({ version: nextVersion, data: "\n\n## Once\n\nOriginal candidate" });
    expect((await send(`${path}/commit-recover`, control)).body).toEqual(recovered.body);
    expect((await send(`${path}/apply`, candidate)).body.receipt).toEqual(recovered.body.receipt);
    expect((await inspect()).body).toMatchObject({ deltas: [...originalDeltas, { version: nextVersion }],
      snapshots: fault === "after-snapshot" ? [{ version: 1 }, { version: nextVersion }] : [{ version: 1 }],
      pending: [], receipts: [{ op_id: "fault-op", state: "committed" }] });
    expect((await send(`${path}/query`, { kind: "getContent" })).body).toEqual(query.body);
    expect((await runtime.storage.middlewareRootRefRequestIds(stackFixture.stackId, tenant)).filter(value => value === rootRequest)).toHaveLength(1);
    expect((await runtime.storage.middlewareRetainedRoots(stackFixture.stackId, tenant)).every(row => row.count === 1)).toBe(true);
  } finally {
    await runtime?.dispose();
    await rm(persistPath, { recursive: true, force: true });
  }
}, 120_000);