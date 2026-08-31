/**
 * Smoke-test the deployed CAS middleware through a base URL.
 *
 * Usage: node scripts/cas-middleware-smoke.mjs [baseUrl]
 *   baseUrl defaults to https://unicas.shazhou.work (the live edge);
 *   pass http://127.0.0.1:<port> to test `wrangler dev --remote` tunnels.
 *
 * Loads the provisioned stack issuer keys from .wrangler/cas-deploy,
 * issues stack capabilities, and runs the canonical tenant flow (lease ->
 * read -> metadata -> updateRootRefs -> usage -> gc) plus cross-stack
 * isolation and edge-isolation assertions against the deployed workers.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { concatenateNodeBytes, computeNodeDigest, encodeHeader, hashToHex, hexToHash } from "../unicas-packages/codec/dist/index.js";
import { casManagePermission, casReadPermission, casWritePermission, createPkcs8CapabilityIssuer } from "../packages/service-auth/dist/index.js";

const BASE = process.argv[2] ?? "https://unicas.shazhou.work";
// Unique per run so the smoke is repeatable: a fixed tenant/requestId would
// make the second run hit the root-refs idempotency record and fail the
// `revision === 1` assertion.
const RUN = `${process.pid}-${Date.now()}`;
const TENANT = `deploy-smoke-${RUN}`;
const KEY_DIR = join(import.meta.dirname, "..", ".wrangler", "cas-deploy");

const stacks = [
  {
    stackId: "unidocs-cloudflare",
    audience: "unidocs-cas-cloudflare",
    keyFile: "unidocs-cloudflare.pkcs8.pem",
    kid: "cf-rotate-1",
  },
  {
    stackId: "unidocs-azure",
    audience: "unidocs-cas-azure",
    keyFile: "unidocs-azure.pkcs8.pem",
    kid: "az-rotate-1",
  },
];

/** Canonical node wire content type (see @unicas/codec). */
const NODE_CONTENT_TYPE = "application/vnd.unidocs.cas-node.v1";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`  ok: ${message}`);
}

/** Build the canonical node bytes and their CAS hash for upload. */
async function nodeOf(content, refs = []) {
  const contentBytes = new TextEncoder().encode(content);
  const contentTypeBytes = new TextEncoder().encode(NODE_CONTENT_TYPE);
  const refHashes = refs.map(hexToHash);
  const header = encodeHeader(contentBytes.length, NODE_CONTENT_TYPE, refHashes.length);
  const hash = hashToHex(await computeNodeDigest(header, NODE_CONTENT_TYPE, refHashes, contentBytes));
  const body = concatenateNodeBytes(header, contentTypeBytes, refHashes, contentBytes);
  return { hash, body, contentBytes };
}

async function main() {
  const issuers = {};
  for (const stack of stacks) {
    const privateKeyPkcs8 = await readFile(join(KEY_DIR, stack.keyFile), "utf8");
    issuers[stack.stackId] = await createPkcs8CapabilityIssuer({
      issuer: `https://unicas.shazhou.work/cas/issuer/${stack.stackId === "unidocs-cloudflare" ? "cloudflare" : "azure"}`,
      kid: stack.kid,
      privateKeyPkcs8,
    });
  }
  const issue = (stack, permissions, refDomain) => issuers[stack.stackId].issue({
    subject: "deploy-smoke",
    audience: stack.audience,
    tenantId: TENANT,
    permissions,
    ...(refDomain === undefined ? {} : { refDomain }),
  });

  console.log(`smoke base: ${BASE}`);
  const cf = stacks[0];
  const az = stacks[1];
  const writer = await issue(cf, [casWritePermission(TENANT)], "doc");
  const reader = await issue(cf, [casReadPermission(TENANT)]);
  const usageReader = await issue(cf, [casManagePermission(TENANT)]);
  const gcTrigger = await issue(cf, [casManagePermission(TENANT)]);
  const azReader = await issue(az, [casReadPermission(TENANT)]);
  const prefix = `/stacks/${cf.stackId}/tenants/${TENANT}`;

  // Edge readiness + isolation (only meaningful against the live edge).
  const isLiveEdge = BASE.startsWith("https://");
  if (isLiveEdge) {
    const health = await fetch(`${BASE}/health`);
    assert(health.status === 200, `edge /health -> ${health.status}`);
    const internal = await fetch(`${BASE}/_internal/health`);
    assert(internal.status === 404, "edge never forwards /_internal/health");
  }

  // Lease a parent with a child.
  const child = await nodeOf("smoke-child");
  let res = await fetch(`${BASE}${prefix}/cas/nodes/${child.hash}/lease`, {
    method: "POST",
    headers: { Authorization: `Bearer ${writer}`, "Content-Type": NODE_CONTENT_TYPE },
    body: child.body,
  });
  assert(res.status === 200, `lease child -> ${res.status}`);

  const parent = await nodeOf("smoke-parent", [child.hash]);
  res = await fetch(`${BASE}${prefix}/cas/nodes/${parent.hash}/lease`, {
    method: "POST",
    headers: { Authorization: `Bearer ${writer}`, "Content-Type": NODE_CONTENT_TYPE, "X-CAS-Refs": child.hash },
    body: parent.body,
  });
  assert(res.status === 200, `lease parent -> ${res.status}`);

  res = await fetch(`${BASE}${prefix}/cas/nodes/${parent.hash}/content`, {
    headers: { Authorization: `Bearer ${reader}` },
  });
  assert(res.status === 200, `read -> ${res.status}`);
  const content = new Uint8Array(await res.arrayBuffer());
  assert(content.join(",") === parent.contentBytes.join(","), "read content matches");

  res = await fetch(`${BASE}${prefix}/cas/nodes/${parent.hash}/metadata`, {
    headers: { Authorization: `Bearer ${reader}` },
  });
  assert(res.status === 200, `metadata -> ${res.status}`);

  res = await fetch(`${BASE}${prefix}/root-refs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${writer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: `${RUN}:roots:1`, changes: { [parent.hash]: 1 } }),
  });
  const rootsBody = await res.json();
  // refDomain revision is domain-wide (shared across tenants), so it does not
  // restart at 1 for a fresh smoke tenant — assert it advanced instead.
  assert(res.status === 200 && rootsBody.success === true
    && typeof rootsBody.revision === "number" && rootsBody.revision > 0,
  `root-refs -> revision ${rootsBody.revision}`);

  res = await fetch(`${BASE}${prefix}/root-refs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${writer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: `${RUN}:roots:1`, changes: { [parent.hash]: 1 } }),
  });
  const retryBody = await res.json();
  assert(retryBody.idempotent === true && retryBody.revision === rootsBody.revision,
    "idempotent retry keeps revision");

  res = await fetch(`${BASE}${prefix}/cas/usage`, { headers: { Authorization: `Bearer ${usageReader}` } });
  const usageBody = await res.json();
  assert(res.status === 200 && usageBody.nodeCount === 2, `usage nodeCount -> ${usageBody.nodeCount}`);

  res = await fetch(`${BASE}${prefix}/cas/gc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gcTrigger}` },
    body: "{}",
  });
  const gcBody = await res.json();
  assert(res.status === 200 && gcBody.deleted === 0, "gc keeps leased nodes");

  // Cross-stack isolation: azure token cannot read cloudflare's node.
  res = await fetch(`${BASE}${prefix}/cas/nodes/${parent.hash}/content`, {
    headers: { Authorization: `Bearer ${azReader}` },
  });
  assert(res.status === 403, `cross-stack read -> ${res.status} (403)`);

  // Azure's own stack sees nothing under the same tenant id.
  res = await fetch(`${BASE}/stacks/${az.stackId}/tenants/${TENANT}/cas/usage`, {
    headers: { Authorization: `Bearer ${await issue(az, [casManagePermission(TENANT)])}` },
  });
  const azUsage = await res.json();
  assert(azUsage.nodeCount === 0, `azure usage nodeCount -> ${azUsage.nodeCount}`);

  console.log("\nSMOKE PASS");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
