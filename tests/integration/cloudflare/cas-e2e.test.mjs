import { afterAll, beforeAll, expect, test } from "vitest";
import { startLocalRuntime } from "../../../scripts/local-runtime.mjs";
import {
  encodeHeader,
  computeNodeDigest,
  hashToHex,
  hexToHash,
} from "../../../packages/cas/src/index.ts";

let runtime;
const GW = () => runtime.urls.gateway;

function casUrl(userId, suffix) {
  return `${GW()}/users/${userId}/cas${suffix}`;
}

function casFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

/** Compute the CAS hash for a node (header + contentType + refs + content). */
async function computeCasHash(contentType, content, refs = []) {
  const contentBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const childHashes = refs.map(hexToHash);
  const header = encodeHeader(contentBytes.length, contentType, childHashes.length);
  const digest = await computeNodeDigest(header, contentType, childHashes, contentBytes);
  return { hash: hashToHex(digest), content: contentBytes, header };
}

/** Lease a node, uploading content in the same request. */
async function casUpload(userId, contentType, content, refs = []) {
  const { hash, content: contentBytes } = await computeCasHash(contentType, content, refs);

  const headers = {
    "Content-Type": contentType,
    "Content-Length": String(contentBytes.length),
    "X-CAS-Lease-Duration": "900000",
  };
  if (refs.length > 0) headers["X-CAS-Refs"] = refs.join(",");

  const leaseRes = await casFetch(casUrl(userId, `/nodes/${hash}`), {
    method: "POST",
    headers,
    body: contentBytes,
  });
  if (!leaseRes.ok) {
    const errorBody = await leaseRes.text();
    throw new Error(`Lease failed (${leaseRes.status}): ${errorBody}`);
  }
  const lease = await leaseRes.json();
  expect(lease.ready).toBe(true);
  return { hash, lease };
}

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: { gateway: 28787, markdown: 28788 },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

test("CAS: create node, upload content, read back", async () => {
  const { hash } = await casUpload("alice", "text/plain", "Hello CAS!");

  const readRes = await casFetch(casUrl("alice", `/nodes/${hash}/content`));
  expect(readRes.ok).toBe(true);
  expect(await readRes.text()).toBe("Hello CAS!");
});

test("CAS: read metadata", async () => {
  const { hash } = await casUpload("alice", "text/plain", "metadata test");

  const metaRes = await casFetch(casUrl("alice", `/nodes/${hash}/metadata`));
  expect(metaRes.ok).toBe(true);
  const { metadata, state } = await metaRes.json();
  expect(metadata.hash).toBe(hash);
  expect(metadata.contentType).toBe("text/plain");
  expect(metadata.size).toBe("metadata test".length);
  expect(metadata.refs).toEqual([]);
  expect(state.childRefCount).toBe(0);
  expect(state.rootRefCount).toBe(0);
});

test("CAS: second lease of the same node is idempotent", async () => {
  const { hash } = await casUpload("alice", "text/plain", "idempotent body");
  const again = await casUpload("alice", "text/plain", "idempotent body");
  expect(again.hash).toBe(hash);
  expect(again.lease.ready).toBe(true);
});

test("CAS: extend ready node via /lease", async () => {
  const { hash } = await casUpload("alice", "text/plain", "extend me");
  const extendRes = await casFetch(casUrl("alice", `/nodes/${hash}/lease`), {
    method: "POST",
    headers: { "X-CAS-Lease-Duration": "120000" },
  });
  expect(extendRes.ok).toBe(true);
  const lease = await extendRes.json();
  expect(lease.ready).toBe(true);
  expect(lease.hash).toBe(hash);
});

test("CAS: /lease on unknown hash is 404", async () => {
  const res = await casFetch(casUrl("alice", `/nodes/${"a".repeat(64)}/lease`), {
    method: "POST",
  });
  expect(res.status).toBe(404);
});

test("CAS: GC endpoint works", async () => {
  const gcRes = await casFetch(casUrl("alice", "/gc"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxNodes: 10 }),
  });
  expect(gcRes.ok).toBe(true);
  const gcResult = await gcRes.json();
  expect(gcResult).toHaveProperty("examined");
  expect(gcResult).toHaveProperty("deleted");
  expect(gcResult).toHaveProperty("reclaimedContentBytes");
});

test("CAS: user isolation — alice's nodes not accessible by bob", async () => {
  const { hash } = await casUpload("alice", "text/plain", "alice secret");

  const readRes = await casFetch(casUrl("bob", `/nodes/${hash}/content`));
  expect(readRes.status).toBe(404);

  const metaRes = await casFetch(casUrl("bob", `/nodes/${hash}/metadata`));
  expect(metaRes.status).toBe(404);
});

test("CAS: user isolation — bob can create own nodes", async () => {
  const { hash } = await casUpload("bob", "text/plain", "bob content");

  const readRes = await casFetch(casUrl("bob", `/nodes/${hash}/content`));
  expect(readRes.ok).toBe(true);
  expect(await readRes.text()).toBe("bob content");
});

test("CAS: usage endpoint returns stats", async () => {
  await casUpload("alice", "text/plain", "usage test");

  const usageRes = await casFetch(casUrl("alice", "/usage"));
  expect(usageRes.ok).toBe(true);
  const usage = await usageRes.json();
  expect(usage).toHaveProperty("nodeCount");
  expect(usage).toHaveProperty("readyContentBytes");
  expect(usage.nodeCount).toBeGreaterThan(0);
});

test("CAS: digest mismatch is 400", async () => {
  const res = await casFetch(casUrl("alice", `/nodes/${"a".repeat(64)}`), {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": "4",
    },
    body: "nope",
  });
  expect(res.status).toBe(400);
});

test("CAS: metadata mismatch on a ready node is 409", async () => {
  const { hash } = await casUpload("alice", "text/plain", "same bytes");
  const res = await casFetch(casUrl("alice", `/nodes/${hash}`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String("same bytes".length),
    },
    body: "same bytes",
  });
  expect(res.status).toBe(409);
});

test("CAS: parent node with ready child ref", async () => {
  const child = await casUpload("alice", "text/plain", "child content");
  const parent = await casUpload("alice", "application/json", '{"ref":"child"}', [child.hash]);

  const parentMeta = await (await casFetch(casUrl("alice", `/nodes/${parent.hash}/metadata`))).json();
  expect(parentMeta.metadata.refs).toEqual([child.hash]);

  const childMeta = await (await casFetch(casUrl("alice", `/nodes/${child.hash}/metadata`))).json();
  expect(childMeta.state.childRefCount).toBe(1);
});

test("CAS: parent with unknown child is 409", async () => {
  const { hash } = await computeCasHash("text/plain", "orphan parent", ["b".repeat(64)]);
  const res = await casFetch(casUrl("alice", `/nodes/${hash}`), {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": String("orphan parent".length),
      "X-CAS-Refs": "b".repeat(64),
    },
    body: "orphan parent",
  });
  expect(res.status).toBe(409);
});

test("CAS: PUT /content is not a public Gateway route", async () => {
  const { hash } = await computeCasHash("text/plain", "no put");
  const res = await casFetch(casUrl("alice", `/nodes/${hash}/content`), {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "no put",
  });
  expect(res.status).toBe(404);
});
