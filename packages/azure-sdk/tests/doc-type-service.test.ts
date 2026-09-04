/**
 * `startDocTypeService()` 的行为:它必须起一个能完整走 create → apply →
 * query 的服务,并且**每个请求新建一个 DocumentSession**（见
 * local-editor.ts 的模块注释：这是多副本正确性的前提，不是可以之后用
 * LRU 优化掉的实现细节）。
 */
import { afterEach, describe, expect, it, test } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import type { DocumentType, SBlob } from "@unidocs/protocol";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import {
  CapabilityAlgorithm,
  CapabilityTokenType,
  casReadPermission,
  casWritePermission,
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
} from "../../service-auth/src/index.js";
import type { CapabilityPermission, VerifiedCapability } from "../../service-auth/src/index.js";
import { startDocTypeService } from "../src/doc-type-service.js";
import { PgFontRegistry } from "../src/font-registry-pg.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

let handle: { url: string; close(): Promise<void> } | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

interface CasProbeDoc {
  blob: SBlob;
}

interface CasProbeOp {
  kind: "noop";
}

const PROBE_HASH = "d".repeat(64);

/**
 * A minimal synthetic `DocumentType` whose TDoc carries a branded SBlob.
 * JSON apply payloads cannot transport the SBlob brand, so this probe pins
 * refs at create() via collectSBlobRefs(init()), which hits updateRootRefs
 * on the 501 CAS stub.
 */
function createCasProbeDocumentType(): DocumentType<CasProbeDoc, unknown, CasProbeOp> {
  return {
    init: async () => ({ blob: createSBlob(PROBE_HASH) }),
    query: async () => null,
    apply: async (_operations, doc) => doc,
    formats: {
      text: {
        mediaTypes: ["text/plain"],
        extensions: [".txt"],
        load: async () => ({ blob: createSBlob(PROBE_HASH) }),
        save: async () => new TextEncoder().encode("{}"),
      },
    },
    defaultFormat: "text",
    contentType: "text/plain",
    tools: {},
    instructions: "",
  };
}

async function start(
  port: number,
  overrides: {
    docType?: string;
    documentType?: DocumentType<any, any, any>;
    documentAgent?: any;
    llmProvider?: any;
    fontRegistryFor?: any;
  } = {},
) {
  const docType = overrides.docType ?? "markdown";
  const pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
  await pool.end();
  return startDocTypeService({
    docType,
    documentTypeFactory: overrides.documentType
      ? () => overrides.documentType!
      : createMarkdownDocumentType,
    port,
    host: "127.0.0.1",
    config: {
      databaseUrl: DATABASE_URL,
      blobConnectionString: BLOB_CONNECTION_STRING,
      casStackId: "test-stack",
      docCapabilityVerifier: { verify: async token => verifyTestToken(token, "doc", docType) },
      casCapabilityVerifier: { verify: async token => verifyTestToken(token, "cas", docType) },
    },
    ...(overrides.documentAgent === undefined ? {} : { documentAgent: overrides.documentAgent }),
    ...(overrides.llmProvider === undefined ? {} : { llmProvider: overrides.llmProvider }),
    ...(overrides.fontRegistryFor === undefined
      ? {}
      : { fontRegistryFor: overrides.fontRegistryFor }),
  });
}

function internal(
  url: string,
  tenantId: string,
  sessionId: string,
  operation: "create" | "apply" | "query" | "run" | "reset",
  init: RequestInit = {},
) {
  const suffix = operation === "create" ? "" : `/${operation}`;
  return fetch(`${url}/tenants/${tenantId}/sessions/${sessionId}${suffix}`, {
    ...init,
    headers: {
      Connection: "close",
      Authorization: `Bearer doc|${tenantId}|${sessionId}|${operation}`,
      "X-UniDocs-CAS-Capability": `cas|${tenantId}|${sessionId}|${operation}`,
      ...(init.headers ?? {}),
    },
  });
}

function verifyTestToken(token: string, expectedKind: "doc" | "cas", docType: string): VerifiedCapability {
  const [kind, tenantId, sessionId, operation] = token.split("|");
  if (kind !== expectedKind || !tenantId || !sessionId || !operation) throw new Error("invalid test token");
  const permissions: readonly CapabilityPermission[] = kind === "doc"
    ? operation === "create"
      ? [sessionCreatePermission(tenantId)]
      : operation === "query"
        ? [sessionReadPermission(tenantId, sessionId)]
        : [sessionWritePermission(tenantId, sessionId)]
    : operation === "create"
      ? [casWritePermission(tenantId)]
      : operation === "query"
        ? [casReadPermission(tenantId)]
        : [casReadPermission(tenantId), casWritePermission(tenantId)];
  return {
    protectedHeader: { alg: CapabilityAlgorithm, kid: "test-key", typ: CapabilityTokenType },
    claims: {
      ver: 1,
      iss: kind === "doc" ? "gateway" : "stack",
      sub: kind === "doc" ? "gateway" : `doc:${docType}`,
      aud: kind === "doc" ? `unidocs-doc:${docType}` : "unidocs-cas",
      iat: 1000,
      nbf: 995,
      exp: 1120,
      jti: `${kind}-jti`,
      tenantId,
      sessionId,
      permissions,
    },
  };
}

test("create → apply → query round-trips through the service", async () => {
  handle = await start(41999);
  const sessionId = `svc-${Date.now()}`;

  const created = await internal(handle.url, "tenant-1", sessionId, "create", {
    method: "PUT",
  });
  const createdBody = await created.json();
  expect(createdBody, JSON.stringify(createdBody)).toMatchObject({ success: true });

  const applied = await internal(handle.url, "tenant-1", sessionId, "apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion: 1,
      description: "set",
      operations: [{ kind: "setContent", payload: { content: "# hi" } }],
    }),
  });
  expect(await applied.json()).toMatchObject({ success: true, version: 2 });

  const queried = await internal(handle.url, "tenant-1", sessionId, "query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "getContent" }),
  });
  expect(await queried.json()).toMatchObject({ success: true, version: 2, data: "# hi" });

  const wrongTenant = await internal(handle.url, "another-tenant", sessionId, "query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ kind: "getContent" }),
  });
  expect(wrongTenant.status).toBe(404);
});

/**
 * Replaces a prior version of this test that hit an unrelated CAS path
 * directly. That request 404s inside `createDocTypeHandler`'s own router
 * before `buildDeps()`'s `cas` construction is ever touched — `"cas"` isn't
 * a `docId` any editor/operator method recognizes, and `doc-type-handler.ts`
 * has no CAS route at all (that only exists in `gateway-handler.ts`, which
 * isn't wired into `startDocTypeService`). It asserted `[404, 501]`, which
 * meant it passed unconditionally regardless of whether the CAS stub wiring
 * in `doc-type-service.ts` was correct.
 *
 * This version reaches the stub for real: `createCasProbeDocumentType()`'s
 * `refsFromOp` returns a non-empty ref, so `apply()`'s `leaseOpRefs` call
 * actually invokes `deps.cas.leaseNode("deadbeef")`, which goes through
 * the tenant CAS client to the 501 stub fetcher `doc-type-service.ts` wires up when
 * `casBaseUrl` is absent. The stub's 501 becomes a `CasClientError(501, ...)`
 * that `DocumentSession.apply()` lets propagate unchanged (session.ts step
 * 1's comment: "A CAS client error propagates verbatim"), and
 * `session-handler.ts`'s `errorResponse()` maps any `CasClientError` whose
 * status isn't 409 or 404 to HTTP 502 — so 502 is the status the code under
 * test actually produces, not a guess.
 */
test("without a CAS base URL, create() pinning TDoc SBlobs surfaces the 501 stub as 502", async () => {
  handle = await start(41998, {
    docType: "cas-probe",
    documentType: createCasProbeDocumentType(),
  });
  const sessionId = `cas-probe-${Date.now()}`;

  const created = await internal(handle.url, "tenant-1", sessionId, "create", {
    method: "PUT",
  });

  const body = await created.json();
  expect(created.status, JSON.stringify(body)).toBe(502);
  expect(body.success).toBe(false);
  expect(body.error).toMatch(/updateRootRefs/);
  expect(body.error).toMatch(/501/);
});

describe("agent 接线", () => {
  // 只给一半是那种"容器起来了、跑到第一次 /run 才炸"的配置错误。启动期响亮
  // 失败,不要等 15 分钟部署完看崩溃日志。
  it("只给 documentAgent 不给 llmProvider -> 启动期抛错", async () => {
    await expect(start(0, { documentAgent: () => ({ tools: [], instructions: "" }) }))
      .rejects.toThrow(/llmProvider/);
  });

  it("只给 llmProvider 不给 documentAgent -> 启动期抛错", async () => {
    await expect(start(0, { llmProvider: { complete: async () => ({ text: "", toolCalls: [] }) } }))
      .rejects.toThrow(/documentAgent/);
  });

  // 测试 1、2 的校验在 serve() 之前就抛错,永远不会真的监听,所以 port: 0
  // 无害;这条测试要发真实 HTTP 请求,而 startDocTypeService 是用传入的
  // port 字面量拼 handle.url 的(不是 server.listen(0) 实际分到的端口),传
  // 0 会得到 http://127.0.0.1:0,连不上 —— 所以这里用一个具体的未占用端口。
  it("两个都不给 -> operator 维持 501,不报错", async () => {
    const handle = await start(41997);
    try {
      const res = await internal(handle.url, "tenant-1", `svc-${Date.now()}`, "run", { method: "POST" });
      expect(res.status).toBe(501);
      // 501 和 404 都是"没跑起来":光看状态码分不清是 stub 正确拒绝了,还是
      // 请求压根没路由到 operator(这正是上面那处 brief 缺陷落进去的盲区)。
      // 断言错误文案确实来自 createStubOperatorNamespace(),钉住"路由通到了
      // operator,且 operator 选择了 stub 分支"。
      const body = await res.json();
      expect(body).toMatchObject({
        success: false,
        error: "Operator is not implemented on Azure yet",
      });
    } finally {
      await handle.close();
    }
  });
});

/**
 * 租户级的 `/tenants/{t}/fonts`。
 *
 * 两条不变式，任何一条破了都只在生产里才看得出来：
 *
 * 1. **分流必须在 `createDocTypeHandler` 之前。** `matchDocRoute` 把路径硬编码
 *    成 `/tenants/{t}/sessions/{s}[/{op}]`，`/tenants/{t}/fonts` 不匹配，交给
 *    doc handler 只会得到 404 "Unknown Doc endpoint"。
 * 2. **存储异常要以 fonts 端点自己的错误形状返回。** 中立的
 *    `handleFontsRequest` 不接管 `registry.list/put` 的抛出（CF 那边原来由 DO
 *    自己的 try/catch 兜）。这里**不是**"不兜就变成未处理拒绝"——
 *    `serve()`（http-shell.ts）有顶层兜底，Node 宿主上一次 Postgres 故障本来
 *    就是 500；那条理由是从 CF/workerd 照抄的，在这里为假。真正的区别是错误
 *    形状：宿主兜底给 `{"error":"Unhandled error: ..."}`，那个前缀的语义是
 *    "处理器自己有 bug"，而存储故障是这个端点可预期的失败，不该借用它。
 *    下面第三条用例用**精确的 body 相等**钉这条，理由写在它自己的注释里。
 */
describe("fonts 路由", () => {
  const fontsUrl = (url: string, tenantId: string) => `${url}/tenants/${tenantId}/fonts`;
  const fontsAuth = (tenantId: string) => ({
    Connection: "close",
    // 索引是租户级的，所以要的是租户作用域的那种权限 —— sessionCreatePermission。
    Authorization: `Bearer doc|${tenantId}|any-session|create`,
  });

  it("不给 fontRegistryFor 就不挂这条路由 —— 落回 doc handler 的 404", async () => {
    handle = await start(41996);
    const res = await fetch(fontsUrl(handle.url, "tenant-1"), { headers: fontsAuth("tenant-1") });
    expect(res.status).toBe(404);
  });

  it("给了就命中 fonts handler，且在 doc handler 之前分流", async () => {
    const entry = {
      postScriptName: "NotoSans-Regular",
      family: "Noto Sans",
      hash: "a".repeat(64),
      unitsPerEm: 1000,
      coverage: [[0x20, 0x7e]],
    };
    const seen: string[] = [];
    handle = await start(41995, {
      fontRegistryFor: (tenantId: string) => {
        seen.push(tenantId);
        return { list: async () => [entry], put: async () => {} };
      },
    });
    const res = await fetch(fontsUrl(handle.url, "tenant-1"), { headers: fontsAuth("tenant-1") });
    // 200 而不是 404 —— 404 正是"落到了 createDocTypeHandler 手里"的signal。
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fonts: [entry] });
    // registry 按路径里的租户构造，不是按启动期的某个固定值。
    expect(seen).toEqual(["tenant-1"]);
  });

  /**
   * 只断言 `status === 500` + `/connection terminated/` 是一张**假安全网**：
   * `serve()` 自己的顶层兜底（http-shell.ts）对同一次抛出也给 500、body 里
   * 也含这个串，两条路径分不开 —— 把 `fontsRouter` 的 try/catch 整段删掉，
   * 那样的断言照样全绿（评审实测）。
   *
   * 所以这里比的是**精确的 body**：
   *   走 fontsRouter 的 catch -> {"error":"Error: connection terminated ..."}
   *   落到 serve() 的兜底     -> {"error":"Unhandled error: Error: ..."}
   * `Unhandled error:` 那个前缀在语义上是"处理器本身有 bug"，而存储故障是这个
   * 端点可预期的失败，不该借用它。
   */
  it("registry 抛出 -> 500，且是 fonts 端点自己的错误形状（不带 Unhandled error: 前缀）", async () => {
    handle = await start(41994, {
      fontRegistryFor: () => ({
        list: async () => { throw new Error("connection terminated unexpectedly"); },
        put: async () => {},
      }),
    });
    const res = await fetch(fontsUrl(handle.url, "tenant-1"), { headers: fontsAuth("tenant-1") });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Error: connection terminated unexpectedly" });
  });

  /**
   * 真实端到端：`PgFontRegistry` 与 `handleFontsRequest` 的**接缝**。
   *
   * 两半各自单测过（font-registry-pg.test.ts 打真 Postgres，font-registry
   * 的校验器有自己的用例），但没有在一次真实 HTTP 请求里串起来过。这条覆盖
   * 的是只在接缝上才会出问题的那几件事：handler 校验后的 `FontEntry` 能否
   * 原样落库、`coverage` 的 jsonb 往返是否保形（数组套数组，pg 解析回来的
   * 是 JS 值不是字符串）、`ORDER BY post_script_name` 的行形状能否直接满足
   * `Response.json({ fonts })`。
   *
   * 不需要 CAS 里有真字节：登记表只存元数据（裁定 R29），`hash` 就是一个
   * 64 位十六进制字符串。`font_registry` 表由 start() 里的 runMigrations()
   * 建好（migrations/0005_font_registry.sql）。
   */
  it("端到端：POST 登记 -> GET 取回，经真的 PgFontRegistry", async () => {
    // 每次跑用一个新租户，免得同一个库上的重复运行互相看见对方的行。
    const tenantId = `fonts-e2e-${Date.now()}`;
    handle = await start(41992, {
      fontRegistryFor: (t: string, pool: any) =>
        new PgFontRegistry(pool, { stackId: "test-stack", tenantId: t }),
    });
    const entry = {
      postScriptName: "NotoSansSC-Regular",
      family: "Noto Sans SC",
      hash: "b".repeat(64),
      unitsPerEm: 1000,
      // 两段、升序、不相邻 —— coverage 的形状是硬要求（乱序会让 selectFonts
      // 的二分查找静默返回错的结果）。jsonb 往返必须原样带回来。
      coverage: [[0x20, 0x7e], [0x4e00, 0x9fff]],
    };

    const registered = await fetch(fontsUrl(handle.url, tenantId), {
      method: "POST",
      headers: { ...fontsAuth(tenantId), "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    expect(registered.status, JSON.stringify(await registered.clone().json())).toBe(200);
    expect(await registered.json()).toEqual({ success: true });

    const listed = await fetch(fontsUrl(handle.url, tenantId), { headers: fontsAuth(tenantId) });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ fonts: [entry] });
  });

  it("会话级路径不受影响 —— 分流只吃 /tenants/{t}/fonts", async () => {
    handle = await start(41993, {
      fontRegistryFor: () => ({ list: async () => [], put: async () => {} }),
    });
    const created = await internal(handle.url, "tenant-1", `fonts-${Date.now()}`, "create", {
      method: "PUT",
    });
    expect(await created.json()).toMatchObject({ success: true });
  });
});
