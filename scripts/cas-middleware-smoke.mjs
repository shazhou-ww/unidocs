/**
 * Smoke-test the deployed CAS middleware through a base URL.
 *
 * Usage: node scripts/cas-middleware-smoke.mjs [baseUrl]
 *   baseUrl defaults to https://unicas.shazhou.work (the live edge);
 *   pass http://127.0.0.1:<port> to test `wrangler dev --remote` tunnels.
 *   Set UNICAS_SMOKE_STACK_ID/ISSUER/AUDIENCE/KID/KEY_FILE to target one
 *   control-plane-managed smoke stack; cross-stack assertions are then skipped.
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

const defaultStacks = [
  {
    stackId: "unidocs-cloudflare",
    issuer: "https://unicas.shazhou.work/cas/issuer/cloudflare",
    audience: "unidocs-cas-cloudflare",
    keyFile: "unidocs-cloudflare.pkcs8.pem",
    kid: "cf-rotate-1",
  },
  {
    stackId: "unidocs-azure",
    issuer: "https://unicas.shazhou.work/cas/issuer/azure",
    audience: "unidocs-cas-azure",
    keyFile: "unidocs-azure.pkcs8.pem",
    kid: "az-rotate-1",
  },
];

const configuredStackId = process.env.UNICAS_SMOKE_STACK_ID;
const stacks = configuredStackId ? [{
  stackId: configuredStackId,
  issuer: requiredEnv("UNICAS_SMOKE_ISSUER"),
  audience: requiredEnv("UNICAS_SMOKE_AUDIENCE"),
  kid: requiredEnv("UNICAS_SMOKE_KID"),
  keyFile: requiredEnv("UNICAS_SMOKE_KEY_FILE"),
}] : defaultStacks;

/** Canonical node wire content type (see @unicas/codec). */
const NODE_CONTENT_TYPE = "application/vnd.unidocs.cas-node.v1";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`  ok: ${message}`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when UNICAS_SMOKE_STACK_ID is set`);
  return value;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pausedBody(bytes) {
  const release = deferred();
  const midpoint = Math.max(1, Math.floor(bytes.length / 2));
  let sentPrefix = false;
  return {
    body: new ReadableStream({
      async pull(controller) {
        if (!sentPrefix) {
          sentPrefix = true;
          controller.enqueue(bytes.subarray(0, midpoint));
          await release.promise;
          controller.enqueue(bytes.subarray(midpoint));
          controller.close();
        }
      },
    }),
    release: release.resolve,
  };
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function withTimeout(promise, message, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${message}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
      issuer: stack.issuer,
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
  const primary = stacks[0];
  const isolation = stacks[1];
  const writer = await issue(primary, [casWritePermission(TENANT)], "doc");
  const reader = await issue(primary, [casReadPermission(TENANT)]);
  const usageReader = await issue(primary, [casManagePermission(TENANT)]);
  const gcTrigger = await issue(primary, [casManagePermission(TENANT)]);
  const isolationReader = isolation === undefined
    ? undefined
    : await issue(isolation, [casReadPermission(TENANT)]);
  const prefix = `/stacks/${primary.stackId}/tenants/${TENANT}`;

  // Edge readiness + isolation (only meaningful against the live edge).
  const isLiveEdge = BASE.startsWith("https://");
  if (isLiveEdge) {
    const health = await fetch(`${BASE}/health`);
    assert(health.status === 200, `edge /health -> ${health.status}`);
    const internal = await fetch(`${BASE}/_internal/health`);
    assert(internal.status === 404, "edge never forwards /_internal/health");
  }

  let concurrencyNodeCount = 0;
  if (process.env.UNICAS_SMOKE_SKIP_CONCURRENCY !== "1") {
    // Hold one request body mid-stream. Its reservation proves lease begin has
    // completed; usage and a different-hash lease must still finish before the
    // first body is released. Some ingress paths buffer a full client body;
    // callers may skip this probe while still running the canonical flow.
    const slow = await nodeOf("slow-upload-concurrency-probe");
    const paused = pausedBody(slow.body);
    const slowLease = fetch(`${BASE}${prefix}/cas/nodes/${slow.hash}/lease`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${writer}`,
        "Content-Type": NODE_CONTENT_TYPE,
        "Content-Length": String(slow.body.length),
      },
      body: paused.body,
      duplex: "half",
    });
    await waitFor(async () => {
      const response = await fetch(`${BASE}${prefix}/cas/usage`, {
        headers: { Authorization: `Bearer ${usageReader}` },
      });
      if (!response.ok) return false;
      const usage = await response.json();
      return usage.reservedBytes >= slow.body.length;
    }, "slow upload reservation");
    assert(true, "usage bypasses an in-flight upload");

    const concurrent = await nodeOf("concurrent-upload-probe");
    let concurrentResult;
    let concurrentError;
    try {
      concurrentResult = await withTimeout(fetch(
        `${BASE}${prefix}/cas/nodes/${concurrent.hash}/lease`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${writer}`, "Content-Type": NODE_CONTENT_TYPE },
          body: concurrent.body,
        },
      ), "concurrent lease while another body is paused");
    } catch (error) {
      concurrentError = error;
    } finally {
      paused.release();
    }
    const slowResult = await slowLease;
    if (concurrentError) throw concurrentError;
    assert(concurrentResult.status === 200, `concurrent lease -> ${concurrentResult.status}`);
    assert(slowResult.status === 200, `paused lease -> ${slowResult.status}`);
    concurrencyNodeCount = 2;
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
    headers: { Authorization: `Bearer ${writer}`, "Content-Type": NODE_CONTENT_TYPE },
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
  assert(
    res.status === 200 && usageBody.nodeCount === 2 + concurrencyNodeCount,
    `usage nodeCount -> ${usageBody.nodeCount}`,
  );

  res = await fetch(`${BASE}${prefix}/cas/gc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gcTrigger}` },
    body: "{}",
  });
  const gcBody = await res.json();
  assert(res.status === 200 && gcBody.deleted === 0, "gc keeps leased nodes");

  if (isolation !== undefined && isolationReader !== undefined) {
    // Cross-stack isolation: another stack's token cannot read the primary node.
    res = await fetch(`${BASE}${prefix}/cas/nodes/${parent.hash}/content`, {
      headers: { Authorization: `Bearer ${isolationReader}` },
    });
    assert(res.status === 403, `cross-stack read -> ${res.status} (403)`);

    // The isolation stack sees nothing under the same tenant id.
    res = await fetch(`${BASE}/stacks/${isolation.stackId}/tenants/${TENANT}/cas/usage`, {
      headers: { Authorization: `Bearer ${await issue(isolation, [casManagePermission(TENANT)])}` },
    });
    const isolationUsage = await res.json();
    assert(isolationUsage.nodeCount === 0, `isolation usage nodeCount -> ${isolationUsage.nodeCount}`);
  }

  console.log("\nSMOKE PASS");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
