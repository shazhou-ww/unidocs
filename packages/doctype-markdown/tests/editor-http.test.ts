import { describe, expect, it, vi } from "vitest";
import { SValueContentType, isServiceResult, isEditorContext } from "@unidocs/protocol-doctype";
import type { EditorContext } from "@unidocs/protocol-doctype";
import type { SValue } from "@unidocs/protocol";
import { createSBlob, decodeSValue, encodeSValue } from "@unidocs/svalue-codec";
import { CasAuthorizationHeader, importPlatformHmacKey, signPlatformRequest } from "@unidocs/service-auth";
import type { PlatformHmacKey } from "@unidocs/service-auth";
import { createMarkdownEditorHandler, MarkdownEditorPaths } from "../src/editor-http.js";
import type { MarkdownEditorHttpOptions } from "../src/editor-http.js";

const origin = "https://markdown.example";
const target = { origin, paths: Object.values(MarkdownEditorPaths) };
const key: PlatformHmacKey = {
  keyId: "editor-1", platformId: "platform", environment: "test", serviceId: "markdown-compute",
  role: "editor", key: await importPlatformHmacKey(new Uint8Array(32).fill(0x41)),
};
const invocation = { requestId: "request-1", actorId: "actor-1", tenantId: "tenant-1", docId: "doc-1", docType: "markdown" };
const source = { schemaVersion: "markdown/1", base: null, changes: [] };

function setup(overrides: Partial<MarkdownEditorHttpOptions> = {}) {
  const seen = new Set<string>();
  const authorizeCas = vi.fn(async () => true);
  const loadSnapshot = vi.fn(async () => ({ content: "stored" }));
  const claim = vi.fn(async (scope: string, nonce: string) => {
    const identity = JSON.stringify([scope, nonce]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const options: MarkdownEditorHttpOptions = {
    origin, platformId: key.platformId, environment: key.environment, serviceId: key.serviceId,
    keys: () => [key], nonces: { claim }, authorizeCas, loadSnapshot, now: () => 1000, ...overrides,
  };
  return { handle: createMarkdownEditorHandler(options), options, authorizeCas, loadSnapshot, claim };
}

function request(path: string, body: SValue, authorization: string | null = "Bearer cas-token") {
  return signPlatformRequest({ url: origin + path, target, key, body: encodeSValue(body), casAuthorization: authorization, now: () => 1000 });
}

async function decode(response: Response): Promise<SValue> {
  expect(response.headers.get("content-type")).toBe(SValueContentType);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return decodeSValue(new Uint8Array(await response.arrayBuffer()));
}

async function init(handle: (request: Request) => Promise<Response>): Promise<EditorContext> {
  const result = await handle(await request(MarkdownEditorPaths.init, { invocation, source }));
  expect(result.status).toBe(200);
  return contextResult(await decode(result));
}

function contextResult(value: unknown): EditorContext {
  if (!isServiceResult(value, isEditorContext) || !value.success) throw new Error("Expected editor context response");
  return value.data;
}

describe("Markdown SValue HTTP", () => {
  it("computes Chinese content through authenticated init/apply/snapshot", async () => {
    const { handle, authorizeCas } = setup();
    const context = await init(handle);
    const applied = await handle(await request(MarkdownEditorPaths.apply, {
      invocation, context: { ...context }, changeSet: { operations: [{ kind: "setContent", payload: { content: "# 中文\n\n- 正文" } }] },
    }));
    expect(applied.status).toBe(200);
    expect(await decode(applied)).toEqual({ success: true, data: { ...context, sequence: 1 } });
    const snapshot = await handle(await request(MarkdownEditorPaths.snapshot, { invocation, context: { ...context, sequence: 1 } }));
    expect(await decode(snapshot)).toEqual({ success: true, data: { content: "# 中文\n\n- 正文" } });
    expect(authorizeCas.mock.calls.map((call) => (call as unknown as [{ mode: string }])[0].mode)).toEqual(["ro", "rw", "ro"]);
  });

  it("provides a protected credential-free probe", async () => {
    const { handle, authorizeCas, loadSnapshot } = setup();
    const result = await handle(await request(MarkdownEditorPaths.probe, {}, null));
    expect(result.status).toBe(200);
    expect(await decode(result)).toMatchObject({ success: true, data: { role: "editor", serviceId: key.serviceId, operations: ["init", "apply", "snapshot"] } });
    expect(authorizeCas).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("rejects unsigned requests before CAS or calculation", async () => {
    const { handle, authorizeCas, loadSnapshot, claim } = setup();
    const result = await handle(new Request(origin + MarkdownEditorPaths.init, {
      method: "POST", headers: { "content-type": SValueContentType }, body: new Uint8Array(encodeSValue({ invocation, source })),
    }));
    expect(result.status).toBe(401);
    expect(await decode(result)).toMatchObject({ success: false, error: { code: "unauthorized" } });
    expect(authorizeCas).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects body and CAS header tampering before resource access", async () => {
    const { handle, authorizeCas, loadSnapshot } = setup();
    const signed = await request(MarkdownEditorPaths.init, { invocation, source });
    const headers = new Headers(signed.headers);
    headers.set(CasAuthorizationHeader, "Bearer other");
    const result = await handle(new Request(signed.url, { method: "POST", headers, body: await signed.arrayBuffer() }));
    expect(result.status).toBe(401);
    expect(authorizeCas).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("rejects replay even in another handler instance sharing nonce storage", async () => {
    const { handle, options } = setup();
    const signed = await request(MarkdownEditorPaths.init, { invocation, source });
    expect((await handle(signed.clone())).status).toBe(200);
    const restarted = createMarkdownEditorHandler(options);
    const repeated = await restarted(signed);
    expect(repeated.status).toBe(409);
    expect(await decode(repeated)).toMatchObject({ success: false, error: { code: "replay_detected" } });
  });

  it("does not accept another tenant's context with a fresh valid signature", async () => {
    const { handle } = setup();
    const context = await init(handle);
    const result = await handle(await request(MarkdownEditorPaths.snapshot, {
      invocation: { ...invocation, tenantId: "other" }, context: { ...context },
    }));
    expect(result.status).toBe(410);
    expect(await decode(result)).toMatchObject({ success: false, error: { code: "context_lost" } });
  });

  it("requires the declared CAS mode even for empty state and snapshot", async () => {
    const denied = setup({ authorizeCas: async () => false });
    const result = await denied.handle(await request(MarkdownEditorPaths.init, { invocation, source }));
    expect(result.status).toBe(403);
    expect(denied.loadSnapshot).not.toHaveBeenCalled();
    const { handle, authorizeCas } = setup();
    expect((await handle(await request(MarkdownEditorPaths.init, { invocation, source }, null))).status).toBe(403);
    expect(authorizeCas).not.toHaveBeenCalled();
  });

  it("keeps concurrent snapshot readers scoped to their signed credentials", async () => {
    const accesses: string[] = [];
    const { handle } = setup({ loadSnapshot: async (_blob, access) => {
      accesses.push(access.authorization);
      await Promise.resolve();
      return { content: access.invocation.tenantId };
    } });
    const blob = createSBlob("a".repeat(64));
    const results = await Promise.all(["first", "second"].map(async (tenantId) => {
      const identity = { ...invocation, tenantId };
      const initialized = await handle(await request(MarkdownEditorPaths.init, { invocation: identity, source: { ...source, base: blob } }, `Bearer ${tenantId}`));
      const context = contextResult(await decode(initialized));
      return decode(await handle(await request(MarkdownEditorPaths.snapshot, { invocation: identity, context: { ...context } }, `Bearer ${tenantId}`)));
    }));
    expect(accesses.sort()).toEqual(["Bearer first", "Bearer second"]);
    expect(results).toEqual([{ success: true, data: { content: "first" } }, { success: true, data: { content: "second" } }]);
  });

  it("fails closed on nonce or CAS authorization storage failure", async () => {
    const { handle, authorizeCas } = setup({ nonces: { claim: async () => { throw new Error("secret"); } } });
    const result = await handle(await request(MarkdownEditorPaths.init, { invocation, source }));
    expect(result.status).toBe(503);
    expect(await decode(result)).toEqual({ success: false, error: { code: "unavailable", message: "unavailable" } });
    expect(authorizeCas).not.toHaveBeenCalled();
    const failedCas = setup({ authorizeCas: async () => { throw new Error("secret"); } });
    expect((await failedCas.handle(await request(MarkdownEditorPaths.init, { invocation, source }))).status).toBe(503);
  });

  it("does not execute after an authorization wait outlives the signature", async () => {
    let now = 1000;
    const { handle, loadSnapshot } = setup({ now: () => now, authorizeCas: async () => { now = 1090; return true; } });
    const result = await handle(await request(MarkdownEditorPaths.init, {
      invocation, source: { ...source, base: createSBlob("a".repeat(64)) },
    }));
    expect(result.status).toBe(401);
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("rejects signed JSON bytes instead of adding a compatibility path", async () => {
    const { handle, authorizeCas } = setup();
    const signed = await signPlatformRequest({ url: origin + MarkdownEditorPaths.init, target, key,
      body: new TextEncoder().encode(JSON.stringify({ invocation, source })), casAuthorization: "Bearer token", now: () => 1000 });
    const result = await handle(signed);
    expect(result.status).toBe(400);
    expect(authorizeCas).not.toHaveBeenCalled();
  });

  it("rejects unsupported schemas and extra fields without accessing CAS", async () => {
    const { handle, authorizeCas } = setup();
    expect((await handle(await request(MarkdownEditorPaths.init, { invocation, source: { ...source, schemaVersion: "markdown/2" } }))).status).toBe(422);
    expect((await handle(await request(MarkdownEditorPaths.init, { invocation, source, token: "secret" }))).status).toBe(400);
    expect(authorizeCas).not.toHaveBeenCalled();
  });

  it("rejects an operator key even if accidentally supplied by the key provider", async () => {
    const operator = { ...key, role: "operator" as const };
    const { handle } = setup({ keys: () => [operator] });
    const signed = await signPlatformRequest({ url: origin + MarkdownEditorPaths.probe, target, key: operator,
      body: encodeSValue({}), now: () => 1000 });
    expect((await handle(signed)).status).toBe(401);
  });
});