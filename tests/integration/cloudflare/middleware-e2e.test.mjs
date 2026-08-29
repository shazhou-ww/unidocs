/**
 * Middleware end-to-end through the public cas-edge front door.
 *
 * Seeds CAS_CONTROL_DB with two locally registered stacks
 * (`unidocs-cloudflare`, `unidocs-azure`), issues stack capabilities with
 * service-auth, and drives the full canonical tenant flow over HTTP:
 * lease -> read -> metadata -> updateRootRefs -> usage -> GC. Proves the
 * edge dispatches /stacks and /admin while never exposing the private
 * audit-reader RPC or internal routes, and that identical textual tenant
 * ids across the two stacks share no nodes, refs, usage, or GC.
 */

import { afterEach, expect, test } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import {
  CapabilityIssuer,
  JoseCapabilitySigner,
  casAdminPermission,
  casReadPermission,
  casWritePermission,
} from "../../../packages/service-auth/src/index.ts";
import {
  CanonicalNodeContentType,
  computeNodeDigest,
  concatenateNodeBytes,
  encodeHeader,
  hashToHex,
  hexToHash,
} from "../../../unicas-packages/codec/src/index.ts";

let runtime;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

const EDGE_PORTS = {
  cas: 35791,
  admin: 35792,
  mockOidc: 35793,
  edge: 35794,
};
const TENANT = "shared-tenant-id";

async function digestOf(content, contentType = "text/plain", refs = []) {
  const bytes = new TextEncoder().encode(content);
  const header = encodeHeader(bytes.length, contentType, refs.length);
  const children = refs.map(hexToHash);
  const digest = await computeNodeDigest(header, contentType, children, bytes);
  return {
    hash: hashToHex(digest),
    bytes,
    canonical: concatenateNodeBytes(header, new TextEncoder().encode(contentType), children, bytes),
  };
}

function edgeFetch(path, init = {}) {
  return fetch(`${runtime.urls.edge}${path}`, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

async function stackFixture(stackId, issuer, audience, kid) {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    stackId,
    issuer,
    audience,
    kid,
    privateKey,
    publicJwk: await exportJWK(publicKey),
    issuer_: new CapabilityIssuer({
      issuer,
      signer: new JoseCapabilitySigner(privateKey, kid),
    }),
  };
}

function issue(stack, input) {
  return stack.issuer_.issue({
    subject: "doc-service:markdown",
    audience: stack.audience,
    tenantId: input.tenantId,
    permissions: input.permissions,
    ...(input.refDomain === undefined ? {} : { refDomain: input.refDomain }),
  });
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

test("middleware serves the full canonical tenant flow through cas-edge", async () => {
  const stackA = await stackFixture(
    "unidocs-cloudflare",
    "https://issuer-cloudflare.local",
    "unidocs-cas-cloudflare",
    "key-cf",
  );
  const stackB = await stackFixture(
    "unidocs-azure",
    "https://issuer-azure.local",
    "unidocs-cas-azure",
    "key-az",
  );
  runtime = await startLocalRuntime({
    docTypes: [],
    casMiddlewareOnly: true,
    casMiddleware: true,
    middlewareStacks: [
      { ...stackA, refDomains: [{ refDomain: "doc", status: "active" }] },
      { ...stackB, refDomains: [{ refDomain: "doc", status: "active" }] },
    ],
    ports: EDGE_PORTS,
  });

  const stackId = stackA.stackId;
  const writer = await issue(stackA, {
    tenantId: TENANT,
    permissions: [casWritePermission(TENANT)],
    refDomain: "doc",
  });
  const reader = await issue(stackA, {
    tenantId: TENANT,
    permissions: [casReadPermission(TENANT)],
  });
  const usageReader = await issue(stackA, {
    tenantId: TENANT,
    permissions: [casAdminPermission(TENANT)],
  });
  const gcTrigger = await issue(stackA, {
    tenantId: TENANT,
    permissions: [casAdminPermission(TENANT)],
  });
  const prefix = `/stacks/${stackId}/tenants/${TENANT}`;

  // Lease a content-addressed node with a child.
  const child = await digestOf("child-content");
  const leaseChild = await edgeFetch(`${prefix}/cas/nodes/${child.hash}/lease`, {
    method: "POST",
    headers: {
      ...authHeaders(writer),
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(child.canonical.length),
      "X-CAS-Lease-Duration": "600000",
    },
    body: child.canonical,
  });
  expect(leaseChild.status, await leaseChild.clone().text()).toBe(200);

  const parent = await digestOf("parent-content", "text/plain", [child.hash]);
  const lease = await edgeFetch(`${prefix}/cas/nodes/${parent.hash}/lease`, {
    method: "POST",
    headers: {
      ...authHeaders(writer),
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(parent.canonical.length),
      "X-CAS-Lease-Duration": "600000",
    },
    body: parent.canonical,
  });
  expect(lease.status, await lease.clone().text()).toBe(200);
  await expect(lease.json()).resolves.toMatchObject({ hash: parent.hash, ready: true });

  // Read + metadata round-trip.
  const read = await edgeFetch(`${prefix}/cas/nodes/${parent.hash}/content`, {
    headers: authHeaders(reader),
  });
  expect(read.status).toBe(200);
  expect(new Uint8Array(await read.arrayBuffer())).toEqual(parent.bytes);

  const metadata = await edgeFetch(`${prefix}/cas/nodes/${parent.hash}/metadata`, {
    headers: authHeaders(reader),
  });
  expect(metadata.status).toBe(200);
  const { metadata: meta } = await metadata.json();
  expect(meta).toMatchObject({ hash: parent.hash, size: parent.bytes.length, refs: [child.hash] });

  // Root Refs write returns the typed revision.
  const roots = await edgeFetch(`${prefix}/root-refs`, {
    method: "POST",
    headers: { ...authHeaders(writer), "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "e2e:roots:1", changes: { [parent.hash]: 1 } }),
  });
  expect(roots.status, await roots.clone().text()).toBe(200);
  await expect(roots.json()).resolves.toMatchObject({ success: true, idempotent: false, revision: 1 });

  // Idempotent retry returns the same revision.
  const retry = await edgeFetch(`${prefix}/root-refs`, {
    method: "POST",
    headers: { ...authHeaders(writer), "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "e2e:roots:1", changes: { [parent.hash]: 1 } }),
  });
  await expect(retry.json()).resolves.toMatchObject({ success: true, idempotent: true, revision: 1 });

  // Usage is stack-scoped: two nodes, both ready, both leased.
  const usage = await edgeFetch(`${prefix}/cas/usage`, { headers: authHeaders(usageReader) });
  expect(usage.status, await usage.clone().text()).toBe(200);
  await expect(usage.json()).resolves.toMatchObject({
    nodeCount: 2,
    readyContentBytes: parent.bytes.length + child.bytes.length,
    notReadyNodeCount: 0,
    leasedNodeCount: 2,
  });

  // GC keeps leased nodes (all live leases) — nothing deleted.
  const gc = await edgeFetch(`${prefix}/cas/gc`, {
    method: "POST",
    headers: authHeaders(gcTrigger),
    body: "{}",
  });
  expect(gc.status, await gc.clone().text()).toBe(200);
  await expect(gc.json()).resolves.toMatchObject({ examined: 0, deleted: 0, reclaimedContentBytes: 0 });

  // The private audit-reader RPC and internal routes never cross the edge.
  for (const path of [
    "/_internal/audit/refs",
    "/_internal/health",
    "/tenants/x/cas/usage",
  ]) {
    const res = await edgeFetch(path);
    expect(res.status, path).toBe(404);
  }

  // Edge readiness and admin-path forwarding.
  const health = await edgeFetch("/health");
  expect(health.status).toBe(200);
  await expect(health.json()).resolves.toMatchObject({ ok: true, service: "cas-edge" });
  const adminProbe = await edgeFetch("/admin/me");
  expect(adminProbe.status).not.toBe(404); // forwarded to the admin BFF (401 without session)
  expect(adminProbe.status).not.toBe(501);
}, 90_000);

test("identical tenant ids across the two stacks share nothing", async () => {
  const stackA = await stackFixture(
    "unidocs-cloudflare",
    "https://issuer-cloudflare.local",
    "unidocs-cas-cloudflare",
    "key-cf",
  );
  const stackB = await stackFixture(
    "unidocs-azure",
    "https://issuer-azure.local",
    "unidocs-cas-azure",
    "key-az",
  );
  runtime = await startLocalRuntime({
    docTypes: [],
    casMiddlewareOnly: true,
    casMiddleware: true,
    middlewareStacks: [
      { ...stackA, refDomains: [{ refDomain: "doc", status: "active" }] },
      { ...stackB, refDomains: [{ refDomain: "doc", status: "active" }] },
    ],
    ports: EDGE_PORTS,
  });

  const writerA = await issue(stackA, {
    tenantId: TENANT,
    permissions: [casWritePermission(TENANT)],
    refDomain: "doc",
  });
  const readerB = await issue(stackB, {
    tenantId: TENANT,
    permissions: [casReadPermission(TENANT)],
  });
  const usageB = await issue(stackB, {
    tenantId: TENANT,
    permissions: [casAdminPermission(TENANT)],
  });

  // Each stack leases its own node under the SAME tenant id.
  const contentA = "content-in-cloudflare";
  const contentB = "content-in-azure";
  const nodeA = await digestOf(contentA);
  const nodeB = await digestOf(contentB);

  const leaseA = await edgeFetch(`/stacks/${stackA.stackId}/tenants/${TENANT}/cas/nodes/${nodeA.hash}/lease`, {
    method: "POST",
    headers: {
      ...authHeaders(writerA),
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(nodeA.canonical.length),
    },
    body: nodeA.canonical,
  });
  expect(leaseA.status, await leaseA.clone().text()).toBe(200);

  // A stack-B token cannot touch stack-A's path.
  const forbidden = await edgeFetch(
    `/stacks/${stackA.stackId}/tenants/${TENANT}/cas/nodes/${nodeA.hash}/content`,
    { headers: authHeaders(readerB) },
  );
  expect(forbidden.status).toBe(403);

  // Stack A's node is invisible to stack B even with an identical tenant id.
  const readB = await edgeFetch(`/stacks/${stackB.stackId}/tenants/${TENANT}/cas/nodes/${nodeA.hash}/content`, {
    headers: authHeaders(readerB),
  });
  expect(readB.status).toBe(404);

  // Each stack's usage counts only its own node.
  const usageBResponse = await edgeFetch(`/stacks/${stackB.stackId}/tenants/${TENANT}/cas/usage`, {
    headers: authHeaders(usageB),
  });
  expect(usageBResponse.status, await usageBResponse.clone().text()).toBe(200);
  await expect(usageBResponse.json()).resolves.toMatchObject({ nodeCount: 0, readyContentBytes: 0 });

  // Leasing stack B's own content succeeds independently.
  const writerB = await issue(stackB, {
    tenantId: TENANT,
    permissions: [casWritePermission(TENANT)],
    refDomain: "doc",
  });
  const leaseB = await edgeFetch(`/stacks/${stackB.stackId}/tenants/${TENANT}/cas/nodes/${nodeB.hash}/lease`, {
    method: "POST",
    headers: {
      ...authHeaders(writerB),
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(nodeB.canonical.length),
    },
    body: nodeB.canonical,
  });
  expect(leaseB.status, await leaseB.clone().text()).toBe(200);

  const usageB2 = await edgeFetch(`/stacks/${stackB.stackId}/tenants/${TENANT}/cas/usage`, {
    headers: authHeaders(usageB),
  });
  await expect(usageB2.json()).resolves.toMatchObject({ nodeCount: 1 });
}, 90_000);
