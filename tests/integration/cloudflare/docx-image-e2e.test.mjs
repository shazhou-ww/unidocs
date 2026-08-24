import { afterAll, beforeAll, expect, test } from "vitest";
import { startLocalRuntime } from "../../../scripts/local-runtime.mjs";
import {
  encodeHeader,
  computeNodeDigest,
  hashToHex,
} from "../../../packages/cas-server-common/src/index.ts";
import {
  CasClient,
  createSBlobContext,
  decodeSValue,
  encodeSValue,
  isSBlob,
  SValueContentType,
} from "../../../packages/cloudflare-sdk/src/index.ts";

const PNG_1x1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

let runtime;
const GW = () => runtime.urls.gateway;

function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["docx", "markdown"],
    ports: { gateway: 29787, docx: 29789, markdown: 29788 },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

test("markdown apply without Blob refs still succeeds", async () => {
  const create = await closeFetch(`${GW()}/users/alice/docs/markdown/`, { method: "POST" });
  const { docId } = await create.json();
  const apply = await closeFetch(`${GW()}/users/alice/docs/markdown/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 1,
      description: "set",
      operations: [{ kind: "setContent", payload: { content: "# Hi" } }],
    }),
  });
  expect(apply.ok).toBe(true);
  await expect(apply.json()).resolves.toMatchObject({ success: true, version: 2 });
});

test("Gateway does not proxy /cas/root-refs", async () => {
  const res = await closeFetch(`${GW()}/users/alice/cas/root-refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "x", changes: {} }),
  });
  expect(res.status).toBe(404);

  const assignments = await closeFetch(`${GW()}/users/alice/cas/root-assignments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "x", assignments: [] }),
  });
  expect(assignments.status).toBe(404);
});

test("DOCX insertImage reads CAS via the editor service binding", async () => {
  const header = encodeHeader(PNG_1x1.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], PNG_1x1);
  const hash = hashToHex(digest);

  const lease = await closeFetch(`${GW()}/users/alice/cas/nodes/${hash}`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(PNG_1x1.length),
      "X-CAS-Lease-Duration": "900000",
    },
    body: PNG_1x1,
  });
  expect(lease.ok).toBe(true);

  const context = createSBlobContext(new CasClient({
    baseUrl: GW(),
    userId: "alice",
  }));
  const blob = await context.makeSBlob(hash, async () => {
    throw new Error("existing image should not invoke the lazy loader");
  });

  const create = await closeFetch(`${GW()}/users/alice/docs/docx/`, { method: "POST" });
  const { docId } = await create.json();

  const applyBody = encodeSValue({
    baseVersion: 1,
    description: "Insert image",
    operations: [{ kind: "insertImage", payload: { blob, widthPx: 16, altText: "dot" } }],
  });
  const apply = await closeFetch(`${GW()}/users/alice/docs/docx/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": SValueContentType },
    body: applyBody.buffer,
  });
  const applied = await apply.json();
  expect(apply.ok, JSON.stringify(applied)).toBe(true);
  expect(applied).toMatchObject({ success: true, version: 2 });

  const query = await closeFetch(`${GW()}/users/alice/docs/docx/${docId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getImages" }),
  });
  const result = await query.json();
  expect(result.success).toBe(true);
  expect(result.data).toEqual([
    expect.objectContaining({
      index: 0,
      format: "png",
      altText: "dot",
      placement: "inline",
    }),
  ]);

  const history = await closeFetch(`${GW()}/users/alice/docs/docx/${docId}/history`, {
    headers: { Accept: SValueContentType },
  });
  expect(history.ok).toBe(true);
  const historyValue = decodeSValue(new Uint8Array(await history.arrayBuffer()));
  const operationBlob = historyValue.data[1].operations[0].payload.blob;
  expect(isSBlob(operationBlob)).toBe(true);
  expect(operationBlob.hash).toBe(hash);

  const toolApply = await closeFetch(`${GW()}/users/alice/docs/docx/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 2,
      description: "Tool-style image hash",
      operations: [{
        kind: "insertImage",
        payload: { hash, widthPx: 8, altText: "tool" },
      }],
    }),
  });
  const toolApplied = await toolApply.json();
  expect(toolApply.status).toBe(400);
  expect(toolApplied).toMatchObject({ success: false, version: 2 });

  const afterToolQuery = await closeFetch(`${GW()}/users/alice/docs/docx/${docId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getImages" }),
  });
  const afterTool = await afterToolQuery.json();
  expect(afterTool.data).toHaveLength(1);

  const afterDelta = await closeFetch(`${GW()}/users/alice/cas/nodes/${hash}/metadata`);
  const afterDeltaMetadata = await afterDelta.json();
  expect(afterDeltaMetadata.state.childRefCount).toBeGreaterThanOrEqual(1);

  const snapshot = await closeFetch(`${GW()}/users/alice/docs/docx/${docId}/snapshot`);
  const snapshotBody = await snapshot.json();
  expect(snapshot.ok, JSON.stringify(snapshotBody)).toBe(true);
  expect(snapshotBody).toMatchObject({ success: true, version: 2 });
  expect(snapshotBody.hash).toMatch(/^[0-9a-f]{64}$/);

  const afterSnapshot = await closeFetch(`${GW()}/users/alice/cas/nodes/${hash}/metadata`);
  const afterSnapshotMetadata = await afterSnapshot.json();
  expect(afterSnapshotMetadata.state.childRefCount)
    .toBeGreaterThan(afterDeltaMetadata.state.childRefCount);
});
