import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "jose";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { SERVICE_WORKER } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";
import { resolveWorkspaceAliases } from "../../../scripts/workspace-aliases.mjs";
import { createTenantCasClient } from "../../../unicas-packages/tenant-client/src/index.ts";
import { storeNodeContent } from "../../../unicas-packages/tenant-blob-client/src/index.ts";
import { encodeSValue, decodeSValue, createSBlob } from "../../../packages/svalue-codec/src/index.ts";
import { SValueContentType } from "../../../packages/protocol/src/index.ts";
import { CapabilityTokenType, casReadPermission, casWritePermission, signPlatformRequest, importPlatformHmacKey } from "../../../packages/service-auth/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("compute Worker reads real CAS, preserves no refs, and rejects replay after restart", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const fixture = { stackId: "compute-test", issuer: "https://issuer.example", audience: "https://cas.example/stacks/compute-test",
    kid: "cas-test", privateKeyPkcs8: await exportPKCS8(pair.privateKey),
    jwks: { keys: [{ ...await exportJWK(pair.publicKey), kid: "cas-test", alg: "ES256", use: "sig" }] },
    refDomains: [{ refDomain: "doc", status: "active" }],
  };
  const rawHmac = crypto.getRandomValues(new Uint8Array(32));
  const hmac = { keyId: "compute-key", platformId: "test-platform", environment: "test", serviceId: "markdown-compute",
    role: "editor", key: await importPlatformHmacKey(rawHmac) };
  const target = { origin: "https://compute.example", paths: ["/v1/editor/probe", "/v1/editor/init", "/v1/editor/apply", "/v1/editor/snapshot"] };
  const invocation = { requestId: "request-1", actorId: "actor", tenantId: "alice", docId: "doc", docType: "markdown" };
  const now = Math.floor(Date.now() / 1000);
  const capability = async (mode) => new SignJWT({ ver: 1, tenantId: "alice", refDomain: "doc",
    permissions: mode === "ro" ? [casReadPermission("alice")] : [casReadPermission("alice"), casWritePermission("alice")],
  }).setProtectedHeader({ alg: "ES256", kid: fixture.kid, typ: CapabilityTokenType })
    .setIssuer(fixture.issuer).setAudience(fixture.audience).setSubject("doc:markdown")
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 240).setJti(crypto.randomUUID()).sign(pair.privateKey);
  const ro = await capability("ro");
  const rw = await capability("rw");
  const sign = (path, body, token = ro) => signPlatformRequest({ url: target.origin + path, target, key: hmac,
    body: encodeSValue(body), casAuthorization: token === null ? null : `Bearer ${token}` });
  const built = await build({
    absWorkingDir: root, entryPoints: ["packages/cloudflare-markdown/src/compute-worker.ts"],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers", "node:*"], alias: resolveWorkspaceAliases(root),
  });
  const persistence = await mkdtemp(join(tmpdir(), "markdown-compute-"));
  let cas;
  let compute;
  try {
    cas = await startLocalRuntime({ docTypes: [], casMiddlewareOnly: true, stackFixture: fixture,
      ports: { cas: 29891, admin: 29892, mockOidc: 29893, edge: 29894 } });
    const casWorker = await cas.mf.getWorker(SERVICE_WORKER);
    const nodeClient = createTenantCasClient({ baseUrl: "https://cas.example", stackId: fixture.stackId, tenantId: "alice",
      getToken: async () => rw, fetcher: { fetch: (input, init) => casWorker.fetch(input, init) } });
    const saved = { content: "# 真实 CAS\n\n- 中文测试" };
    const hash = await storeNodeContent(nodeClient, encodeSValue(saved), SValueContentType);
    const casCalls = [];
    let redirectCas = false;
    const options = convertV4MiniflareOptions({
      host: "127.0.0.1", port: 0, log: new Log(LogLevel.WARN), resourcePersistencePath: persistence,
      workers: [{ name: "compute-test", modules: true, script: built.outputFiles[0].text,
        compatibilityDate: "2026-08-18", compatibilityFlags: ["nodejs_compat"],
        durableObjects: { PLATFORM_NONCES: { className: "PlatformNonces", useSQLite: true } },
        bindings: { COMPUTE_ORIGIN: target.origin, PLATFORM_ID: hmac.platformId, COMPUTE_ENVIRONMENT: hmac.environment,
          COMPUTE_SERVICE_ID: hmac.serviceId, CAS_ORIGIN: "https://cas.example", CAS_STACK_ID: fixture.stackId,
          CAS_ISSUER: fixture.issuer, CAS_AUDIENCE: fixture.audience, CAS_JWKS_URL: "https://issuer.example/jwks",
          PLATFORM_HMAC_KEYS: JSON.stringify({ [hmac.keyId]: Array.from(rawHmac, (byte) => byte.toString(16).padStart(2, "0")).join("") }),
        },
        serviceBindings: { CAS_SERVICE: async (request) => {
          casCalls.push({ method: request.method, path: new URL(request.url).pathname });
          if (redirectCas) return Response.redirect("https://attacker.example/cas", 302);
          return casWorker.fetch(request);
        } },
        outboundService: async (request) => request.url === "https://issuer.example/jwks"
          ? Response.json(fixture.jwks) : new Response(null, { status: 403 }),
      }],
    });
    compute = new Miniflare(options);
    await compute.ready;
    const call = async (request) => {
      const response = await compute.dispatchFetch(request.url, { method: request.method, headers: request.headers, body: await request.arrayBuffer() });
      return { status: response.status, body: decodeSValue(new Uint8Array(await response.arrayBuffer())) };
    };
    const probe = await sign("/v1/editor/probe", {}, null);
    expect((await call(probe.clone())).status).toBe(200);
    const source = { schemaVersion: "markdown/1", base: createSBlob(hash), changes: [] };
    const initialized = await call(await sign("/v1/editor/init", { invocation, source }));
    expect(initialized.status, JSON.stringify({ body: initialized.body, casCalls })).toBe(200);
    const context = initialized.body.data;
    expect((await call(await sign("/v1/editor/snapshot", { invocation, context }))).body).toEqual({ success: true, data: saved });
    expect((await call(await sign("/v1/editor/apply", { invocation, context,
      changeSet: { operations: [{ kind: "setContent", payload: { content: "# 工作副本" } }] } }, rw))).status).toBe(200);
    expect((await call(await sign("/v1/editor/snapshot", { invocation, context: { ...context, sequence: 1 } }))).body)
      .toEqual({ success: true, data: { content: "# 工作副本" } });
    expect((await call(await sign("/v1/editor/init", { invocation, source }, rw))).status).toBe(403);
    expect((await call(await sign("/v1/editor/init", { invocation: { ...invocation, tenantId: "bob" }, source }))).status).toBe(403);
    await compute.dispose(); compute = undefined;
    compute = new Miniflare(options); await compute.ready;
    expect((await call(probe)).body).toMatchObject({ success: false, error: { code: "replay_detected" } });
    expect((await call(await sign("/v1/editor/snapshot", { invocation, context }))).status).toBe(410);
    const reopened = await call(await sign("/v1/editor/init", { invocation, source }));
    expect(reopened.status).toBe(200);
    expect((await call(await sign("/v1/editor/snapshot", { invocation, context: reopened.body.data }))).body).toEqual({ success: true, data: saved });
    redirectCas = true;
    expect((await call(await sign("/v1/editor/init", { invocation, source }))).body)
      .toMatchObject({ success: false, error: { code: "resource_unavailable" } });
    redirectCas = false;
    expect(casCalls.length).toBeGreaterThan(0);
    expect(casCalls.every((call) => call.method === "GET" && /\/(metadata|content)$/.test(call.path))).toBe(true);
    expect(await cas.storage.middlewareRootRefRequestIds(fixture.stackId, "alice")).toEqual([]);
  } finally {
    await compute?.dispose();
    await cas?.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
}, 90_000);