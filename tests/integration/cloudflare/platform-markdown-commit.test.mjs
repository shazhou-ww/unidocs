import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { resolveWorkspaceAliases } from "../../../scripts/workspace-aliases.mjs";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { COMPATIBILITY_DATE, SERVICE_WORKER } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";
import { createTenantCasClient } from "../../../unicas-packages/tenant-client/src/index.ts";
import { storeNodeContent } from "../../../unicas-packages/tenant-blob-client/src/index.ts";
import { SValueContentType } from "../../../packages/protocol/src/index.ts";
import { createSBlob, decodeSValue, encodeSValue } from "../../../packages/svalue-codec/src/index.ts";
import {
  CapabilityTokenType, casReadPermission, casWritePermission, importPlatformHmacKey, signPlatformRequest,
} from "../../../packages/service-auth/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("authenticated Markdown snapshot becomes a durable platform version and reopens after compute restart", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const fixture = { stackId: "platform-markdown-test", issuer: "https://issuer.example",
    audience: "https://cas.example/stacks/platform-markdown-test", kid: "cas-test",
    privateKeyPkcs8: await exportPKCS8(pair.privateKey),
    jwks: { keys: [{ ...await exportJWK(pair.publicKey), kid: "cas-test", alg: "ES256", use: "sig" }] },
    refDomains: [{ refDomain: "platform:documents", status: "active" }],
  };
  const tenantId = "alice";
  const now = Math.floor(Date.now() / 1000);
  const capability = ({ subject, permissions, refDomain }) => new SignJWT({ ver: 1, tenantId, permissions,
    ...(refDomain ? { refDomain } : {}) })
    .setProtectedHeader({ alg: "ES256", kid: fixture.kid, typ: CapabilityTokenType })
    .setIssuer(fixture.issuer).setAudience(fixture.audience).setSubject(subject)
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300).setJti(crypto.randomUUID()).sign(pair.privateKey);
  const computeRoToken = await capability({ subject: "doc:markdown", permissions: [casReadPermission(tenantId)] });
  const computeRwToken = await capability({ subject: "doc:markdown",
    permissions: [casReadPermission(tenantId), casWritePermission(tenantId)] });
  const platformToken = await capability({ subject: "platform", permissions: [casWritePermission(tenantId)],
    refDomain: "platform:documents" });
  const rawHmac = crypto.getRandomValues(new Uint8Array(32));
  const hmacHex = Array.from(rawHmac, byte => byte.toString(16).padStart(2, "0")).join("");
  const hmac = { keyId: "compute-key", platformId: "test-platform", environment: "test",
    serviceId: "markdown-compute", role: "editor", key: await importPlatformHmacKey(rawHmac) };
  const computeOrigin = "https://compute.example";
  const target = { origin: computeOrigin,
    paths: ["/v1/editor/init", "/v1/editor/apply", "/v1/editor/snapshot"] };
  const invocation = { requestId: "edit-1", actorId: "actor-1", tenantId, docId: "doc-1", docType: "markdown" };
  const sign = (path, body, mode = "ro") => signPlatformRequest({ url: computeOrigin + path, target, key: hmac,
    body: encodeSValue(body), casAuthorization: `Bearer ${mode === "rw" ? computeRwToken : computeRoToken}` });
  const aliases = resolveWorkspaceAliases(root);
  const [computeBuilt, platformBuilt] = await Promise.all([
    build({ absWorkingDir: root, entryPoints: ["packages/cloudflare-markdown/src/compute-worker.ts"], bundle: true,
      write: false, format: "esm", platform: "browser", target: "es2024", conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:workers", "node:*"], alias: aliases }),
    build({ absWorkingDir: root, entryPoints: ["tests/integration/cloudflare/platform-document-probe.ts"], bundle: true,
      write: false, format: "esm", platform: "browser", target: "es2024", conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:workers", "node:*"], alias: aliases }),
  ]);
  const persistence = await mkdtemp(join(tmpdir(), "platform-markdown-commit-"));
  let cas;
  let compute;
  let platform;
  try {
    cas = await startLocalRuntime({ docTypes: [], casMiddlewareOnly: true, stackFixture: fixture,
      ports: { cas: 29911, admin: 29912, mockOidc: 29913, edge: 29914 } });
    const casWorker = await cas.mf.getWorker(SERVICE_WORKER);
    const casFetcher = { fetch: (input, init) => casWorker.fetch(input, init) };
    const writer = createTenantCasClient({ baseUrl: "https://cas.example", stackId: fixture.stackId, tenantId,
      getToken: async () => platformToken, fetcher: casFetcher });
    const reader = createTenantCasClient({ baseUrl: "https://cas.example", stackId: fixture.stackId, tenantId,
      getToken: async () => computeRoToken, fetcher: casFetcher });
    const initialState = { content: "" };
    const initialHash = await storeNodeContent(writer, encodeSValue(initialState), SValueContentType);
    const computeOptions = convertV4MiniflareOptions({ host: "127.0.0.1", port: 0, log: new Log(LogLevel.WARN),
      resourcePersistencePath: join(persistence, "compute"), workers: [{ name: "compute", modules: true,
        script: computeBuilt.outputFiles[0].text, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
        durableObjects: { PLATFORM_NONCES: { className: "PlatformNonces", useSQLite: true } },
        bindings: { COMPUTE_ORIGIN: computeOrigin, PLATFORM_ID: hmac.platformId, COMPUTE_ENVIRONMENT: hmac.environment,
          COMPUTE_SERVICE_ID: hmac.serviceId, CAS_ORIGIN: "https://cas.example", CAS_STACK_ID: fixture.stackId,
          CAS_ISSUER: fixture.issuer, CAS_AUDIENCE: fixture.audience, CAS_JWKS_URL: "https://issuer.example/jwks",
          PLATFORM_HMAC_KEYS: JSON.stringify({ [hmac.keyId]: hmacHex }) },
        serviceBindings: { CAS_SERVICE: request => casWorker.fetch(request) },
        outboundService: request => request.url === "https://issuer.example/jwks"
          ? Response.json(fixture.jwks) : new Response(null, { status: 403 }),
      }] });
    const startCompute = async () => { compute = new Miniflare(computeOptions); await compute.ready; };
    await startCompute();
    const computeCall = async request => {
      const response = await compute.dispatchFetch(request.url,
        { method: request.method, headers: request.headers, body: await request.arrayBuffer() });
      return { status: response.status, body: decodeSValue(new Uint8Array(await response.arrayBuffer())) };
    };
    const platformOptions = convertV4MiniflareOptions({ host: "127.0.0.1", port: 0, log: new Log(LogLevel.WARN),
      resourcePersistencePath: join(persistence, "platform"), workers: [{ name: "platform", modules: true,
        script: platformBuilt.outputFiles[0].text, compatibilityDate: COMPATIBILITY_DATE,
        durableObjects: { DOCUMENTS: { className: "PlatformDocument", useSQLite: true } },
        bindings: { CAS_STACK_ID: fixture.stackId, PLATFORM_CAS_AUTHORIZATION: `Bearer ${platformToken}`,
          COMPUTE_ORIGIN: computeOrigin, COMPUTE_HMAC_KEY_HEX: hmacHex,
          COMPUTE_CAS_AUTHORIZATION: `Bearer ${computeRoToken}` },
        serviceBindings: { CAS_SERVICE: request => casWorker.fetch(request),
          COMPUTE_SERVICE: async request => compute.dispatchFetch(request.url,
            { method: request.method, headers: request.headers, body: await request.arrayBuffer() }) },
      }] });
    platform = new Miniflare(platformOptions); await platform.ready;
    const platformCall = async body => {
      const response = await platform.dispatchFetch("http://platform/", { method: "POST",
        body: JSON.stringify({ tenantId, ...body }) });
      return { status: response.status, body: await response.json() };
    };
    const identity = { tenantId, docId: invocation.docId, docType: "markdown",
      ownerActorId: invocation.actorId, schemaVersion: "markdown/1" };
    expect((await platformCall({ action: "create", identity, stateHash: initialHash, at: 100 })).status).toBe(200);
    const initialized = await computeCall(await sign("/v1/editor/init", { invocation,
      source: { schemaVersion: "markdown/1", base: createSBlob(initialHash), changes: [] } }));
    expect(initialized.status).toBe(200);
    const context = initialized.body.data;
    const content = "# 平台提交\n\n中文工作副本";
    const applied = await computeCall(await sign("/v1/editor/apply", { invocation, context,
      changeSet: { operations: [{ kind: "setContent", payload: { content } }] } }, "rw"));
    expect(applied.status).toBe(200);
    expect((await computeCall(await sign("/v1/editor/snapshot", { invocation, context: applied.body.data }))).body)
      .toEqual({ success: true, data: { content } });
    const committed = await platformCall({ action: "snapshot-save", invocation, context: applied.body.data,
      operationId: "save-1", baseVersion: 1, at: 200 });
    expect(committed).toMatchObject({ status: 200, body: { state: "committed", version: 2 } });
    const head = (await platformCall({ action: "read" })).body.head;
    expect(head).toMatchObject({ version: 2, createdAt: 200 });
    const stored = decodeSValue(new Uint8Array(await new Response(await reader.readContent(head.stateHash)).arrayBuffer()));
    expect(stored).toEqual({ content });
    expect((await platformCall({ action: "snapshot-save", invocation, context: applied.body.data,
      operationId: "save-1", baseVersion: 1, at: 300 })).body).toEqual(committed.body);

    await compute.dispose(); compute = undefined;
    await startCompute();
    const reopened = await computeCall(await sign("/v1/editor/init", { invocation: { ...invocation, requestId: "reopen-1" },
      source: { schemaVersion: "markdown/1", base: createSBlob(head.stateHash), changes: [] } }));
    expect(reopened.status).toBe(200);
    const snapshot = await computeCall(await sign("/v1/editor/snapshot", {
      invocation: { ...invocation, requestId: "reopen-1" }, context: reopened.body.data,
    }));
    expect(snapshot.body).toEqual({ success: true, data: { content } });
    expect(await cas.storage.middlewareRetainedRoots(fixture.stackId, tenantId)).toEqual([
      { hash: initialHash, count: 1 }, { hash: head.stateHash, count: 1 },
    ].sort((left, right) => left.hash.localeCompare(right.hash)));
  } finally {
    await platform?.dispose();
    await compute?.dispose();
    await cas?.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
}, 90_000);