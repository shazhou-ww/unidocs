import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { COMPATIBILITY_DATE, SERVICE_WORKER } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";
import { resolveWorkspaceAliases } from "../../../scripts/workspace-aliases.mjs";
import { createTenantCasClient } from "../../../unicas-packages/tenant-client/src/index.ts";
import { storeNodeContent } from "../../../unicas-packages/tenant-blob-client/src/index.ts";
import { CapabilityTokenType, casWritePermission } from "../../../packages/service-auth/src/index.ts";
import { SValueContentType } from "../../../packages/protocol/src/index.ts";
import { encodeSValue } from "../../../packages/svalue-codec/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("platform commit recovers the same retained root after a lost UniCAS response", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const fixture = { stackId: "platform-commit-test", issuer: "https://issuer.example",
    audience: "https://cas.example/stacks/platform-commit-test", kid: "cas-test",
    privateKeyPkcs8: await exportPKCS8(pair.privateKey),
    jwks: { keys: [{ ...await exportJWK(pair.publicKey), kid: "cas-test", alg: "ES256", use: "sig" }] },
    refDomains: [{ refDomain: "platform:documents", status: "active" }],
  };
  const tenantId = "alice";
  const now = Math.floor(Date.now() / 1000);
  const capability = permissions => new SignJWT({ ver: 1, tenantId, refDomain: "platform:documents", permissions })
    .setProtectedHeader({ alg: "ES256", kid: fixture.kid, typ: CapabilityTokenType })
    .setIssuer(fixture.issuer).setAudience(fixture.audience).setSubject("platform")
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300).setJti(crypto.randomUUID()).sign(pair.privateKey);
  const writeToken = await capability([casWritePermission(tenantId)]);
  const built = await build({
    absWorkingDir: root, entryPoints: [join(root, "tests/integration/cloudflare/platform-document-probe.ts")],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers", "node:*"],
    alias: resolveWorkspaceAliases(root),
  });
  const persistence = await mkdtemp(join(tmpdir(), "platform-commit-cas-"));
  let cas;
  let platform;
  const lostRootResponses = new Set();
  try {
    cas = await startLocalRuntime({ docTypes: [], casMiddlewareOnly: true, stackFixture: fixture,
      ports: { cas: 29901, admin: 29902, mockOidc: 29903, edge: 29904 } });
    const casWorker = await cas.mf.getWorker(SERVICE_WORKER);
    const writer = createTenantCasClient({ baseUrl: "https://cas.example", stackId: fixture.stackId, tenantId,
      getToken: async () => writeToken, fetcher: { fetch: (input, init) => casWorker.fetch(input, init) } });
    const initialStateHash = await storeNodeContent(writer, encodeSValue({ content: "" }), SValueContentType);
    const stateHash = await storeNodeContent(writer, encodeSValue({ content: "# 已提交" }), SValueContentType);
    const expectedRoots = [{ hash: initialStateHash, count: 1 }, { hash: stateHash, count: 1 }]
      .sort((left, right) => left.hash.localeCompare(right.hash));
    const options = convertV4MiniflareOptions({
      host: "127.0.0.1", port: 0, log: new Log(LogLevel.WARN), resourcePersistencePath: persistence,
      workers: [{ name: "platform-commit", modules: true, script: built.outputFiles[0].text,
        compatibilityDate: COMPATIBILITY_DATE,
        durableObjects: { DOCUMENTS: { className: "PlatformDocument", useSQLite: true } },
        bindings: { CAS_STACK_ID: fixture.stackId, PLATFORM_CAS_AUTHORIZATION: `Bearer ${writeToken}` },
        serviceBindings: { CAS_SERVICE: async request => {
          const rootRequest = new URL(request.url).pathname.endsWith("/root-refs")
            ? await request.clone().json() : null;
          const response = await casWorker.fetch(request);
          const requestKind = rootRequest?.requestId?.startsWith("platform-create-") ? "create"
            : rootRequest?.requestId?.startsWith("platform-commit-") ? "commit" : null;
          if (requestKind && !lostRootResponses.has(requestKind)) {
            lostRootResponses.add(requestKind);
            if (!response.ok) return response;
            await response.arrayBuffer();
            return Response.json({ error: "injected response loss" }, { status: 503 });
          }
          return response;
        } },
      }],
    });
    const call = async body => {
      const response = await platform.dispatchFetch("http://platform/", {
        method: "POST", body: JSON.stringify({ tenantId, ...body }),
      });
      return { status: response.status, body: await response.json() };
    };
    const identity = { tenantId, docId: "doc-1", docType: "markdown", ownerActorId: "actor-1", schemaVersion: "markdown/1" };
    const candidate = { operationId: "save-1", baseVersion: 1, stateHash };

    platform = new Miniflare(options); await platform.ready;
  expect((await call({ action: "create", identity, stateHash: initialStateHash, at: 100 })).status).toBe(409);
  expect((await call({ action: "read" })).body).toBeNull();
  await platform.dispose(); platform = undefined;
  platform = new Miniflare(options); await platform.ready;
  expect((await call({ action: "create", identity, stateHash: initialStateHash, at: 150 })).status).toBe(200);
    expect((await call({ action: "save", candidate, at: 200 })).status).toBe(409);
    const pending = await call({ action: "pending", operationId: candidate.operationId });
    expect(pending.body).toMatchObject({ candidate, receipt: { state: "pending" } });
    const requestId = `platform-commit-${pending.body.receipt.requestDigest}-root`;
    expect(await cas.storage.middlewareRetainedRoots(fixture.stackId, tenantId)).toEqual(expectedRoots);

    await platform.dispose(); platform = undefined;
    platform = new Miniflare(options); await platform.ready;
    const recovered = await call({ action: "save", candidate, at: 300 });
    expect(recovered).toMatchObject({ status: 200, body: { state: "committed", version: 2 } });
    expect((await call({ action: "read" })).body.head).toEqual({ version: 2, stateHash, createdAt: 300 });
    expect((await cas.storage.middlewareRootRefRequestIds(fixture.stackId, tenantId)).filter(value => value === requestId)).toHaveLength(1);
    expect(await cas.storage.middlewareRetainedRoots(fixture.stackId, tenantId)).toEqual(expectedRoots);
    expect(await call({ action: "save", candidate, at: 400 })).toEqual(recovered);
  } finally {
    await platform?.dispose();
    await cas?.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
}, 90_000);