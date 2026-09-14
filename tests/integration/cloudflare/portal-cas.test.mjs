import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

let runtime;

beforeAll(async () => {
  runtime = await startLocalRuntime({ docTypes: [], services: ["portal"] });
}, 120_000);

afterAll(async () => {
  await runtime?.mf?.dispose();
});

describe("portal worker CAS bindings", () => {
  it("receives a CAS origin, stack identity, audience and ref domain", async () => {
    const bindings = await runtime.mf.getBindings("unidocs-portal");
    expect(bindings.CAS_ORIGIN).toMatch(/^https?:\/\//);
    expect(bindings.CAS_STACK_ID).toBeTruthy();
    expect(bindings.CAS_AUDIENCE).toBeTruthy();
    expect(bindings.CAS_REF_DOMAIN).toBe("doc");
  });

  it("receives the stack signing key, not the gateway one", async () => {
    const bindings = await runtime.mf.getBindings("unidocs-portal");
    expect(bindings.CAS_SIGNING_KEY).toContain("BEGIN PRIVATE KEY");
    expect(bindings.CAS_SIGNING_KID).toMatch(/^stack-local-/);
    expect(bindings.CAS_ISSUER).not.toMatch(/^unidocs-gateway:/);
  });
});

import { createCasBlobClient } from "@unicas/tenant-blob-client";
import { createTenantCasClient } from "@unicas/tenant-client";
import { casReadPermission, casWritePermission, createPkcs8CapabilityIssuer } from "@unidocs/service-auth";
import { createPortalCasRuntime } from "../../../packages/cloudflare-portal/src/cas-runtime.ts";

const TENANT = "t-local";
const SNAPSHOT_TYPE = "application/vnd.unidocs.markdown.snapshot+cbor;version=1";

/** Stands in for an Agent: it may write node content, but carries no refDomain. */
async function agentBlobClient(runtime) {
  const fixture = runtime.stackFixture;
  const issuer = await createPkcs8CapabilityIssuer({
    issuer: fixture.issuer,
    kid: fixture.kid,
    privateKeyPkcs8: fixture.privateKeyPkcs8,
  });
  const cas = createTenantCasClient({
    baseUrl: runtime.urls.edge,
    stackId: fixture.stackId,
    tenantId: TENANT,
    getToken: () => issuer.issue({
      subject: "agent:test",
      audience: fixture.audience,
      tenantId: TENANT,
      permissions: [casReadPermission(TENANT), casWritePermission(TENANT)],
    }),
  });
  return createCasBlobClient(cas);
}

function bodyStream(bytes) {
  return new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
}

describe("snapshot blob round trip", () => {
  it("reads back exactly what the Agent wrote, then retains its root", async () => {
    const payload = new TextEncoder().encode("# hello\n\nsnapshot bytes");

    const agent = await agentBlobClient(runtime);
    const written = await agent.storeBlob(bodyStream(payload), {
      contentType: SNAPSHOT_TYPE,
      size: payload.byteLength,
    });
    expect(written.hash).toBeTruthy();

    const bindings = await runtime.mf.getBindings("unidocs-portal");
    const store = await createPortalCasRuntime(bindings, TENANT);

    const ref = { blobHash: written.hash, size: written.size, contentType: written.contentType };
    const stream = await store.read(ref);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const readBack = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) { readBack.set(chunk, at); at += chunk.byteLength; }

    expect(readBack).toEqual(payload);

    await expect(store.retain(ref, `req-${crypto.randomUUID()}`)).resolves.toBeUndefined();
  }, 60_000);

  it("refuses a reference whose size disagrees with the stored blob", async () => {
    const payload = new TextEncoder().encode("mismatch");
    const agent = await agentBlobClient(runtime);
    const written = await agent.storeBlob(bodyStream(payload), {
      contentType: SNAPSHOT_TYPE,
      size: payload.byteLength,
    });

    const bindings = await runtime.mf.getBindings("unidocs-portal");
    const store = await createPortalCasRuntime(bindings, TENANT);

    await expect(
      store.read({ blobHash: written.hash, size: written.size + 1, contentType: written.contentType }),
    ).rejects.toThrow();
  }, 60_000);
});
