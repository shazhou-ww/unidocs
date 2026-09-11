# Tenant Portal WebUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `@unidocs/tenant-portal-webui` 与它依赖的 `@unidocs/tenant-portal-client`，交付评论驱动、内容只读的 Markdown 全链路租户端界面。

**Architecture:** client 把 `PlatformEndpointContracts` 的 13 个 operation 变成可调用方法，transport 可替换；本轮注入内存假后端（真实幂等与错误码 + 脚本化 Agent 产 pong），因为 tenant 数据面尚不存在。渲染层走 `protocol-platform/src/view.ts` 的 Host RPC 契约但跑在同进程，以后换隔离 iframe 只替换 `ViewChannel` 一个文件。thread 的 open 状态由 ping/pong 水位纯派生，所以界面上没有解决按钮。

**Tech Stack:** TypeScript 5.9、React 19、Vite 7、Vitest 3、@testing-library/react 16、marked 15.0.12、DOMPurify 3.2.6、pnpm workspace。

**Spec:** [`docs/superpowers/specs/2026-09-11-tenant-portal-webui-design.md`](../specs/2026-09-11-tenant-portal-webui-design.md)

## Global Constraints

- 依赖方向固定，不得反向：`tenant-portal-webui -> tenant-portal-client -> protocol-platform`。webui 不直接 import `protocol-platform` 以外的协议包。
- **不修改 `packages/protocol-platform/`**。两处缺口（marker 缺 role、`ThreadRef` 无讨论计数）用本地类型与 N+1 顶着，见 Task 8、Task 10。
- 界面上**不得出现**：解决 / 重新打开按钮、批量提交条、常驻评论输入框、任何编辑内容的入口。顶栏是「只读 · 内容由 Agent 编辑」。
- 文案约定：pong 只表示**已处理**，不表示已接受。纯 pong（`resultLocations` 为空）用中性色，**不得显示版本号**。
- 版本号显示为 `v{versionIdx}`，`versionIdx` 从 0 开始，`null` 才表示不存在。
- 依赖版本与 `@unidocs/web-gateway` 对齐并锁定：`marked` 为 `15.0.12`，`dompurify` 为 `3.2.6`（无 `^`）；`react` / `react-dom` 为 `^19.0.0`。
- 所有新包 `"private": true`、`"type": "module"`、`"version": "0.1.0"`。
- 发送失败一律保留草稿并复用原 `idempotencyKey`，任何失败都不吞掉用户写的字。
- 后置、不在本计划内：全屏版本回看、PSD 位置类型、真实 iframe 隔离、真实后端与登录。

---

## File Structure

### `packages/tenant-portal-client/`（库包，composite，进根 tsconfig references）

| 文件 | 职责 |
| --- | --- |
| `src/errors.ts` | `PlatformError`，`ApiError` → 异常的映射 |
| `src/transport.ts` | `PlatformRequest` / `PlatformResponse` / `PlatformTransport` 类型 |
| `src/client.ts` | `createTenantPortalClient`，13 个 operation 的路径与参数构造 |
| `src/http-transport.ts` | `createHttpTransport`，`fetch` 实现 |
| `src/doctypes/markdown.ts` | Markdown 的 snapshot 与 text-range location 形状（临时家，见 Task 3） |
| `src/memory/store.ts` | 假后端的内存数据结构与读写原语 |
| `src/memory/transport.ts` | `createMemoryTransport`，把 `PlatformRequest` 路由到 store |
| `src/memory/agent.ts` | 脚本化 Agent，ping 写入后产 pong |
| `src/memory/seed.ts` | 样本数据，覆盖六种 thread 情形 |
| `src/index.ts` | 公开导出 |

### `packages/tenant-portal-webui/`（应用包，noEmit，**不**进根 tsconfig references）

| 文件 | 职责 |
| --- | --- |
| `index.html` / `src/main.tsx` | Vite 入口 |
| `src/app.tsx` | 路由与 client 注入 |
| `src/styles.css` | 低饱和灰白工作空间的基础 token |
| `src/view/channel.ts` | `ViewChannel` 与 `createLocalChannel` |
| `src/view/markdown-view.ts` | `MarkdownView`，view 侧六个方法 |
| `src/view/markers.ts` | `MarkerRole` / `RoledMarker` 本地类型（待协议补齐） |
| `src/view/view-host.tsx` | `ViewHost` React 组件，持有 channel 与 view 实例 |
| `src/model/thread-state.ts` | 水位派生、`ThreadView` 视图模型 |
| `src/model/discussion-summary.ts` | 作品卡片的讨论计数（N+1 集中于此） |
| `src/model/compare.ts` | 右栏四种情况的判定 |
| `src/drafts/use-drafts.ts` | localStorage 草稿 |
| `src/pages/workbench.tsx` | 我的作品 |
| `src/pages/document.tsx` | 文档页与分屏 |
| `src/panel/thread-panel.tsx` | 316px 讨论面板 |
| `src/panel/thread-card.tsx` | 一处的 ping / pong / 草稿卡片 |
| `src/panel/composer.tsx` | 动作触发的输入框 |
| `tests/setup.ts` | testing-library 与 jsdom 补丁 |

---

## Task 1: tenant-portal-client 包脚手架与错误映射

**Files:**
- Create: `packages/tenant-portal-client/package.json`
- Create: `packages/tenant-portal-client/tsconfig.json`
- Create: `packages/tenant-portal-client/vitest.config.ts`
- Create: `packages/tenant-portal-client/src/errors.ts`
- Create: `packages/tenant-portal-client/src/transport.ts`
- Create: `packages/tenant-portal-client/src/index.ts`
- Modify: `tsconfig.json`（根，追加一条 reference）
- Test: `packages/tenant-portal-client/tests/errors.test.ts`

**Interfaces:**
- Consumes: `@unidocs/protocol-platform` 的 `ApiError`、`PlatformErrorCode`。
- Produces: `PlatformError`（`code` / `requestId` / `message` / `details`）、`toPlatformError(error: ApiError): PlatformError`、`PlatformRequest`、`PlatformResponse`、`PlatformTransport`。后续所有 task 都用这三个类型。

- [ ] **Step 1: 建包骨架**

`packages/tenant-portal-client/package.json`：

```json
{
  "name": "@unidocs/tenant-portal-client",
  "version": "0.1.0",
  "private": true,
  "description": "Browser SDK for the UniDocs tenant plane HTTP API",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc -b",
    "test": "vitest run",
    "clean": "rimraf --glob dist \"*.tsbuildinfo\""
  },
  "dependencies": {
    "@unidocs/protocol-platform": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`packages/tenant-portal-client/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "lib": ["ES2024", "DOM"],
    "types": []
  },
  "include": ["src"],
  "references": [{ "path": "../protocol-platform" }]
}
```

`packages/tenant-portal-client/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

在根 `tsconfig.json` 的 `references` 数组末尾追加（紧跟 `packages/cloudflare-gateway` 之后）：

```json
    {
      "path": "packages/tenant-portal-client"
    }
```

注意：`tsconfig.json` 的 `include` 只有 `src`，而测试在 `tests/`。这与 `protocol-platform` 一致——`tsc -b` 只检查发布面，测试由 vitest 自己转译。

- [ ] **Step 2: 写失败的测试**

`packages/tenant-portal-client/tests/errors.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { PlatformError, toPlatformError } from "../src/errors.js";

describe("toPlatformError", () => {
  it("保留 code、requestId 与 message", () => {
    const error = toPlatformError({
      error: {
        code: "version_conflict",
        message: "current version moved",
        requestId: "req-1",
      },
    });

    expect(error).toBeInstanceOf(PlatformError);
    expect(error.code).toBe("version_conflict");
    expect(error.requestId).toBe("req-1");
    expect(error.message).toBe("current version moved");
    expect(error.details).toBeNull();
  });

  it("保留 details", () => {
    const error = toPlatformError({
      error: { code: "invalid_request", message: "bad", requestId: "req-2", details: { field: "name" } },
    });

    expect(error.details).toEqual({ field: "name" });
  });

  it("未知 code 原样保留，不塌缩成 invalid_request", () => {
    const error = toPlatformError({
      error: { code: "some_future_code", message: "x", requestId: "req-3" },
    });

    expect(error.code).toBe("some_future_code");
  });
});
```

第三条是有意的:服务端可能先于客户端引入新错误码,塌缩会让调用方看到错误的分支。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: FAIL — `Cannot find module '../src/errors.js'`

- [ ] **Step 4: 写实现**

`packages/tenant-portal-client/src/errors.ts`：

```ts
/**
 * Platform API 错误的客户端表示。调用方按 `code` 分支，不解析 `message`。
 */
import type { ApiError, JsonValue, PlatformErrorCode } from "@unidocs/protocol-platform";

/** 已知错误码，或服务端先行引入的未知码。 */
export type PlatformErrorCodeOrUnknown = PlatformErrorCode | (string & {});

export class PlatformError extends Error {
  readonly code: PlatformErrorCodeOrUnknown;
  readonly requestId: string;
  readonly details: JsonValue | null;

  constructor(options: {
    code: PlatformErrorCodeOrUnknown;
    message: string;
    requestId: string;
    details?: JsonValue;
  }) {
    super(options.message);
    this.name = "PlatformError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details ?? null;
  }
}

export function toPlatformError(payload: ApiError): PlatformError {
  return new PlatformError({
    code: payload.error.code,
    message: payload.error.message,
    requestId: payload.error.requestId,
    details: payload.error.details,
  });
}
```

`packages/tenant-portal-client/src/transport.ts`：

```ts
/**
 * transport 是 client 与「怎么把请求送出去」之间的唯一接缝。
 * client 自己不含 fetch，也不知道假后端存在。
 */
import type { ApiError } from "@unidocs/protocol-platform";

export type QueryValue = string | number | boolean | undefined;

export interface PlatformRequest {
  readonly method: "GET" | "POST";
  /** 已拼好的完整路径，含 tenantId，形如 /api/v1/tenants/t1/documents。 */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** 存在时由 transport 落到 idempotency-key 请求头。 */
  readonly idempotencyKey?: string;
}

export type PlatformResponse =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: ApiError };

export type PlatformTransport = (request: PlatformRequest) => Promise<PlatformResponse>;
```

`packages/tenant-portal-client/src/index.ts`：

```ts
export { PlatformError, toPlatformError } from "./errors.js";
export type { PlatformErrorCodeOrUnknown } from "./errors.js";
export type { PlatformRequest, PlatformResponse, PlatformTransport, QueryValue } from "./transport.js";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: PASS，3 个测试。

Run: `pnpm typecheck`
Expected: PASS。若报 `@unidocs/protocol-platform` 未安装，先跑 `pnpm install`。

- [ ] **Step 6: 提交**

```bash
git add packages/tenant-portal-client tsconfig.json pnpm-lock.yaml
git commit -m "feat(portal): scaffold tenant-portal-client with error mapping"
```

---

## Task 2: client 的 13 个 operation 与 HTTP transport

**Files:**
- Create: `packages/tenant-portal-client/src/client.ts`
- Create: `packages/tenant-portal-client/src/http-transport.ts`
- Modify: `packages/tenant-portal-client/src/index.ts`
- Test: `packages/tenant-portal-client/tests/client.test.ts`
- Test: `packages/tenant-portal-client/tests/http-transport.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PlatformRequest`、`PlatformResponse`、`PlatformTransport`、`toPlatformError`。
- Produces: `TenantPortalClient` 接口与 `createTenantPortalClient({ tenantId, transport })`，方法签名见下方实现。`createHttpTransport({ baseUrl, fetchImpl? })`。后续 webui 全部经由 `TenantPortalClient` 访问数据。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-client/tests/client.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createTenantPortalClient } from "../src/client.js";
import { PlatformError } from "../src/errors.js";
import type { PlatformRequest, PlatformTransport } from "../src/transport.js";

function recordingTransport(data: unknown = {}) {
  const calls: PlatformRequest[] = [];
  const transport: PlatformTransport = async (request) => {
    calls.push(request);
    return { ok: true, data };
  };
  return { calls, transport };
}

describe("createTenantPortalClient", () => {
  it("listDocuments 拼出带 tenantId 的路径并透传筛选", async () => {
    const { calls, transport } = recordingTransport({ items: [], nextCursor: null });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.listDocuments({ documentType: "markdown", limit: 20 });

    expect(calls[0]).toEqual({
      method: "GET",
      path: "/api/v1/tenants/t1/documents",
      query: { documentType: "markdown", limit: 20, cursor: undefined },
    });
  });

  it("getThread 对路径段做 URL 编码", async () => {
    const { calls, transport } = recordingTransport({ threadId: "a/b", pings: [], pongs: [] });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.getThread("doc 1", "a/b");

    expect(calls[0].path).toBe("/api/v1/tenants/t1/documents/doc%201/threads/a%2Fb");
  });

  it("createThread 带上 idempotencyKey", async () => {
    const { calls, transport } = recordingTransport({ threadId: "th-1", pings: [], pongs: [] });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.createThread("doc-1", "key-1", {
      baseVersionIdx: 0,
      content: { text: "hi", richContent: null, attachments: [] },
      location: null,
    });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/api/v1/tenants/t1/documents/doc-1/threads");
    expect(calls[0].idempotencyKey).toBe("key-1");
  });

  it("appendPing 落在 thread 路径下", async () => {
    const { calls, transport } = recordingTransport({});
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.appendPing("doc-1", "th-1", "key-2", {
      baseVersionIdx: 1,
      content: { text: "more", richContent: null, attachments: [] },
      location: null,
    });

    expect(calls[0].path).toBe("/api/v1/tenants/t1/documents/doc-1/threads/th-1/pings");
    expect(calls[0].idempotencyKey).toBe("key-2");
  });

  it("transport 返回 ApiError 时抛 PlatformError", async () => {
    const transport: PlatformTransport = async () => ({
      ok: false,
      error: { error: { code: "not_found", message: "gone", requestId: "req-9" } },
    });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await expect(client.getDocument("doc-1")).rejects.toThrow(PlatformError);
    await expect(client.getDocument("doc-1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("13 个 operation 都可调用", async () => {
    const { transport } = recordingTransport({ items: [], nextCursor: null });
    const client = createTenantPortalClient({ tenantId: "t1", transport });
    const names = [
      "listPublicDocumentTypes", "getDocumentContract", "listDocuments", "createDocument",
      "getDocument", "listVersions", "getVersion", "moveCurrentVersion", "listThreads",
      "createThread", "getThread", "appendPing", "issueCasCapability",
    ] as const;

    for (const name of names) expect(typeof client[name]).toBe("function");
    expect(names).toHaveLength(13);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: FAIL — `Cannot find module '../src/client.js'`

- [ ] **Step 3: 写 client 实现**

`packages/tenant-portal-client/src/client.ts`：

```ts
/**
 * PlatformEndpointContracts 的 13 个 operation 变成可调用方法。
 * 路径模板来自 protocol-platform/src/platform.ts 顶部注释。
 */
import type {
  AppendPingRequest,
  CasCapabilityGrant,
  CreateDocumentRequest,
  CreateThreadRequest,
  DocumentContractIdx,
  DocumentContractRecord,
  DocumentId,
  DocumentRecord,
  DocumentType,
  ListDocumentsQuery,
  ListDocumentsResponse,
  ListPublicDocumentTypesResponse,
  ListThreadsQuery,
  ListThreadsResponse,
  ListVersionsResponse,
  MoveCurrentVersionRequest,
  PageQuery,
  PingRecord,
  TenantId,
  ThreadDetail,
  ThreadId,
  VersionIdx,
  VersionRecord,
} from "@unidocs/protocol-platform";
import { toPlatformError } from "./errors.js";
import type { PlatformRequest, PlatformTransport, QueryValue } from "./transport.js";

export interface TenantPortalClient {
  listPublicDocumentTypes(query?: PageQuery): Promise<ListPublicDocumentTypesResponse>;
  getDocumentContract(documentType: DocumentType, idx: DocumentContractIdx): Promise<DocumentContractRecord>;
  listDocuments(query?: ListDocumentsQuery): Promise<ListDocumentsResponse>;
  createDocument(body: CreateDocumentRequest): Promise<DocumentRecord>;
  getDocument(documentId: DocumentId): Promise<DocumentRecord>;
  listVersions(documentId: DocumentId, query?: PageQuery): Promise<ListVersionsResponse>;
  getVersion(documentId: DocumentId, versionIdx: VersionIdx): Promise<VersionRecord>;
  moveCurrentVersion(documentId: DocumentId, body: MoveCurrentVersionRequest): Promise<DocumentRecord>;
  listThreads(documentId: DocumentId, query?: ListThreadsQuery): Promise<ListThreadsResponse>;
  createThread(documentId: DocumentId, idempotencyKey: string, body: CreateThreadRequest): Promise<ThreadDetail>;
  getThread(documentId: DocumentId, threadId: ThreadId): Promise<ThreadDetail>;
  appendPing(
    documentId: DocumentId,
    threadId: ThreadId,
    idempotencyKey: string,
    body: AppendPingRequest,
  ): Promise<PingRecord>;
  issueCasCapability(): Promise<CasCapabilityGrant>;
}

export function createTenantPortalClient(options: {
  tenantId: TenantId;
  transport: PlatformTransport;
}): TenantPortalClient {
  const { tenantId, transport } = options;
  const base = `/api/v1/tenants/${encodeURIComponent(tenantId)}`;
  const seg = (value: string | number): string => encodeURIComponent(String(value));

  async function send<T>(request: PlatformRequest): Promise<T> {
    const response = await transport(request);
    if (!response.ok) throw toPlatformError(response.error);
    return response.data as T;
  }

  const get = <T>(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<T> =>
    send<T>(query === undefined ? { method: "GET", path } : { method: "GET", path, query });

  const post = <T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> =>
    send<T>(idempotencyKey === undefined
      ? { method: "POST", path, body }
      : { method: "POST", path, body, idempotencyKey });

  const doc = (documentId: DocumentId): string => `${base}/documents/${seg(documentId)}`;

  return {
    listPublicDocumentTypes: (query = {}) =>
      get(`${base}/document-types`, { cursor: query.cursor, limit: query.limit }),

    getDocumentContract: (documentType, idx) =>
      get(`${base}/document-types/${seg(documentType)}/contracts/${seg(idx)}`),

    listDocuments: (query = {}) =>
      get(`${base}/documents`, {
        documentType: query.documentType,
        cursor: query.cursor,
        limit: query.limit,
      }),

    createDocument: (body) => post(`${base}/documents`, body),
    getDocument: (documentId) => get(doc(documentId)),

    listVersions: (documentId, query = {}) =>
      get(`${doc(documentId)}/versions`, { cursor: query.cursor, limit: query.limit }),

    getVersion: (documentId, versionIdx) => get(`${doc(documentId)}/versions/${seg(versionIdx)}`),
    moveCurrentVersion: (documentId, body) => post(`${doc(documentId)}/current-version`, body),

    listThreads: (documentId, query = {}) =>
      get(`${doc(documentId)}/threads`, {
        open: query.open,
        versionIdx: query.versionIdx,
        cursor: query.cursor,
        limit: query.limit,
      }),

    createThread: (documentId, idempotencyKey, body) =>
      post(`${doc(documentId)}/threads`, body, idempotencyKey),

    getThread: (documentId, threadId) => get(`${doc(documentId)}/threads/${seg(threadId)}`),

    appendPing: (documentId, threadId, idempotencyKey, body) =>
      post(`${doc(documentId)}/threads/${seg(threadId)}/pings`, body, idempotencyKey),

    issueCasCapability: () => post(`${base}/cas-capabilities`, {}),
  };
}
```

`getDocumentContract` 的路径在 `platform.ts` 顶部注释里没有列出（注释只列了 13 条中的 12 条 URL）。按 `DocumentContractPath extends DocumentTypePath` 的形状推出 `document-types/{documentType}/contracts/{idx}`，真后端定稿时以服务端为准，此处集中在一行，改动成本为零。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: PASS，6 个测试。

- [ ] **Step 5: 写 HTTP transport 的失败测试**

`packages/tenant-portal-client/tests/http-transport.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createHttpTransport } from "../src/http-transport.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createHttpTransport", () => {
  it("把 query 里的 undefined 丢掉，其余序列化", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [] }));
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    await transport({
      method: "GET",
      path: "/api/v1/tenants/t1/documents",
      query: { documentType: "markdown", cursor: undefined, limit: 20 },
    });

    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://example.test/api/v1/tenants/t1/documents");
    expect(url.searchParams.get("documentType")).toBe("markdown");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("idempotencyKey 落到请求头", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    await transport({ method: "POST", path: "/p", body: { a: 1 }, idempotencyKey: "key-1" });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("idempotency-key")).toBe("key-1");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("非 2xx 且是 ApiError 形状时返回 ok:false", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: { code: "version_conflict", message: "moved", requestId: "req-1" } }),
    );
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    const result = await transport({ method: "GET", path: "/p" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("version_conflict");
  });

  it("非 2xx 且不是 ApiError 形状时合成一个，不抛裸异常", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const transport = createHttpTransport({ baseUrl: "https://example.test", fetchImpl });

    const result = await transport({ method: "GET", path: "/p" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("transport_failure");
      expect(result.error.error.requestId).toBe("");
    }
  });
});
```

最后一条防的是真实故障:网关返回 HTML 错误页时,调用方仍应看到一个带 `code` 的 `PlatformError`,而不是 JSON 解析异常。

- [ ] **Step 6: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: FAIL — `Cannot find module '../src/http-transport.js'`

- [ ] **Step 7: 写 HTTP transport 实现**

`packages/tenant-portal-client/src/http-transport.ts`：

```ts
/**
 * 真后端的 transport。本轮写出来并做单元测试，但尚无服务可连。
 */
import type { ApiError } from "@unidocs/protocol-platform";
import type { PlatformRequest, PlatformResponse, PlatformTransport } from "./transport.js";

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const shape = error as Record<string, unknown>;
  return typeof shape.code === "string"
    && typeof shape.message === "string"
    && typeof shape.requestId === "string";
}

function transportFailure(message: string): PlatformResponse {
  return {
    ok: false,
    error: { error: { code: "transport_failure", message, requestId: "" } },
  };
}

export function createHttpTransport(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): PlatformTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    const url = new URL(baseUrl + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({ accept: "application/json" });
    if (request.idempotencyKey !== undefined) {
      headers.set("idempotency-key", request.idempotencyKey);
    }
    if (request.body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: request.method,
        headers,
        credentials: "include",
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (cause) {
      return transportFailure(cause instanceof Error ? cause.message : "network error");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return response.ok
        ? transportFailure("response was not JSON")
        : transportFailure(`HTTP ${response.status}`);
    }

    if (response.ok) return { ok: true, data: payload };
    return isApiError(payload) ? { ok: false, error: payload } : transportFailure(`HTTP ${response.status}`);
  };
}
```

- [ ] **Step 8: 导出并运行全部测试**

`packages/tenant-portal-client/src/index.ts` 追加：

```ts
export { createTenantPortalClient } from "./client.js";
export type { TenantPortalClient } from "./client.js";
export { createHttpTransport } from "./http-transport.js";
```

Run: `pnpm --filter @unidocs/tenant-portal-client test && pnpm typecheck`
Expected: PASS，10 个测试。

- [ ] **Step 9: 提交**

```bash
git add packages/tenant-portal-client
git commit -m "feat(portal): add tenant portal client operations and http transport"
```

---

## Task 3: Markdown 的 snapshot 与 text-range location 形状

**Files:**
- Create: `packages/tenant-portal-client/src/doctypes/markdown.ts`
- Modify: `packages/tenant-portal-client/src/index.ts`
- Test: `packages/tenant-portal-client/tests/markdown-location.test.ts`

**Interfaces:**
- Consumes: `@unidocs/protocol-platform` 的 `DocumentLocation`。
- Produces: `MarkdownDocumentType`、`MarkdownTextRangeLocationType`、`MarkdownSnapshot`、`MarkdownTextRangePayload`、`createMarkdownTextRange()`、`readMarkdownTextRange()`、`resolveMarkdownTextRange()`。Task 5 的样本数据、Task 9 的 `MarkdownView.focusLocation`、Task 13 的右栏判定都用它。

**为什么放在 client 包:** `unidocs.markdown.text-range/v1` 这个 locationType 在设计文档里出现，但代码里还没有任何地方定义它——`DocumentLocation.locationType` 只是 `string`，由文档契约的 location schema 在运行时校验。假后端（client 内）与 `MarkdownView`（webui 内）都要用同一份形状，client 是两者的共同下游，所以放这里。这是**临时的家**，真正的归属是将来的 Markdown doctype 包；文件头要写明这一点。

**为什么 payload 里要带 `quote`:** spec §4.2 的第三、四种右栏渲染必须区分「这段内容还在」与「已被改写掉」。只有偏移量做不到——偏移量在别的版本上永远能算出一个位置，只是可能指向完全无关的文字。带上基版的原文才能验证。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-client/tests/markdown-location.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  createMarkdownTextRange,
  readMarkdownTextRange,
  resolveMarkdownTextRange,
} from "../src/doctypes/markdown.js";

const content = "# 标题\n\n这是第一段。\n\n这是第二段。\n";

describe("createMarkdownTextRange", () => {
  it("按偏移量截出 quote 并带上 documentContractIdx", () => {
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 8, end: 14 });

    expect(location.locationType).toBe("unidocs.markdown.text-range/v1");
    expect(location.documentContractIdx).toBe(0);
    expect(readMarkdownTextRange(location)).toEqual({ start: 8, end: 14, quote: "这是第一段。" });
  });

  it("start 大于 end 时抛错", () => {
    expect(() => createMarkdownTextRange({ documentContractIdx: 0, content, start: 5, end: 2 }))
      .toThrow(/invalid range/);
  });
});

describe("readMarkdownTextRange", () => {
  it("locationType 不匹配时返回 null", () => {
    const location = { documentContractIdx: 0, locationType: "unidocs.psd.layer-region/v2", payload: {} };
    expect(readMarkdownTextRange(location)).toBeNull();
  });

  it("payload 形状不对时返回 null，不抛错", () => {
    const location = {
      documentContractIdx: 0,
      locationType: "unidocs.markdown.text-range/v1",
      payload: { start: "8", end: 14, quote: "x" },
    };
    expect(readMarkdownTextRange(location)).toBeNull();
  });
});

describe("resolveMarkdownTextRange", () => {
  it("同一份内容上原位命中", () => {
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 8, end: 14 });
    expect(resolveMarkdownTextRange(location, content)).toEqual({ located: true, start: 8, end: 14, shifted: false });
  });

  it("内容前面被插入时按 quote 重新定位，并标记 shifted", () => {
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 8, end: 14 });
    const moved = "# 标题\n\n新插入的一段。\n\n这是第一段。\n\n这是第二段。\n";

    const result = resolveMarkdownTextRange(location, moved);

    expect(result.located).toBe(true);
    if (result.located) {
      expect(moved.slice(result.start, result.end)).toBe("这是第一段。");
      expect(result.shifted).toBe(true);
    }
  });

  it("quote 已被改写掉时定位失败", () => {
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 8, end: 14 });
    const rewritten = "# 标题\n\n完全换过的内容。\n\n这是第二段。\n";

    expect(resolveMarkdownTextRange(location, rewritten)).toEqual({ located: false, reason: "unresolvable" });
  });

  it("locationType 不认识时报 unsupported_type", () => {
    const location = { documentContractIdx: 0, locationType: "unidocs.psd.layer-region/v2", payload: {} };
    expect(resolveMarkdownTextRange(location, content)).toEqual({ located: false, reason: "unsupported_type" });
  });

  it("quote 在新内容里出现多次时取最接近原偏移的那个", () => {
    const repeated = "重复。\n\n重复。\n\n重复。\n";
    const location = createMarkdownTextRange({ documentContractIdx: 0, content: repeated, start: 5, end: 8 });

    const result = resolveMarkdownTextRange(location, repeated);

    expect(result).toEqual({ located: true, start: 5, end: 8, shifted: false });
  });
});
```

最后一条很重要：文档里重复出现的短语（「见上」「TODO」）如果总是命中第一处，评论会跳到错误的位置。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: FAIL — `Cannot find module '../src/doctypes/markdown.js'`

- [ ] **Step 3: 写实现**

`packages/tenant-portal-client/src/doctypes/markdown.ts`：

```ts
/**
 * Markdown 文档类型的 snapshot 与 location 形状。
 *
 * 临时的家：locationType `unidocs.markdown.text-range/v1` 在设计文档里已经出现，但
 * 代码里还没有归属包。假后端（本包）与 MarkdownView（tenant-portal-webui）都要用同
 * 一份形状，client 是两者的共同下游。将来 Markdown doctype 包落地后应迁走。
 */
import type { DocumentContractIdx, DocumentLocation } from "@unidocs/protocol-platform";

export const MarkdownDocumentType = "markdown";
export const MarkdownTextRangeLocationType = "unidocs.markdown.text-range/v1";

/** 与 doctype-markdown 的 MDoc 对齐：整篇内容就是一个字符串。 */
export interface MarkdownSnapshot {
  readonly content: string;
}

export interface MarkdownTextRangePayload {
  /** snapshot.content 上的 UTF-16 code unit 偏移，左闭右开。 */
  readonly start: number;
  readonly end: number;
  /** 基版上 [start, end) 处的原文，用于在别的版本上验证这段内容是否还在。 */
  readonly quote: string;
}

export type MarkdownRangeResolution =
  | { readonly located: true; readonly start: number; readonly end: number; readonly shifted: boolean }
  | { readonly located: false; readonly reason: "unsupported_type" | "unresolvable" };

export function createMarkdownTextRange(options: {
  documentContractIdx: DocumentContractIdx;
  content: string;
  start: number;
  end: number;
}): DocumentLocation {
  const { documentContractIdx, content, start, end } = options;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > content.length || start > end) {
    throw new RangeError(`invalid range [${start}, ${end}) for content of length ${content.length}`);
  }
  return {
    documentContractIdx,
    locationType: MarkdownTextRangeLocationType,
    payload: { start, end, quote: content.slice(start, end) },
  };
}

export function readMarkdownTextRange(location: DocumentLocation): MarkdownTextRangePayload | null {
  if (location.locationType !== MarkdownTextRangeLocationType) return null;
  const payload = location.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { start, end, quote } = payload as Record<string, unknown>;
  if (!Number.isInteger(start) || !Number.isInteger(end) || typeof quote !== "string") return null;
  return { start: start as number, end: end as number, quote };
}

export function resolveMarkdownTextRange(
  location: DocumentLocation,
  content: string,
): MarkdownRangeResolution {
  const range = readMarkdownTextRange(location);
  if (range === null) return { located: false, reason: "unsupported_type" };

  if (content.slice(range.start, range.start + range.quote.length) === range.quote) {
    return { located: true, start: range.start, end: range.start + range.quote.length, shifted: false };
  }
  if (range.quote.length === 0) return { located: false, reason: "unresolvable" };

  // quote 可能出现多次，取起点最接近原偏移的那一处。
  let best = -1;
  for (let at = content.indexOf(range.quote); at !== -1; at = content.indexOf(range.quote, at + 1)) {
    if (best === -1 || Math.abs(at - range.start) < Math.abs(best - range.start)) best = at;
  }
  if (best === -1) return { located: false, reason: "unresolvable" };
  return { located: true, start: best, end: best + range.quote.length, shifted: true };
}
```

`resolveMarkdownTextRange` 返回的 `reason` 取值刻意与 `ViewFocusLocationResponse.reason` 的 `"unsupported_type" | "unresolvable"` 对齐，Task 9 可以直接透传。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: PASS，新增 9 个测试。

- [ ] **Step 5: 导出并提交**

`packages/tenant-portal-client/src/index.ts` 追加：

```ts
export {
  createMarkdownTextRange,
  MarkdownDocumentType,
  MarkdownTextRangeLocationType,
  readMarkdownTextRange,
  resolveMarkdownTextRange,
} from "./doctypes/markdown.js";
export type {
  MarkdownRangeResolution,
  MarkdownSnapshot,
  MarkdownTextRangePayload,
} from "./doctypes/markdown.js";
```

```bash
git add packages/tenant-portal-client
git commit -m "feat(portal): define markdown snapshot and text-range location shapes"
```

---

## Task 4: 假后端的 store 与读操作

**Files:**
- Create: `packages/tenant-portal-client/src/memory/store.ts`
- Create: `packages/tenant-portal-client/src/memory/transport.ts`
- Test: `packages/tenant-portal-client/tests/memory-read.test.ts`

**Interfaces:**
- Consumes: Task 1 的 transport 类型、Task 3 的 markdown 形状。
- Produces:
  - `createMemoryStore(seed?: MemorySeed): MemoryStore`，带 `listDocuments` / `getDocument` / `listVersions` / `getVersion` / `listThreads` / `getThread` 读方法，以及 Task 5 用的写方法。
  - `MemorySeed`、`SeedDocument`、`SeedThread` 类型。
  - `createMemoryTransport({ store?, seed? }): PlatformTransport`。
  - `MemoryStore.state` 只读快照，供测试断言。

**路由:** 假后端要把 `PlatformRequest.path` 反解成 operation。用一张正则路由表，不要散在 if/else 里——Task 5 还要往同一张表上加写操作。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-client/tests/memory-read.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTenantPortalClient } from "../src/client.js";
import { createMemoryTransport } from "../src/memory/transport.js";
import { createMarkdownTextRange } from "../src/doctypes/markdown.js";
import { PlatformError } from "../src/errors.js";
import type { TenantPortalClient } from "../src/client.js";

const content = "# 样例\n\n第一段。\n\n第二段。\n";

function seeded() {
  return {
    documents: [
      {
        documentId: "doc-1",
        name: "样例文档",
        documentType: "markdown",
        versions: [{ content }, { content: content + "\n第三段。\n" }],
        threads: [
          {
            threadId: "th-1",
            pings: [{ baseVersionIdx: 0, text: "这里能展开吗", location: createMarkdownTextRange({ documentContractIdx: 0, content, start: 7, end: 11 }) }],
            pongs: [],
          },
        ],
      },
      { documentId: "doc-2", name: "空文档", documentType: "markdown", versions: [{ content: "# 空\n" }], threads: [] },
    ],
  };
}

describe("memory transport 读操作", () => {
  let client: TenantPortalClient;

  beforeEach(() => {
    client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: seeded() }) });
  });

  it("listDocuments 返回 Page 形状并带上 currentVersionIdx", async () => {
    const page = await client.listDocuments();

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ documentId: "doc-1", name: "样例文档", currentVersionIdx: 1 });
  });

  it("listDocuments 按 documentType 筛选", async () => {
    expect((await client.listDocuments({ documentType: "markdown" })).items).toHaveLength(2);
    expect((await client.listDocuments({ documentType: "psd" })).items).toHaveLength(0);
  });

  it("getVersion 返回 snapshot 与 parentVersionIdx", async () => {
    const version = await client.getVersion("doc-1", 1);

    expect(version.versionIdx).toBe(1);
    expect(version.parentVersionIdx).toBe(0);
    expect(version.snapshot).toMatchObject({ content: expect.stringContaining("第三段") });
  });

  it("首版的 parentVersionIdx 是 null", async () => {
    expect((await client.getVersion("doc-1", 0)).parentVersionIdx).toBeNull();
  });

  it("getThread 返回完整 ping 与 pong 序列", async () => {
    const thread = await client.getThread("doc-1", "th-1");

    expect(thread.threadId).toBe("th-1");
    expect(thread.pings).toHaveLength(1);
    expect(thread.pings[0]).toMatchObject({ pingIdx: 0, baseVersionIdx: 0 });
    expect(thread.pings[0].content.text).toBe("这里能展开吗");
    expect(thread.pongs).toHaveLength(0);
  });

  it("listThreads 只返回 threadId", async () => {
    const page = await client.listThreads("doc-1");
    expect(page.items).toEqual([{ threadId: "th-1" }]);
  });

  it("不存在的文档返回 not_found", async () => {
    await expect(client.getDocument("nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(client.getDocument("nope")).rejects.toBeInstanceOf(PlatformError);
  });

  it("不存在的版本返回 not_found", async () => {
    await expect(client.getVersion("doc-1", 99)).rejects.toMatchObject({ code: "not_found" });
  });

  it("未知路径返回 not_found 而不是抛异常", async () => {
    const transport = createMemoryTransport({ seed: seeded() });
    const result = await transport({ method: "GET", path: "/api/v1/tenants/t1/nonsense" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("not_found");
  });

  it("每个错误都带非空 requestId", async () => {
    const transport = createMemoryTransport({ seed: seeded() });
    const result = await transport({ method: "GET", path: "/api/v1/tenants/t1/documents/nope" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.requestId).not.toBe("");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: FAIL — `Cannot find module '../src/memory/transport.js'`

- [ ] **Step 3: 写 store**

`packages/tenant-portal-client/src/memory/store.ts`：

```ts
/**
 * 假后端的内存数据。它实现的是 contract，不是 UI 的 mock——webui 不该知道它存在。
 */
import type {
  DocumentId,
  DocumentLocation,
  DocumentRecord,
  DocumentType,
  PingRecord,
  PongRecord,
  ThreadDetail,
  ThreadId,
  VersionIdx,
  VersionRecord,
} from "@unidocs/protocol-platform";
import { MarkdownDocumentType } from "../doctypes/markdown.js";

export interface SeedPing {
  readonly baseVersionIdx: VersionIdx;
  readonly text: string;
  readonly location: DocumentLocation | null;
  readonly authorId?: string;
}

export interface SeedPong {
  readonly respondThroughPingIdx: number;
  readonly text: string;
  /** 相对于该 pong 产生的新版本。空数组表示纯 pong（只回复，不产生新版本）。 */
  readonly resultLocations?: readonly DocumentLocation[];
  /** 该 pong 产生的新版本内容；省略表示纯 pong。 */
  readonly producesContent?: string;
}

export interface SeedThread {
  readonly threadId: ThreadId;
  readonly pings: readonly SeedPing[];
  readonly pongs: readonly SeedPong[];
}

export interface SeedDocument {
  readonly documentId: DocumentId;
  readonly name: string;
  readonly documentType?: DocumentType;
  readonly versions: readonly { readonly content: string }[];
  readonly threads: readonly SeedThread[];
}

export interface MemorySeed {
  readonly documents: readonly SeedDocument[];
}

interface DocumentState {
  documentId: DocumentId;
  name: string;
  documentType: DocumentType;
  createdAt: string;
  currentVersionIdx: VersionIdx | null;
  versions: VersionRecord[];
  threads: Map<ThreadId, { pings: PingRecord[]; pongs: PongRecord[] }>;
}

export interface IdempotencyReceipt {
  readonly bodyFingerprint: string;
  readonly response: unknown;
}

export interface MemoryStoreState {
  readonly documents: ReadonlyMap<DocumentId, DocumentState>;
  readonly receipts: ReadonlyMap<string, IdempotencyReceipt>;
}

const EPOCH = Date.parse("2026-09-01T00:00:00.000Z");

/** 确定性时间戳：测试不依赖 wall clock。 */
function stamp(tick: number): string {
  return new Date(EPOCH + tick * 60_000).toISOString();
}

export class MemoryStore {
  readonly documents = new Map<DocumentId, DocumentState>();
  readonly receipts = new Map<string, IdempotencyReceipt>();
  private tick = 0;

  constructor(seed: MemorySeed = { documents: [] }) {
    for (const doc of seed.documents) this.loadDocument(doc);
  }

  nextStamp(): string {
    return stamp(this.tick++);
  }

  get state(): MemoryStoreState {
    return { documents: this.documents, receipts: this.receipts };
  }

  private loadDocument(seed: SeedDocument): void {
    const state: DocumentState = {
      documentId: seed.documentId,
      name: seed.name,
      documentType: seed.documentType ?? MarkdownDocumentType,
      createdAt: this.nextStamp(),
      currentVersionIdx: null,
      versions: [],
      threads: new Map(),
    };
    this.documents.set(seed.documentId, state);

    for (const version of seed.versions) this.appendVersion(state, version.content, "agent:seed");

    for (const thread of seed.threads) {
      const record = { pings: [] as PingRecord[], pongs: [] as PongRecord[] };
      state.threads.set(thread.threadId, record);

      for (const ping of thread.pings) {
        record.pings.push({
          pingIdx: record.pings.length,
          baseVersionIdx: ping.baseVersionIdx,
          content: { text: ping.text, richContent: null, attachments: [] },
          location: ping.location,
          authorId: ping.authorId ?? "user:sample",
          createdAt: this.nextStamp(),
        });
      }

      for (const pong of thread.pongs) {
        if (pong.producesContent !== undefined) {
          this.appendVersion(state, pong.producesContent, "agent:sample");
        }
        record.pongs.push({
          pongIdx: record.pongs.length,
          respondThroughPingIdx: pong.respondThroughPingIdx,
          content: { text: pong.text, richContent: null, attachments: [] },
          resultLocations: pong.resultLocations ?? [],
          authorAgentId: "agent:sample",
          submissionId: `sub-${state.documentId}-${thread.threadId}-${record.pongs.length}`,
          createdAt: this.nextStamp(),
        });
      }
    }
  }

  appendVersion(state: DocumentState, content: string, authorAgentId: string): VersionRecord {
    const version: VersionRecord = {
      versionIdx: state.versions.length,
      parentVersionIdx: state.versions.length === 0 ? null : state.versions.length - 1,
      documentContractIdx: 0,
      snapshot: { content } as VersionRecord["snapshot"],
      authorAgentId,
      createdAt: this.nextStamp(),
    };
    state.versions.push(version);
    state.currentVersionIdx = version.versionIdx;
    return version;
  }

  requireDocument(documentId: DocumentId): DocumentState {
    const state = this.documents.get(documentId);
    if (state === undefined) throw new NotFound(`document ${documentId}`);
    return state;
  }

  toRecord(state: DocumentState): DocumentRecord {
    return {
      documentId: state.documentId,
      name: state.name,
      documentType: state.documentType,
      currentVersionIdx: state.currentVersionIdx,
      createdAt: state.createdAt,
    };
  }

  listDocuments(documentType?: DocumentType): readonly DocumentRecord[] {
    return [...this.documents.values()]
      .filter((state) => documentType === undefined || state.documentType === documentType)
      .map((state) => this.toRecord(state));
  }

  getVersion(documentId: DocumentId, versionIdx: VersionIdx): VersionRecord {
    const version = this.requireDocument(documentId).versions[versionIdx];
    if (version === undefined) throw new NotFound(`version ${versionIdx}`);
    return version;
  }

  listVersions(documentId: DocumentId): readonly VersionRecord[] {
    return this.requireDocument(documentId).versions;
  }

  getThread(documentId: DocumentId, threadId: ThreadId): ThreadDetail {
    const record = this.requireDocument(documentId).threads.get(threadId);
    if (record === undefined) throw new NotFound(`thread ${threadId}`);
    return { threadId, pings: record.pings, pongs: record.pongs };
  }

  listThreadIds(documentId: DocumentId, open?: boolean): readonly ThreadId[] {
    const state = this.requireDocument(documentId);
    return [...state.threads.entries()]
      .filter(([, record]) => open === undefined || isOpen(record) === open)
      .map(([threadId]) => threadId);
  }
}

export function isOpen(record: { pings: readonly PingRecord[]; pongs: readonly PongRecord[] }): boolean {
  const acknowledged = record.pongs.reduce((max, pong) => Math.max(max, pong.respondThroughPingIdx), -1);
  const latest = record.pings.reduce((max, ping) => Math.max(max, ping.pingIdx), -1);
  return latest > acknowledged;
}

export class NotFound extends Error {}
export class InvalidRequest extends Error {}
export class Conflict extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function createMemoryStore(seed?: MemorySeed): MemoryStore {
  return new MemoryStore(seed);
}
```

`isOpen` 在这里和 webui 的 `thread-state.ts`（Task 10）会各有一份。这不是重复——假后端是服务端角色，它按自己的数据算 `open` 用于 `listThreads?open=` 筛选；webui 按拿到的 `ThreadDetail` 算，用于渲染。两者恰好同公式，但不共享实现，正如真后端不会 import 前端代码。

- [ ] **Step 4: 写读路由**

`packages/tenant-portal-client/src/memory/transport.ts`：

```ts
/**
 * 把 PlatformRequest 路由到 MemoryStore。它扮演服务器，所以必须按路径反解 operation。
 */
import type { ApiError } from "@unidocs/protocol-platform";
import type { PlatformRequest, PlatformResponse, PlatformTransport } from "../transport.js";
import {
  Conflict,
  InvalidRequest,
  MemoryStore,
  MemorySeed,
  NotFound,
  createMemoryStore,
} from "./store.js";

type Handler = (store: MemoryStore, request: PlatformRequest, params: readonly string[]) => unknown;

interface Route {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly handle: Handler;
}

const TENANT = String.raw`/api/v1/tenants/[^/]+`;
const page = <T>(items: readonly T[]) => ({ items, nextCursor: null });

const readRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents$`),
    handle: (store, request) => {
      const documentType = request.query?.documentType;
      return page(store.listDocuments(documentType === undefined ? undefined : String(documentType)));
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)$`),
    handle: (store, _request, [documentId]) => store.toRecord(store.requireDocument(documentId)),
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/versions$`),
    handle: (store, _request, [documentId]) => page(store.listVersions(documentId)),
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/versions/(\\d+)$`),
    handle: (store, _request, [documentId, versionIdx]) => store.getVersion(documentId, Number(versionIdx)),
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/threads$`),
    handle: (store, request, [documentId]) => {
      const open = request.query?.open;
      const ids = store.listThreadIds(documentId, open === undefined ? undefined : open === true || open === "true");
      return page(ids.map((threadId) => ({ threadId })));
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/threads/([^/]+)$`),
    handle: (store, _request, [documentId, threadId]) => store.getThread(documentId, threadId),
  },
];

/** Task 5 会在这里追加写路由。 */
export const memoryRoutes: Route[] = [...readRoutes];

let requestCounter = 0;

function apiError(code: string, message: string): ApiError {
  requestCounter += 1;
  return { error: { code, message, requestId: `mem-${requestCounter}` } };
}

export function createMemoryTransport(options: {
  store?: MemoryStore;
  seed?: MemorySeed;
} = {}): PlatformTransport {
  const store = options.store ?? createMemoryStore(options.seed);

  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    for (const route of memoryRoutes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(request.path);
      if (match === null) continue;

      const params = match.slice(1).map((value) => decodeURIComponent(value));
      try {
        return { ok: true, data: route.handle(store, request, params) };
      } catch (cause) {
        if (cause instanceof NotFound) return { ok: false, error: apiError("not_found", cause.message) };
        if (cause instanceof InvalidRequest) return { ok: false, error: apiError("invalid_request", cause.message) };
        if (cause instanceof Conflict) return { ok: false, error: apiError(cause.code, cause.message) };
        throw cause;
      }
    }
    return { ok: false, error: apiError("not_found", `no route for ${request.method} ${request.path}`) };
  };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: PASS，新增 10 个测试。

- [ ] **Step 6: 提交**

```bash
git add packages/tenant-portal-client
git commit -m "feat(portal): add in-memory platform store and read routes"
```

---

## Task 5: 假后端的写操作、幂等与冲突

**Files:**
- Modify: `packages/tenant-portal-client/src/memory/store.ts`
- Modify: `packages/tenant-portal-client/src/memory/transport.ts`
- Test: `packages/tenant-portal-client/tests/memory-write.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `MemoryStore`、`memoryRoutes`、`Conflict`、`InvalidRequest`。
- Produces: `MemoryStore.createDocument` / `createThread` / `appendPing` / `moveCurrentVersion` / `withIdempotency`。写路由挂进 `memoryRoutes`。

**幂等语义**（与 admin 面 `document-types-repository.ts` 已上线的行为一致）：同 key 同内容重放原结果；同 key 不同内容返回 `idempotency_conflict`。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-client/tests/memory-write.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTenantPortalClient } from "../src/client.js";
import type { TenantPortalClient } from "../src/client.js";
import { createMemoryStore } from "../src/memory/store.js";
import { createMemoryTransport } from "../src/memory/transport.js";
import type { MemoryStore } from "../src/memory/store.js";

const text = (value: string) => ({ text: value, richContent: null, attachments: [] });

function fixture() {
  const store = createMemoryStore({
    documents: [
      {
        documentId: "doc-1",
        name: "样例",
        versions: [{ content: "# 一\n" }, { content: "# 一\n\n二\n" }],
        threads: [],
      },
    ],
  });
  return { store, client: createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ store }) }) };
}

describe("memory transport 写操作", () => {
  let client: TenantPortalClient;
  let store: MemoryStore;

  beforeEach(() => {
    ({ client, store } = fixture());
  });

  it("createThread 建出带第一条 ping 的 thread", async () => {
    const thread = await client.createThread("doc-1", "key-1", {
      baseVersionIdx: 1,
      content: text("第一条"),
      location: null,
    });

    expect(thread.pings).toHaveLength(1);
    expect(thread.pings[0]).toMatchObject({ pingIdx: 0, baseVersionIdx: 1 });
    expect(thread.pongs).toHaveLength(0);
    expect(store.listThreadIds("doc-1")).toEqual([thread.threadId]);
  });

  it("appendPing 递增 pingIdx", async () => {
    const thread = await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });
    const ping = await client.appendPing("doc-1", thread.threadId, "key-2", {
      baseVersionIdx: 1,
      content: text("二"),
      location: null,
    });

    expect(ping.pingIdx).toBe(1);
    expect((await client.getThread("doc-1", thread.threadId)).pings).toHaveLength(2);
  });

  it("同 key 同内容重放原结果，不产生第二条", async () => {
    const body = { baseVersionIdx: 1, content: text("一"), location: null };
    const first = await client.createThread("doc-1", "key-1", body);
    const second = await client.createThread("doc-1", "key-1", body);

    expect(second.threadId).toBe(first.threadId);
    expect(store.listThreadIds("doc-1")).toHaveLength(1);
  });

  it("同 key 不同内容返回 idempotency_conflict", async () => {
    await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });

    await expect(
      client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("换了"), location: null }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("appendPing 的幂等与 createThread 不串号", async () => {
    const thread = await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });
    const body = { baseVersionIdx: 1, content: text("二"), location: null };

    const first = await client.appendPing("doc-1", thread.threadId, "key-2", body);
    const second = await client.appendPing("doc-1", thread.threadId, "key-2", body);

    expect(second.pingIdx).toBe(first.pingIdx);
    expect((await client.getThread("doc-1", thread.threadId)).pings).toHaveLength(2);
  });

  it("baseVersionIdx 指向不存在的版本时 invalid_request", async () => {
    await expect(
      client.createThread("doc-1", "key-1", { baseVersionIdx: 99, content: text("一"), location: null }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("moveCurrentVersion 在观测值匹配时移动指针", async () => {
    const record = await client.moveCurrentVersion("doc-1", {
      observedCurrentVersionIdx: 1,
      targetVersionIdx: 0,
      reason: "回看旧版",
    });

    expect(record.currentVersionIdx).toBe(0);
  });

  it("moveCurrentVersion 在观测值过期时 version_conflict 且不改动指针", async () => {
    await expect(
      client.moveCurrentVersion("doc-1", { observedCurrentVersionIdx: 0, targetVersionIdx: 0, reason: "x" }),
    ).rejects.toMatchObject({ code: "version_conflict" });

    expect((await client.getDocument("doc-1")).currentVersionIdx).toBe(1);
  });

  it("createDocument 建出没有版本的文档，currentVersionIdx 为 null", async () => {
    const record = await client.createDocument({ documentType: "markdown", name: "新作品" });

    expect(record.currentVersionIdx).toBeNull();
    expect(record.name).toBe("新作品");
  });
});
```

倒数第二条锁的是乐观锁必须**不留下副作用**——冲突时指针不能已经动了一半。最后一条锁的是 spec §7 里 `currentVersionIdx === null` 的空态确有数据来源。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: FAIL — `client.createThread is not a route`（`not_found`），或断言失败。

- [ ] **Step 3: 往 store 加写方法**

在 `packages/tenant-portal-client/src/memory/store.ts` 的 `MemoryStore` 类内追加：

```ts
  /** 同 key 同内容重放原结果；同 key 不同内容 409。 */
  withIdempotency<T>(scope: string, key: string | undefined, body: unknown, run: () => T): T {
    if (key === undefined) return run();

    const receiptKey = `${scope}:${key}`;
    const fingerprint = JSON.stringify(body ?? null);
    const existing = this.receipts.get(receiptKey);
    if (existing !== undefined) {
      if (existing.bodyFingerprint !== fingerprint) {
        throw new Conflict("idempotency_conflict", `idempotency key ${key} reused with a different body`);
      }
      return existing.response as T;
    }

    const response = run();
    this.receipts.set(receiptKey, { bodyFingerprint: fingerprint, response });
    return response;
  }

  createDocument(name: string, documentType: DocumentType): DocumentRecord {
    if (name.trim() === "") throw new InvalidRequest("name must not be empty");
    const documentId = `doc-${this.documents.size + 1}-${name.length}`;
    const state: DocumentState = {
      documentId,
      name,
      documentType,
      createdAt: this.nextStamp(),
      currentVersionIdx: null,
      versions: [],
      threads: new Map(),
    };
    this.documents.set(documentId, state);
    return this.toRecord(state);
  }

  private requireVersion(state: DocumentState, versionIdx: VersionIdx): void {
    if (state.versions[versionIdx] === undefined) {
      throw new InvalidRequest(`baseVersionIdx ${versionIdx} does not exist`);
    }
  }

  createThread(
    documentId: DocumentId,
    body: { baseVersionIdx: VersionIdx; content: PingRecord["content"]; location: DocumentLocation | null },
  ): ThreadDetail {
    const state = this.requireDocument(documentId);
    this.requireVersion(state, body.baseVersionIdx);

    const threadId = `th-${state.threads.size + 1}`;
    const ping: PingRecord = {
      pingIdx: 0,
      baseVersionIdx: body.baseVersionIdx,
      content: body.content,
      location: body.location,
      authorId: "user:sample",
      createdAt: this.nextStamp(),
    };
    state.threads.set(threadId, { pings: [ping], pongs: [] });
    return { threadId, pings: [ping], pongs: [] };
  }

  appendPing(
    documentId: DocumentId,
    threadId: ThreadId,
    body: { baseVersionIdx: VersionIdx; content: PingRecord["content"]; location: DocumentLocation | null },
  ): PingRecord {
    const state = this.requireDocument(documentId);
    this.requireVersion(state, body.baseVersionIdx);

    const record = state.threads.get(threadId);
    if (record === undefined) throw new NotFound(`thread ${threadId}`);

    const ping: PingRecord = {
      pingIdx: record.pings.length,
      baseVersionIdx: body.baseVersionIdx,
      content: body.content,
      location: body.location,
      authorId: "user:sample",
      createdAt: this.nextStamp(),
    };
    record.pings.push(ping);
    return ping;
  }

  moveCurrentVersion(
    documentId: DocumentId,
    body: { observedCurrentVersionIdx: VersionIdx | null; targetVersionIdx: VersionIdx },
  ): DocumentRecord {
    const state = this.requireDocument(documentId);
    if (state.currentVersionIdx !== body.observedCurrentVersionIdx) {
      throw new Conflict(
        "version_conflict",
        `current version is ${state.currentVersionIdx}, not ${body.observedCurrentVersionIdx}`,
      );
    }
    if (state.versions[body.targetVersionIdx] === undefined) {
      throw new InvalidRequest(`target version ${body.targetVersionIdx} does not exist`);
    }
    state.currentVersionIdx = body.targetVersionIdx;
    return this.toRecord(state);
  }
```

检查顺序要紧：`moveCurrentVersion` 先比对观测值再校验目标版本，所以冲突分支一定在任何写入之前返回。

- [ ] **Step 4: 挂写路由**

在 `packages/tenant-portal-client/src/memory/transport.ts` 里，把 `memoryRoutes` 的定义替换为：

```ts
const writeRoutes: readonly Route[] = [
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/documents$`),
    handle: (store, request) => {
      const body = request.body as { documentType?: unknown; name?: unknown };
      if (typeof body?.name !== "string" || typeof body?.documentType !== "string") {
        throw new InvalidRequest("documentType and name are required");
      }
      return store.withIdempotency("createDocument", request.idempotencyKey, request.body, () =>
        store.createDocument(body.name as string, body.documentType as string));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/threads$`),
    handle: (store, request, [documentId]) =>
      store.withIdempotency(`createThread:${documentId}`, request.idempotencyKey, request.body, () =>
        store.createThread(documentId, request.body as Parameters<MemoryStore["createThread"]>[1])),
  },
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/threads/([^/]+)/pings$`),
    handle: (store, request, [documentId, threadId]) =>
      store.withIdempotency(`appendPing:${documentId}:${threadId}`, request.idempotencyKey, request.body, () =>
        store.appendPing(documentId, threadId, request.body as Parameters<MemoryStore["appendPing"]>[2])),
  },
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/documents/([^/]+)/current-version$`),
    handle: (store, request, [documentId]) =>
      store.moveCurrentVersion(documentId, request.body as Parameters<MemoryStore["moveCurrentVersion"]>[1]),
  },
  {
    method: "POST",
    pattern: new RegExp(`^${TENANT}/cas-capabilities$`),
    handle: () => {
      throw new NotFound("cas capabilities are not available against the memory backend");
    },
  },
];

export const memoryRoutes: Route[] = [...readRoutes, ...writeRoutes];
```

幂等的 scope 带上 `documentId` / `threadId`，所以不同 thread 复用同一个 key 不会互相命中对方的 receipt。`moveCurrentVersion` 不走幂等——它自带 `observedCurrentVersionIdx` 这个等值锁，重放天然安全。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @unidocs/tenant-portal-client test && pnpm typecheck`
Expected: PASS，新增 9 个测试。

- [ ] **Step 6: 提交**

```bash
git add packages/tenant-portal-client
git commit -m "feat(portal): add memory backend writes with idempotency and version locks"
```

---

## Task 6: 脚本化 Agent 与样本数据

**Files:**
- Create: `packages/tenant-portal-client/src/memory/agent.ts`
- Create: `packages/tenant-portal-client/src/memory/seed.ts`
- Modify: `packages/tenant-portal-client/src/memory/transport.ts`
- Modify: `packages/tenant-portal-client/src/index.ts`
- Test: `packages/tenant-portal-client/tests/memory-agent.test.ts`
- Test: `packages/tenant-portal-client/tests/memory-seed.test.ts`

**Interfaces:**
- Consumes: Task 4/5 的 `MemoryStore`、Task 3 的 markdown 形状。
- Produces:
  - `createScriptedAgent({ store, respond }): ScriptedAgent`，带 `runPending(): number` 与 `pendingCount(): number`。
  - `rangeOf(content, quote)` 辅助（按原文查偏移，seed 里不写死数字）。
  - `sampleSeed(): MemorySeed`，六种情形各一处。
  - `createMemoryTransport` 新增 `agent?: { autoRun?: boolean }` 选项。
- **同步驱动**：Agent 不用 `setTimeout`。测试调 `runPending()` 明确推进，不依赖 wall clock（spec §8）。webui 开发时由 `autoRun` 在每次写请求后自动跑一轮。

- [ ] **Step 1: 写 Agent 的失败测试**

`packages/tenant-portal-client/tests/memory-agent.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createMemoryStore, isOpen } from "../src/memory/store.js";
import { createScriptedAgent } from "../src/memory/agent.js";

function store() {
  return createMemoryStore({
    documents: [{ documentId: "doc-1", name: "样例", versions: [{ content: "# 一\n" }], threads: [] }],
  });
}

describe("createScriptedAgent", () => {
  it("没有待处理 ping 时 runPending 返回 0", () => {
    const agent = createScriptedAgent({ store: store() });
    expect(agent.pendingCount()).toBe(0);
    expect(agent.runPending()).toBe(0);
  });

  it("处理一条待回复的 ping，产生 pong 并把水位推到该 ping", () => {
    const s = store();
    const thread = s.createThread("doc-1", {
      baseVersionIdx: 0,
      content: { text: "改一下", richContent: null, attachments: [] },
      location: null,
    });
    const agent = createScriptedAgent({ store: s });

    expect(agent.pendingCount()).toBe(1);
    expect(agent.runPending()).toBe(1);

    const detail = s.getThread("doc-1", thread.threadId);
    expect(detail.pongs).toHaveLength(1);
    expect(detail.pongs[0].respondThroughPingIdx).toBe(0);
    expect(isOpen(detail)).toBe(false);
  });

  it("一条 pong 累计确认同一处的多条待回复 ping", () => {
    const s = store();
    const thread = s.createThread("doc-1", {
      baseVersionIdx: 0, content: { text: "一", richContent: null, attachments: [] }, location: null,
    });
    s.appendPing("doc-1", thread.threadId, {
      baseVersionIdx: 0, content: { text: "二", richContent: null, attachments: [] }, location: null,
    });
    const agent = createScriptedAgent({ store: s });

    agent.runPending();

    const detail = s.getThread("doc-1", thread.threadId);
    expect(detail.pongs).toHaveLength(1);
    expect(detail.pongs[0].respondThroughPingIdx).toBe(1);
  });

  it("respond 返回 producesContent 时追加新版本并推进 current", () => {
    const s = store();
    s.createThread("doc-1", {
      baseVersionIdx: 0, content: { text: "加一段", richContent: null, attachments: [] }, location: null,
    });
    const agent = createScriptedAgent({ store: s, respond: () => ({ text: "已加", producesContent: "# 一\n\n新段。\n" }) });

    agent.runPending();

    expect(s.requireDocument("doc-1").currentVersionIdx).toBe(1);
    expect(s.getVersion("doc-1", 1).authorAgentId).toBe("agent:scripted");
  });

  it("respond 不返回 producesContent 时是纯 pong，不产生新版本", () => {
    const s = store();
    s.createThread("doc-1", {
      baseVersionIdx: 0, content: { text: "问一下", richContent: null, attachments: [] }, location: null,
    });
    const agent = createScriptedAgent({ store: s, respond: () => ({ text: "解释一下：……" }) });

    agent.runPending();

    expect(s.requireDocument("doc-1").currentVersionIdx).toBe(0);
    const detail = s.getThread("doc-1", s.listThreadIds("doc-1")[0]);
    expect(detail.pongs[0].resultLocations).toEqual([]);
  });

  it("追加新 ping 后该处重新变成待处理", () => {
    const s = store();
    const thread = s.createThread("doc-1", {
      baseVersionIdx: 0, content: { text: "一", richContent: null, attachments: [] }, location: null,
    });
    const agent = createScriptedAgent({ store: s });
    agent.runPending();
    expect(agent.pendingCount()).toBe(0);

    s.appendPing("doc-1", thread.threadId, {
      baseVersionIdx: 0, content: { text: "二", richContent: null, attachments: [] }, location: null,
    });

    expect(agent.pendingCount()).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-client test`
Expected: FAIL — `Cannot find module '../src/memory/agent.js'`

- [ ] **Step 3: 写 Agent 实现**

`packages/tenant-portal-client/src/memory/agent.ts`：

```ts
/**
 * 假后端里的 Agent。协议上 Agent 通过原子 submission 工作；这里只模拟用户可见的
 * 结果——ping 写入后产出一条 pong，把水位推到当前最新 ping，可选地产生新版本。
 *
 * 同步驱动：不用定时器，测试调 runPending() 明确推进。
 */
import type { DocumentLocation, PongRecord } from "@unidocs/protocol-platform";
import type { MemoryStore } from "./store.js";
import { isOpen } from "./store.js";

export interface AgentReply {
  readonly text: string;
  /** 省略则为纯 pong：只回复，不产生新版本。 */
  readonly producesContent?: string;
  /** 相对于新版本的位置；纯 pong 应为空。 */
  readonly resultLocations?: readonly DocumentLocation[];
}

export interface AgentContext {
  readonly documentId: string;
  readonly threadId: string;
  readonly latestPingIdx: number;
  readonly latestPingText: string | null;
}

export interface ScriptedAgent {
  pendingCount(): number;
  /** 处理所有待回复的一处，返回处理了几处。 */
  runPending(): number;
}

const defaultRespond = (context: AgentContext): AgentReply => ({
  text: `已处理到第 ${context.latestPingIdx + 1} 条评论。`,
});

export function createScriptedAgent(options: {
  store: MemoryStore;
  respond?: (context: AgentContext) => AgentReply;
}): ScriptedAgent {
  const { store } = options;
  const respond = options.respond ?? defaultRespond;

  function pending(): { documentId: string; threadId: string }[] {
    const result: { documentId: string; threadId: string }[] = [];
    for (const [documentId, state] of store.documents) {
      for (const [threadId, record] of state.threads) {
        if (isOpen(record)) result.push({ documentId, threadId });
      }
    }
    return result;
  }

  return {
    pendingCount: () => pending().length,

    runPending: () => {
      const work = pending();
      for (const { documentId, threadId } of work) {
        const state = store.requireDocument(documentId);
        const record = state.threads.get(threadId);
        if (record === undefined) continue;

        const latest = record.pings[record.pings.length - 1];
        const reply = respond({
          documentId,
          threadId,
          latestPingIdx: latest.pingIdx,
          latestPingText: latest.content.text,
        });

        if (reply.producesContent !== undefined) {
          store.appendVersion(state, reply.producesContent, "agent:scripted");
        }

        const pong: PongRecord = {
          pongIdx: record.pongs.length,
          respondThroughPingIdx: latest.pingIdx,
          content: { text: reply.text, richContent: null, attachments: [] },
          resultLocations: reply.resultLocations ?? [],
          authorAgentId: "agent:scripted",
          submissionId: `sub-${documentId}-${threadId}-${record.pongs.length}`,
          createdAt: store.nextStamp(),
        };
        record.pongs.push(pong);
      }
      return work.length;
    },
  };
}
```

- [ ] **Step 4: 写样本数据的失败测试**

`packages/tenant-portal-client/tests/memory-seed.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createTenantPortalClient } from "../src/client.js";
import { createMemoryTransport } from "../src/memory/transport.js";
import { rangeOf, sampleSeed } from "../src/memory/seed.js";
import { resolveMarkdownTextRange } from "../src/doctypes/markdown.js";
import type { MarkdownSnapshot } from "../src/doctypes/markdown.js";

function client() {
  return createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
}

describe("rangeOf", () => {
  it("按原文查出偏移", () => {
    expect(rangeOf("abc 目标 def", "目标")).toEqual({ start: 4, end: 6 });
  });

  it("查不到时抛错，避免样本数据静默错位", () => {
    expect(() => rangeOf("abc", "不存在")).toThrow(/not found/);
  });
});

describe("sampleSeed", () => {
  it("样本文档有多个版本与多处讨论", async () => {
    const api = client();
    const documents = await api.listDocuments();
    const main = documents.items.find((d) => d.documentId === "doc-sample");

    expect(main).toBeDefined();
    expect(main?.currentVersionIdx).not.toBeNull();
    expect((await api.listThreads("doc-sample")).items.length).toBeGreaterThanOrEqual(6);
  });

  it("覆盖六种情形：待回复 / 已回复产新版 / 基于旧版内容仍在 / 基于旧版已改写 / 纯 pong / 基于 current", async () => {
    const api = client();
    const current = (await api.getDocument("doc-sample")).currentVersionIdx as number;
    const snapshot = (await api.getVersion("doc-sample", current)).snapshot as unknown as MarkdownSnapshot;

    const detail = async (id: string) => api.getThread("doc-sample", id);
    const ack = (pongs: readonly { respondThroughPingIdx: number }[]) =>
      pongs.reduce((max, p) => Math.max(max, p.respondThroughPingIdx), -1);

    const open = await detail("th-open");
    expect(open.pongs).toHaveLength(0);

    const answered = await detail("th-answered");
    expect(ack(answered.pongs)).toBe(answered.pings[answered.pings.length - 1].pingIdx);
    expect(answered.pongs[0].resultLocations.length).toBeGreaterThan(0);

    const stale = await detail("th-stale-present");
    expect(stale.pings[0].baseVersionIdx).toBeLessThan(current);
    expect(resolveMarkdownTextRange(stale.pings[0].location!, snapshot.content).located).toBe(true);

    const rewritten = await detail("th-stale-rewritten");
    expect(resolveMarkdownTextRange(rewritten.pings[0].location!, snapshot.content)).toEqual({
      located: false,
      reason: "unresolvable",
    });

    const plain = await detail("th-plain-pong");
    expect(plain.pongs[0].resultLocations).toEqual([]);

    const onCurrent = await detail("th-on-current");
    expect(onCurrent.pings[0].baseVersionIdx).toBe(current);
  });

  it("还有一件空文档，供空态使用", async () => {
    const api = client();
    expect((await api.listThreads("doc-empty")).items).toEqual([]);
  });
});
```

第二条测试是整个假后端的验收核心——Task 13 的右栏四种情况要靠这六处驱动，样本数据错位会让那些 UI 测试假通过。

- [ ] **Step 5: 写样本数据**

`packages/tenant-portal-client/src/memory/seed.ts`：

```ts
/**
 * 样本数据。六处讨论对应 spec §4.2 的右栏四种渲染，外加纯 pong 与基于 current 两种。
 * 偏移一律由 rangeOf 按原文查出，不写死数字——写死会在内容改动后静默错位。
 */
import { createMarkdownTextRange } from "../doctypes/markdown.js";
import type { MemorySeed, SeedThread } from "./store.js";

export function rangeOf(content: string, quote: string): { start: number; end: number } {
  const start = content.indexOf(quote);
  if (start === -1) throw new Error(`seed quote not found in content: ${quote}`);
  return { start, end: start + quote.length };
}

const V0 = [
  "# UniDocs 产品构想",
  "",
  "平台让人和外部 Agent 共同创作数字作品。",
  "",
  "## 版本引用约定",
  "",
  "引用固定到明确版本，源作品更新时提示。",
  "",
  "## 早期措辞",
  "",
  "这一段写得很绕，回头要换掉。",
  "",
].join("\n");

const V1 = V0.replace(
  "引用固定到明确版本，源作品更新时提示。",
  "引用固定到明确版本；源作品更新时提示，由人主动切换。",
);

// 第三处的锚点原文在这一版被 Agent 顺带改写掉了。
const V2 = V1.replace("这一段写得很绕，回头要换掉。", "这一节已重写为简明表述。");

function location(content: string, quote: string) {
  const { start, end } = rangeOf(content, quote);
  return createMarkdownTextRange({ documentContractIdx: 0, content, start, end });
}

function threads(): SeedThread[] {
  return [
    // 1. 待回复：有 ping 没 pong。
    {
      threadId: "th-open",
      pings: [{ baseVersionIdx: 2, text: "这一句还能再收紧吗？", location: location(V2, "平台让人和外部 Agent 共同创作数字作品。") }],
      pongs: [],
    },
    // 2. 已回复且 pong 产生新版本：右栏金色高亮。
    {
      threadId: "th-answered",
      pings: [{ baseVersionIdx: 0, text: "这里要说清楚谁来切换", location: location(V0, "引用固定到明确版本，源作品更新时提示。") }],
      pongs: [{
        respondThroughPingIdx: 0,
        text: "已补上「由人主动切换」。",
        producesContent: V1,
        resultLocations: [location(V1, "引用固定到明确版本；源作品更新时提示，由人主动切换。")],
      }],
    },
    // 3. 基于旧版本、内容仍在：右栏灰底虚线。
    {
      threadId: "th-stale-present",
      pings: [{ baseVersionIdx: 0, text: "标题层级是不是深了一层", location: location(V0, "## 版本引用约定") }],
      pongs: [],
    },
    // 4. 基于旧版本、原文已被改写：右栏不高亮，只给说明。
    {
      threadId: "th-stale-rewritten",
      pings: [{ baseVersionIdx: 0, text: "这段确实绕，建议拆成两句", location: location(V0, "这一段写得很绕，回头要换掉。") }],
      pongs: [],
    },
    // 5. 纯 pong：只回复，没产生新版本，不能显示版本号。
    {
      threadId: "th-plain-pong",
      pings: [{ baseVersionIdx: 2, text: "「数字作品」在这里指什么？", location: location(V2, "数字作品") }],
      pongs: [{ respondThroughPingIdx: 0, text: "指平台上一切有版本身份的创作产物，这里不改正文。" }],
    },
    // 6. ping 就写在 current 上：左右同版，右栏标「暂无改动」。
    {
      threadId: "th-on-current",
      pings: [{ baseVersionIdx: 2, text: "这节改得不错", location: location(V2, "这一节已重写为简明表述。") }],
      pongs: [],
    },
  ];
}

export function sampleSeed(): MemorySeed {
  return {
    documents: [
      { documentId: "doc-sample", name: "UniDocs · 产品构想", versions: [{ content: V0 }, { content: V1 }, { content: V2 }], threads: threads() },
      { documentId: "doc-empty", name: "共创空间 · 发布手记", versions: [{ content: "# 发布手记\n\n还没开始写。\n" }], threads: [] },
    ],
  };
}
```

`th-answered` 的 pong 带 `producesContent: V1`，而 seed 的 `versions` 已经列了 V0/V1/V2——Task 4 的 `loadDocument` 会先建完三个版本，再在装载 pong 时**又**追加一版。所以实现时 `loadDocument` 对 seed 里的 pong 必须**跳过** `appendVersion`，`producesContent` 只用于 Agent 运行时。在 Task 4 的 `loadDocument` 里把这两行删掉：

```ts
        if (pong.producesContent !== undefined) {
          this.appendVersion(state, pong.producesContent, "agent:sample");
        }
```

seed 的版本序列由 `versions` 字段单独声明，pong 只负责引用已存在的版本位置。

- [ ] **Step 6: 接上 autoRun 并导出**

`packages/tenant-portal-client/src/memory/transport.ts` 的 `createMemoryTransport` 改为：

```ts
export function createMemoryTransport(options: {
  store?: MemoryStore;
  seed?: MemorySeed;
  agent?: { autoRun?: boolean; respond?: Parameters<typeof createScriptedAgent>[0]["respond"] };
} = {}): PlatformTransport {
  const store = options.store ?? createMemoryStore(options.seed);
  const agent = createScriptedAgent({ store, respond: options.agent?.respond });
  const autoRun = options.agent?.autoRun ?? false;

  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    for (const route of memoryRoutes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(request.path);
      if (match === null) continue;

      const params = match.slice(1).map((value) => decodeURIComponent(value));
      try {
        const data = route.handle(store, request, params);
        if (autoRun && request.method === "POST") agent.runPending();
        return { ok: true, data };
      } catch (cause) {
        if (cause instanceof NotFound) return { ok: false, error: apiError("not_found", cause.message) };
        if (cause instanceof InvalidRequest) return { ok: false, error: apiError("invalid_request", cause.message) };
        if (cause instanceof Conflict) return { ok: false, error: apiError(cause.code, cause.message) };
        throw cause;
      }
    }
    return { ok: false, error: apiError("not_found", `no route for ${request.method} ${request.path}`) };
  };
}
```

注意 `agent.runPending()` 在 `data` 算完之后才跑——否则 `createThread` 的返回值里会带上本次就已生成的 pong，而真后端是异步接手的（§2.6），界面不该在发送的同一次响应里就看到回复。

`packages/tenant-portal-client/src/index.ts` 追加：

```ts
export { createMemoryStore, isOpen } from "./memory/store.js";
export type { MemorySeed, MemoryStore, SeedDocument, SeedPing, SeedPong, SeedThread } from "./memory/store.js";
export { createMemoryTransport } from "./memory/transport.js";
export { createScriptedAgent } from "./memory/agent.js";
export type { AgentContext, AgentReply, ScriptedAgent } from "./memory/agent.js";
export { rangeOf, sampleSeed } from "./memory/seed.js";
```

- [ ] **Step 7: 运行全部测试**

Run: `pnpm --filter @unidocs/tenant-portal-client test && pnpm typecheck`
Expected: PASS，client 包合计 41 个测试。

- [ ] **Step 8: 提交**

```bash
git add packages/tenant-portal-client
git commit -m "feat(portal): add scripted agent and sample data to the memory backend"
```

---

## Task 7: tenant-portal-webui 包脚手架、设备提示页与路由

**Files:**
- Create: `packages/tenant-portal-webui/package.json`
- Create: `packages/tenant-portal-webui/tsconfig.json`
- Create: `packages/tenant-portal-webui/vite.config.ts`
- Create: `packages/tenant-portal-webui/index.html`
- Create: `packages/tenant-portal-webui/tests/setup.ts`
- Create: `packages/tenant-portal-webui/src/main.tsx`
- Create: `packages/tenant-portal-webui/src/app.tsx`
- Create: `packages/tenant-portal-webui/src/client-context.tsx`
- Create: `packages/tenant-portal-webui/src/router.ts`
- Create: `packages/tenant-portal-webui/src/styles.css`
- Test: `packages/tenant-portal-webui/tests/router.test.ts`
- Test: `packages/tenant-portal-webui/tests/app.test.tsx`

**Interfaces:**
- Consumes: `@unidocs/tenant-portal-client` 的 `createTenantPortalClient`、`createMemoryTransport`、`sampleSeed`。
- Produces: `parseRoute(hash): Route`（`{ kind: "workbench" } | { kind: "document"; documentId; threadId?; pingIdx? }`）、`useClient()`、`App`。后续所有页面 task 都挂在 `App` 的路由上。

**包不进根 tsconfig references**：`@unidocs/web-gateway` 也没进——应用包是 `noEmit`，不是 composite，`tsc -b` 拉不动它。`pnpm -r typecheck` 会各自跑。

- [ ] **Step 1: 建包骨架**

`packages/tenant-portal-webui/package.json`：

```json
{
  "name": "@unidocs/tenant-portal-webui",
  "version": "0.1.0",
  "private": true,
  "description": "Comment-driven read-only WebUI for the UniDocs Tenant Portal",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "development": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "clean": "rimraf --glob dist \"*.tsbuildinfo\""
  },
  "dependencies": {
    "@unidocs/tenant-portal-client": "workspace:*",
    "dompurify": "3.2.6",
    "lucide-react": "^1.34.0",
    "marked": "15.0.12",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.9.0",
    "vite": "^7.3.0",
    "vitest": "^3.2.0"
  }
}
```

`packages/tenant-portal-webui/tsconfig.json`（照抄 web-gateway 的形状）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "useDefineForClassFields": true,
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

`packages/tenant-portal-webui/vite.config.ts`：

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/portal/",
  plugins: [react()],
  server: { port: 5175, strictPort: false },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./tests/setup.ts"] },
});
```

`packages/tenant-portal-webui/tests/setup.ts`：

```ts
import "@testing-library/jest-dom/vitest";

// jsdom 不实现 Selection.getRangeAt 之外的部分行为，Task 9 的选区测试按需补。
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }) as MediaQueryList;
}
```

`packages/tenant-portal-webui/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#fafaf9" />
    <title>UniDocs · 我的作品</title>
  </head>
  <body>
    <div id="root"></div>
    <noscript>请启用 JavaScript 以打开 UniDocs。</noscript>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 写路由的失败测试**

`packages/tenant-portal-webui/tests/router.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseRoute, routeToHash } from "../src/router.js";

describe("parseRoute", () => {
  it("空 hash 是工作台", () => {
    expect(parseRoute("")).toEqual({ kind: "workbench" });
    expect(parseRoute("#/")).toEqual({ kind: "workbench" });
  });

  it("文档路径", () => {
    expect(parseRoute("#/d/doc-sample")).toEqual({ kind: "document", documentId: "doc-sample" });
  });

  it("带一处与具体某条评论", () => {
    expect(parseRoute("#/d/doc-sample/th-open")).toEqual({
      kind: "document", documentId: "doc-sample", threadId: "th-open",
    });
    expect(parseRoute("#/d/doc-sample/th-open/2")).toEqual({
      kind: "document", documentId: "doc-sample", threadId: "th-open", pingIdx: 2,
    });
  });

  it("对路径段解码", () => {
    expect(parseRoute("#/d/doc%20one")).toEqual({ kind: "document", documentId: "doc one" });
  });

  it("认不出的 hash 回工作台", () => {
    expect(parseRoute("#/nonsense/x")).toEqual({ kind: "workbench" });
  });

  it("routeToHash 与 parseRoute 互为逆运算", () => {
    const route = { kind: "document", documentId: "doc one", threadId: "th/1", pingIdx: 0 } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });
});
```

`routeToHash` 是定位链接的基础（§2.6 要求单条评论可通过链接定位）。互逆测试防的是编码只做了一半。

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: FAIL — `Cannot find module '../src/router.js'`

- [ ] **Step 4: 写路由实现**

`packages/tenant-portal-webui/src/router.ts`：

```ts
/**
 * hash 路由。定位链接不携带 JWT、不授予权限——它只是「打开哪一处」。
 */
export type Route =
  | { readonly kind: "workbench" }
  | {
      readonly kind: "document";
      readonly documentId: string;
      readonly threadId?: string;
      readonly pingIdx?: number;
    };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\//, "");
  if (path === "") return { kind: "workbench" };

  const parts = path.split("/").map((segment) => decodeURIComponent(segment));
  if (parts[0] !== "d" || parts[1] === undefined || parts[1] === "") return { kind: "workbench" };

  const documentId = parts[1];
  if (parts[2] === undefined) return { kind: "document", documentId };

  const threadId = parts[2];
  if (parts[3] === undefined) return { kind: "document", documentId, threadId };

  const pingIdx = Number(parts[3]);
  if (!Number.isInteger(pingIdx) || pingIdx < 0) return { kind: "document", documentId, threadId };
  return { kind: "document", documentId, threadId, pingIdx };
}

export function routeToHash(route: Route): string {
  if (route.kind === "workbench") return "#/";
  const parts = ["d", route.documentId];
  if (route.threadId !== undefined) parts.push(route.threadId);
  if (route.pingIdx !== undefined) parts.push(String(route.pingIdx));
  return `#/${parts.map((segment) => encodeURIComponent(segment)).join("/")}`;
}
```

- [ ] **Step 5: 写 App 的失败测试**

`packages/tenant-portal-webui/tests/app.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { createTenantPortalClient, createMemoryTransport, sampleSeed } from "@unidocs/tenant-portal-client";

function renderApp() {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(<App client={client} />);
}

describe("App", () => {
  it("渲染品牌与工作台标题", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { name: "我的作品" })).toBeInTheDocument();
  });

  it("窄屏提示页始终在 DOM 里，由 CSS 控制显隐", () => {
    renderApp();
    expect(screen.getByText("请在电脑或平板上查看")).toBeInTheDocument();
  });

  it("界面上没有任何编辑内容的入口", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "我的作品" });

    expect(screen.queryByRole("button", { name: /解决/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重新打开/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /提交.*反馈/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
```

第三条是一条**长期护栏**，后续每个 task 都要保持它通过。它把 spec 的 Global Constraints 变成机器可检查的约束，而不是靠人记住。

- [ ] **Step 6: 写 App 实现**

`packages/tenant-portal-webui/src/client-context.tsx`：

```tsx
import { createContext, useContext } from "react";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";

const ClientContext = createContext<TenantPortalClient | null>(null);

export function ClientProvider(props: { client: TenantPortalClient; children: React.ReactNode }) {
  return <ClientContext.Provider value={props.client}>{props.children}</ClientContext.Provider>;
}

export function useClient(): TenantPortalClient {
  const client = useContext(ClientContext);
  if (client === null) throw new Error("useClient must be used inside ClientProvider");
  return client;
}
```

`packages/tenant-portal-webui/src/app.tsx`：

```tsx
import { useEffect, useState } from "react";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "./client-context.js";
import { parseRoute, type Route } from "./router.js";
import { WorkbenchPage } from "./pages/workbench.js";
import { DocumentPage } from "./pages/document.js";
import "./styles.css";

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function App(props: { client: TenantPortalClient }) {
  const route = useHashRoute();

  return (
    <ClientProvider client={props.client}>
      <section className="device-notice" aria-labelledby="device-notice-title">
        <h1 id="device-notice-title">请在电脑或平板上查看</h1>
        <p>移动端暂未开放。</p>
      </section>
      <div className="app">
        {route.kind === "workbench"
          ? <WorkbenchPage />
          : <DocumentPage documentId={route.documentId} threadId={route.threadId} pingIdx={route.pingIdx} />}
      </div>
    </ClientProvider>
  );
}
```

`packages/tenant-portal-webui/src/main.tsx`：

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { App } from "./app.js";

// 本轮没有真后端：注入假 transport，Agent 在每次写请求后自动接手一轮。
const client = createTenantPortalClient({
  tenantId: "t1",
  transport: createMemoryTransport({ seed: sampleSeed(), agent: { autoRun: true } }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><App client={client} /></StrictMode>,
);
```

`packages/tenant-portal-webui/src/styles.css`（低饱和灰白 token，沿用 mock 的视觉语言但不 import 它）：

```css
:root {
  --bg: #fafaf9;
  --surface: #ffffff;
  --surface-sunken: #f5f5f4;
  --border: #e7e5e4;
  --text: #1c1917;
  --text-muted: #78716c;
  --accent-ping: #16a34a;
  --accent-pong: #d97706;
  --accent-stale: #a8a29e;
  --accent-draft: #ca8a04;
  --panel-width: 316px;
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; }

.device-notice { display: none; }
@media (max-width: 760px) {
  .device-notice { display: grid; place-content: center; gap: 8px; min-height: 100dvh; padding: 24px; text-align: center; }
  .app { display: none; }
}
```

Task 11 与 Task 12 会在这里追加页面样式，不改 token。

- [ ] **Step 7: 建占位页面让测试能跑**

`packages/tenant-portal-webui/src/pages/workbench.tsx`：

```tsx
export function WorkbenchPage() {
  return <h1>我的作品</h1>;
}
```

`packages/tenant-portal-webui/src/pages/document.tsx`：

```tsx
export function DocumentPage(props: { documentId: string; threadId?: string; pingIdx?: number }) {
  return <h1>{props.documentId}</h1>;
}
```

这两个占位在 Task 11、Task 12 被完整实现替换。它们存在的唯一理由是让 Task 7 的测试自洽——不写占位就只能在 `app.test.tsx` 里放 TODO。

- [ ] **Step 8: 运行并提交**

Run: `pnpm install && pnpm --filter @unidocs/tenant-portal-webui test && pnpm --filter @unidocs/tenant-portal-webui typecheck`
Expected: PASS，9 个测试。

```bash
git add packages/tenant-portal-webui pnpm-lock.yaml
git commit -m "feat(portal): scaffold tenant portal webui with hash routing"
```

---

## Task 8: ViewChannel 与本地通道

**Files:**
- Create: `packages/tenant-portal-webui/src/view/markers.ts`
- Create: `packages/tenant-portal-webui/src/view/channel.ts`
- Test: `packages/tenant-portal-webui/tests/view-channel.test.ts`

**Interfaces:**
- Consumes: `@unidocs/protocol-platform` 的 `ViewRpcContracts`、`HostRpcContracts`、`ViewSetMarkersRequest`。
- Produces: `ViewChannel`、`ViewImplementation`、`HostImplementation`、`createLocalChannel({ view, host })`、`MarkerRole`、`RoledMarker`、`toProtocolMarkers(roled)`。Task 9 的 `MarkdownView` 实现 `ViewImplementation`；Task 12/13 通过 `ViewChannel` 驱动两栏。

**这是以后换 iframe 时唯一要替换的文件。** 因此 `createLocalChannel` 即便是直接函数调用也必须返回 `Promise`，并且调用参数要经过一次结构化拷贝——否则 view 与 host 会共享对象引用，换成 `postMessage` 时才发现上层依赖了引用相等。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-webui/tests/view-channel.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createLocalChannel, type ViewImplementation, type HostImplementation } from "../src/view/channel.js";
import { toProtocolMarkers, type RoledMarker } from "../src/view/markers.js";

function stubHost(): HostImplementation {
  return {
    readBlob: vi.fn(),
    listThreads: vi.fn(async () => ({ items: [], nextCursor: null })),
    getThread: vi.fn(),
    createThread: vi.fn(async () => ({ threadId: "th-new", pings: [], pongs: [] })),
    appendPing: vi.fn(),
    storeBlob: vi.fn(),
  } as unknown as HostImplementation;
}

function stubView(): ViewImplementation {
  return {
    initialize: vi.fn(async () => ({ acceptedProtocol: "unidocs-view-host/v1" as const })),
    loadSnapshot: vi.fn(async () => ({ renderedVersionIdx: 0 })),
    setViewport: vi.fn(async () => ({ appliedRevision: 1 })),
    setMarkers: vi.fn(async () => undefined),
    focusLocation: vi.fn(async () => ({ located: true, reason: "located" as const })),
    dispose: vi.fn(async () => undefined),
  };
}

describe("createLocalChannel", () => {
  it("callView 转发到 view 实现并返回结果", async () => {
    const view = stubView();
    const channel = createLocalChannel({ view, host: stubHost() });

    const result = await channel.callView("loadSnapshot", {
      context: { contextId: "c1" } as never,
      snapshot: { content: "# x" } as never,
    });

    expect(result).toEqual({ renderedVersionIdx: 0 });
    expect(view.loadSnapshot).toHaveBeenCalledOnce();
  });

  it("view 拿到的是拷贝，不与调用方共享引用", async () => {
    const view = stubView();
    const channel = createLocalChannel({ view, host: stubHost() });
    const snapshot = { content: "# x" };

    await channel.callView("loadSnapshot", { context: { contextId: "c1" } as never, snapshot: snapshot as never });

    const received = (view.loadSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0].snapshot;
    expect(received).toEqual(snapshot);
    expect(received).not.toBe(snapshot);
  });

  it("view 侧调 host 时同样被转发", async () => {
    const host = stubHost();
    let callHost: Parameters<ViewImplementation["initialize"]>[1] | undefined;
    const view: ViewImplementation = {
      ...stubView(),
      initialize: async (_request, hostApi) => {
        callHost = hostApi;
        return { acceptedProtocol: "unidocs-view-host/v1" };
      },
    };
    const channel = createLocalChannel({ view, host });

    await channel.callView("initialize", { protocol: "unidocs-view-host/v1", context: {} as never, mode: { kind: "interactive" } });
    await callHost!.createThread({ baseVersionIdx: 0, content: { text: "x", richContent: null, attachments: [] }, location: null });

    expect(host.createThread).toHaveBeenCalledOnce();
  });

  it("dispose 之后再调用被拒绝", async () => {
    const channel = createLocalChannel({ view: stubView(), host: stubHost() });
    channel.dispose();

    await expect(channel.callView("setViewport", { revision: 1, state: null })).rejects.toThrow(/disposed/);
  });
});

describe("toProtocolMarkers", () => {
  it("剥掉本地的 role 字段，只留协议形状", () => {
    const roled: RoledMarker[] = [{
      threadId: "th-1", pingIdx: 0, open: true, role: "ping",
      location: { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 0, end: 1, quote: "x" } },
    }];

    const markers = toProtocolMarkers(roled);

    expect(markers[0]).not.toHaveProperty("role");
    expect(markers[0]).toMatchObject({ threadId: "th-1", pingIdx: 0, open: true });
  });
});
```

最后一条锁住 §3.2 的边界:`role` 是 webui 的本地概念,不能泄进协议形状里。等协议补上 role 后,这个函数变成恒等映射再删掉。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: FAIL — `Cannot find module '../src/view/channel.js'`

- [ ] **Step 3: 写 markers 本地类型**

`packages/tenant-portal-webui/src/view/markers.ts`：

```ts
/**
 * 临时定义，等协议补齐后整文件删除。
 *
 * ViewSetMarkersRequest.markers 目前是 { threadId, pingIdx, open, location }，区分不了
 * 「这是 ping」「这是 pong 的结果」「这是已过时的 ping」。spec §4.2 的右栏四种渲染需要
 * 这个区分。缺口记在 docs/design/platform-v0/tenant/TODO.md，等协议设计定稿后，把
 * role 加进协议 marker 并删掉本文件。
 */
import type { ViewSetMarkersRequest } from "@unidocs/protocol-platform";

export type ProtocolMarker = ViewSetMarkersRequest["markers"][number];

export type MarkerRole = "ping" | "pong-result" | "stale-ping";

export interface RoledMarker extends ProtocolMarker {
  readonly role: MarkerRole;
}

export function toProtocolMarkers(markers: readonly RoledMarker[]): readonly ProtocolMarker[] {
  return markers.map(({ role, ...marker }) => marker);
}
```

- [ ] **Step 4: 写 channel**

`packages/tenant-portal-webui/src/view/channel.ts`：

```ts
/**
 * host 与 view 之间的唯一接缝。
 *
 * 本轮 view 跑在同进程，但走 protocol-platform/src/view.ts 的消息契约。换成隔离
 * iframe 时新增 createPostMessageChannel，本文件以外不动。
 */
import type {
  CasBlobRef,
  CreateThreadRequest,
  DocumentLocation,
  HostAppendPingRequest,
  HostListThreadsRequest,
  HostReadBlobRequest,
  HostReadBlobResponse,
  HostStoreBlobRequest,
  Page,
  PingRecord,
  ThreadDetail,
  ThreadId,
  ThreadRef,
  ViewFocusLocationResponse,
  ViewInitializeRequest,
  ViewInitializeResponse,
  ViewLoadSnapshotRequest,
  ViewLoadSnapshotResponse,
  ViewRpcContracts,
  ViewSetMarkersRequest,
  ViewSetViewportRequest,
  ViewSetViewportResponse,
} from "@unidocs/protocol-platform";

/** view 侧可以回调 host 的能力。 */
export interface HostImplementation {
  readBlob(request: HostReadBlobRequest): Promise<HostReadBlobResponse>;
  listThreads(request: HostListThreadsRequest): Promise<Page<ThreadRef>>;
  getThread(threadId: ThreadId): Promise<ThreadDetail>;
  createThread(request: CreateThreadRequest): Promise<ThreadDetail>;
  appendPing(request: HostAppendPingRequest): Promise<PingRecord>;
  storeBlob(request: HostStoreBlobRequest): Promise<CasBlobRef>;
}

export interface ViewImplementation {
  initialize(request: ViewInitializeRequest, host: HostImplementation): Promise<ViewInitializeResponse>;
  loadSnapshot(request: ViewLoadSnapshotRequest, host: HostImplementation): Promise<ViewLoadSnapshotResponse>;
  setViewport(request: ViewSetViewportRequest, host: HostImplementation): Promise<ViewSetViewportResponse>;
  setMarkers(request: ViewSetMarkersRequest, host: HostImplementation): Promise<void>;
  focusLocation(request: DocumentLocation, host: HostImplementation): Promise<ViewFocusLocationResponse>;
  dispose(request: Record<string, never>, host: HostImplementation): Promise<void>;
}

export type ViewMethod = keyof ViewRpcContracts extends `view.${infer M}` ? M : never;

export interface ViewChannel {
  callView<M extends ViewMethod>(
    method: M,
    request: Parameters<ViewImplementation[M]>[0],
  ): Promise<Awaited<ReturnType<ViewImplementation[M]>>>;
  dispose(): void;
}

/** 模拟跨界传输：两侧不共享对象引用，换 postMessage 时行为不变。 */
function copy<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

export function createLocalChannel(options: {
  view: ViewImplementation;
  host: HostImplementation;
}): ViewChannel {
  const { view, host } = options;
  let disposed = false;

  return {
    async callView(method, request) {
      if (disposed) throw new Error(`view channel is disposed; ${method} rejected`);
      const handler = view[method] as (
        request: unknown,
        host: HostImplementation,
      ) => Promise<unknown>;
      const result = await handler.call(view, copy(request), host);
      return copy(result) as never;
    },
    dispose() {
      disposed = true;
    },
  };
}
```

`structuredClone` 在 jsdom 与现代浏览器里都有；`ArrayBuffer` 也能过（`HostReadBlobResponse.bytes` 要用）。

- [ ] **Step 5: 运行确认通过并提交**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: PASS，新增 5 个测试。

```bash
git add packages/tenant-portal-webui
git commit -m "feat(portal): add view channel with host rpc contract"
```

---

## Task 9: MarkdownView

**Files:**
- Create: `packages/tenant-portal-webui/src/view/markdown-view.ts`
- Test: `packages/tenant-portal-webui/tests/markdown-view.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `ViewImplementation`、`HostImplementation`；Task 3 的 `resolveMarkdownTextRange`、`MarkdownSnapshot`。
- Produces: `createMarkdownView({ container }): ViewImplementation & { selectionRange(): {start,end} | null }`。Task 12/13 的 `ViewHost` 用它。

**渲染与高亮的顺序:** marked 先把 Markdown 转成 HTML，DOMPurify 清理，再按 marker 在**渲染后的 DOM 文本**上套高亮。所以需要一层「source 偏移 ↔ 渲染文本偏移」的映射。本轮取最简可靠的做法：高亮时按 marker 的 `quote` 在渲染后的文本节点里查找，而不是换算偏移。`quote` 本来就是为这件事准备的（Task 3）。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-webui/tests/markdown-view.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarkdownTextRange } from "@unidocs/tenant-portal-client";
import { createMarkdownView } from "../src/view/markdown-view.js";
import type { HostImplementation } from "../src/view/channel.js";

const content = "# 标题\n\n第一段内容。\n\n第二段内容。\n";
const host = {} as HostImplementation;
const context = { contextId: "c1", document: {}, viewVersion: null, viewBundleId: "vb", readOnly: true } as never;

function mounted() {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, view: createMarkdownView({ container }) };
}

describe("MarkdownView", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("initialize 接受协议版本", async () => {
    const { view } = mounted();
    const result = await view.initialize({ protocol: "unidocs-view-host/v1", context, mode: { kind: "interactive" } }, host);
    expect(result.acceptedProtocol).toBe("unidocs-view-host/v1");
  });

  it("loadSnapshot 渲染 Markdown 并返回渲染的版本号", async () => {
    const { container, view } = mounted();

    const result = await view.loadSnapshot(
      { context: { ...(context as object), viewVersion: { versionIdx: 2 } } as never, snapshot: { content } as never },
      host,
    );

    expect(result.renderedVersionIdx).toBe(2);
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.textContent).toContain("第一段内容。");
  });

  it("清理掉危险标记", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content: "正常\n\n<img src=x onerror=alert(1)>\n" } as never }, host);

    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("snapshot 为 null 时渲染空，不抛错", async () => {
    const { container, view } = mounted();
    const result = await view.loadSnapshot({ context, snapshot: null }, host);

    expect(result.renderedVersionIdx).toBeNull();
    expect(container.textContent?.trim()).toBe("");
  });

  it("setMarkers 按 role 给不同的 class", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    await view.setMarkers({
      revision: 1,
      markers: [
        { threadId: "th-1", pingIdx: 0, open: true, location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 }), role: "ping" },
        { threadId: "th-2", pingIdx: 0, open: false, location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第二段内容。"), end: content.indexOf("第二段内容。") + 6 }), role: "pong-result" },
      ] as never,
    }, host);

    expect(container.querySelector(".marker-ping")?.textContent).toBe("第一段内容。");
    expect(container.querySelector(".marker-pong-result")?.textContent).toBe("第二段内容。");
  });

  it("setMarkers 覆盖上一批，不叠加", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);
    const marker = (quote: string, role: string) => ({
      threadId: "th-1", pingIdx: 0, open: true, role,
      location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf(quote), end: content.indexOf(quote) + quote.length }),
    });

    await view.setMarkers({ revision: 1, markers: [marker("第一段内容。", "ping")] as never }, host);
    await view.setMarkers({ revision: 2, markers: [marker("第二段内容。", "ping")] as never }, host);

    expect(container.querySelectorAll(".marker-ping")).toHaveLength(1);
    expect(container.querySelector(".marker-ping")?.textContent).toBe("第二段内容。");
  });

  it("定位不到的 marker 被静默跳过，不影响其他 marker", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    await view.setMarkers({
      revision: 1,
      markers: [
        { threadId: "th-gone", pingIdx: 0, open: true, role: "ping", location: createMarkdownTextRange({ documentContractIdx: 0, content: "别处的原文", start: 0, end: 5 }) },
        { threadId: "th-ok", pingIdx: 0, open: true, role: "ping", location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 }) },
      ] as never,
    }, host);

    expect(container.querySelectorAll(".marker-ping")).toHaveLength(1);
  });

  it("focusLocation 在内容还在时返回 located", async () => {
    const { view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 });
    expect(await view.focusLocation(location, host)).toEqual({ located: true, reason: "located" });
  });

  it("focusLocation 在原文被改写后返回 unresolvable", async () => {
    const { view } = mounted();
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 });

    await view.loadSnapshot({ context, snapshot: { content: "# 标题\n\n完全换过了。\n" } as never }, host);

    expect(await view.focusLocation(location, host)).toEqual({ located: false, reason: "unresolvable" });
  });

  it("focusLocation 对认不出的 locationType 返回 unsupported_type", async () => {
    const { view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    const result = await view.focusLocation(
      { documentContractIdx: 0, locationType: "unidocs.psd.layer-region/v2", payload: {} },
      host,
    );
    expect(result).toEqual({ located: false, reason: "unsupported_type" });
  });

  it("dispose 后容器被清空", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    await view.dispose({}, host);

    expect(container.innerHTML).toBe("");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: FAIL — `Cannot find module '../src/view/markdown-view.js'`

- [ ] **Step 3: 写实现**

`packages/tenant-portal-webui/src/view/markdown-view.ts`：

```ts
/**
 * Markdown 的 View 实现。跑在同进程，但只通过 ViewImplementation 被调用——host 拿不到
 * 它的内部 DOM，换成 iframe 时这里整体搬进 bundle。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { readMarkdownTextRange, type MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import type {
  DocumentLocation,
  ViewFocusLocationResponse,
  ViewInitializeRequest,
  ViewInitializeResponse,
  ViewLoadSnapshotRequest,
  ViewLoadSnapshotResponse,
  ViewSetMarkersRequest,
  ViewSetViewportRequest,
  ViewSetViewportResponse,
} from "@unidocs/protocol-platform";
import type { ViewImplementation } from "./channel.js";
import type { MarkerRole, RoledMarker } from "./markers.js";

export interface MarkdownViewInstance extends ViewImplementation {
  /** 当前用户选区在 source 上的偏移；无选区时 null。Task 15 的「添加评论」用。 */
  selectionRange(): { start: number; end: number } | null;
}

function renderedText(container: HTMLElement): string {
  return container.textContent ?? "";
}

/** 在渲染后的 DOM 里按原文查找并包一层 <mark>。查不到返回 false。 */
function highlight(container: HTMLElement, quote: string, role: MarkerRole, threadId: string): boolean {
  if (quote === "") return false;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const at = text.indexOf(quote);
    if (at === -1) continue;

    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + quote.length);

    const mark = document.createElement("mark");
    mark.className = `marker marker-${role}`;
    mark.dataset.threadId = threadId;
    range.surroundContents(mark);
    return true;
  }
  return false;
}

function clearMarkers(container: HTMLElement): void {
  for (const mark of [...container.querySelectorAll("mark.marker")]) {
    mark.replaceWith(...mark.childNodes);
  }
  container.normalize();
}

export function createMarkdownView(options: { container: HTMLElement }): MarkdownViewInstance {
  const { container } = options;
  let source = "";

  return {
    async initialize(_request: ViewInitializeRequest): Promise<ViewInitializeResponse> {
      return { acceptedProtocol: "unidocs-view-host/v1" };
    },

    async loadSnapshot(request: ViewLoadSnapshotRequest): Promise<ViewLoadSnapshotResponse> {
      const snapshot = request.snapshot as unknown as MarkdownSnapshot | null;
      source = snapshot?.content ?? "";
      container.innerHTML = source === ""
        ? ""
        : DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
      return { renderedVersionIdx: request.context.viewVersion?.versionIdx ?? null };
    },

    async setViewport(request: ViewSetViewportRequest): Promise<ViewSetViewportResponse> {
      return { appliedRevision: request.revision };
    },

    async setMarkers(request: ViewSetMarkersRequest): Promise<void> {
      clearMarkers(container);
      for (const marker of request.markers as readonly RoledMarker[]) {
        const range = readMarkdownTextRange(marker.location);
        if (range === null) continue;
        highlight(container, range.quote, marker.role ?? "ping", marker.threadId);
      }
    },

    async focusLocation(location: DocumentLocation): Promise<ViewFocusLocationResponse> {
      const range = readMarkdownTextRange(location);
      if (range === null) return { located: false, reason: "unsupported_type" };

      const found = renderedText(container).includes(range.quote) && range.quote !== "";
      if (!found) return { located: false, reason: "unresolvable" };

      container.querySelector(`mark[data-thread-id]`)?.scrollIntoView?.({ block: "center" });
      return { located: true, reason: "located" };
    },

    async dispose(): Promise<void> {
      container.innerHTML = "";
      source = "";
    },

    selectionRange() {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
      if (!container.contains(selection.anchorNode)) return null;

      const quote = selection.toString();
      const at = source.indexOf(quote);
      if (at === -1) return null;
      return { start: at, end: at + quote.length };
    },
  };
}
```

`selectionRange` 用选中文字在 **source** 上反查偏移。渲染后的文本与 source 不完全一致（Markdown 标记被吃掉），所以跨越标记的选区会查不到、返回 `null`——这是有意的保守行为，Task 15 会在这种情况下不弹「添加评论」，而不是记一个错位的锚点。

- [ ] **Step 4: 加高亮样式**

`packages/tenant-portal-webui/src/styles.css` 追加：

```css
.marker { background: none; color: inherit; border-radius: 2px; padding: 0 1px; }
.marker-ping { background: color-mix(in srgb, var(--accent-ping) 22%, transparent); box-shadow: inset 0 -2px 0 var(--accent-ping); }
.marker-pong-result { background: color-mix(in srgb, var(--accent-pong) 24%, transparent); box-shadow: inset 0 -2px 0 var(--accent-pong); }
.marker-stale-ping { background: var(--surface-sunken); outline: 1px dashed var(--accent-stale); outline-offset: 1px; }
```

三种 role 的视觉按 spec §4.2：绿色 ping、金色 pong 结果、灰底虚线过时 ping。

- [ ] **Step 5: 运行确认通过并提交**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: PASS，新增 11 个测试。

```bash
git add packages/tenant-portal-webui
git commit -m "feat(portal): render markdown views with roled location markers"
```

---

## Task 10: thread 状态派生、讨论计数与右栏判定

**Files:**
- Create: `packages/tenant-portal-webui/src/model/thread-state.ts`
- Create: `packages/tenant-portal-webui/src/model/discussion-summary.ts`
- Create: `packages/tenant-portal-webui/src/model/compare.ts`
- Test: `packages/tenant-portal-webui/tests/thread-state.test.ts`
- Test: `packages/tenant-portal-webui/tests/compare.test.ts`

**Interfaces:**
- Consumes: `@unidocs/tenant-portal-client` 的 `TenantPortalClient`、`resolveMarkdownTextRange`。
- Produces:
  - `deriveThreadState(detail): ThreadState`（`{ open, acknowledgedPingIdx, latestPingIdx, latestPong }`）。
  - `loadDiscussionSummary(client, documentId): Promise<DiscussionSummary>`（`{ openCount, answeredCount, threads }`）——**N+1 集中在这一个函数里**（§3.3）。
  - `decideRightPane(input): RightPaneDecision`——右栏四种情况（§4.2）。

- [ ] **Step 1: 写 thread-state 的失败测试**

`packages/tenant-portal-webui/tests/thread-state.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { deriveThreadState } from "../src/model/thread-state.js";
import { loadDiscussionSummary } from "../src/model/discussion-summary.js";

const ping = (pingIdx: number) => ({
  pingIdx, baseVersionIdx: 0, content: { text: `p${pingIdx}`, richContent: null, attachments: [] },
  location: null, authorId: "user:1", createdAt: "2026-09-01T00:00:00.000Z",
});
const pong = (pongIdx: number, through: number, resultLocations: unknown[] = []) => ({
  pongIdx, respondThroughPingIdx: through, content: { text: `a${pongIdx}`, richContent: null, attachments: [] },
  resultLocations, authorAgentId: "agent:1", submissionId: `s${pongIdx}`, createdAt: "2026-09-01T00:00:00.000Z",
});

describe("deriveThreadState", () => {
  it("只有 ping 时是待回复", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [] } as never);
    expect(state).toMatchObject({ open: true, latestPingIdx: 0, acknowledgedPingIdx: -1 });
  });

  it("水位覆盖最新 ping 时是已回复", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [pong(0, 0)] } as never);
    expect(state.open).toBe(false);
  });

  it("水位之后又追加 ping 时重新变成待回复", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0), ping(1)], pongs: [pong(0, 0)] } as never);
    expect(state).toMatchObject({ open: true, acknowledgedPingIdx: 0, latestPingIdx: 1 });
  });

  it("一条 pong 可以累计确认多条 ping", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0), ping(1), ping(2)], pongs: [pong(0, 2)] } as never);
    expect(state.open).toBe(false);
  });

  it("latestPong 取最后一条", () => {
    const state = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [pong(0, 0), pong(1, 0)] } as never);
    expect(state.latestPong?.pongIdx).toBe(1);
  });

  it("纯 pong 被标出来，不携带版本号", () => {
    const plain = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [pong(0, 0)] } as never);
    const withVersion = deriveThreadState({ threadId: "t", pings: [ping(0)], pongs: [pong(0, 0, [{}])] } as never);

    expect(plain.latestPongIsPlain).toBe(true);
    expect(withVersion.latestPongIsPlain).toBe(false);
  });
});

describe("loadDiscussionSummary", () => {
  it("对样本文档算出待回复与已回复数", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });

    const summary = await loadDiscussionSummary(client, "doc-sample");

    expect(summary.openCount + summary.answeredCount).toBe(summary.threads.length);
    expect(summary.openCount).toBeGreaterThan(0);
    expect(summary.answeredCount).toBeGreaterThan(0);
  });

  it("空文档给出零计数", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
    const summary = await loadDiscussionSummary(client, "doc-empty");

    expect(summary).toMatchObject({ openCount: 0, answeredCount: 0, threads: [] });
  });
});
```

- [ ] **Step 2: 运行确认失败，然后写实现**

Run: `pnpm --filter @unidocs/tenant-portal-webui test` → FAIL。

`packages/tenant-portal-webui/src/model/thread-state.ts`：

```ts
/**
 * thread 的 open 状态是水位关系的结果，不是标志位——所以界面上没有解决/重新打开按钮。
 * 对应 tenant-webui-v0.md §2.1：open := latestPingSequence > acknowledgedPingSequence
 */
import type { PongRecord, ThreadDetail } from "@unidocs/protocol-platform";

export interface ThreadState {
  readonly open: boolean;
  readonly latestPingIdx: number;
  readonly acknowledgedPingIdx: number;
  readonly latestPong: PongRecord | null;
  /** 纯 pong：只回复、没产生新版本。界面上用中性色，不显示版本号。 */
  readonly latestPongIsPlain: boolean;
}

export function deriveThreadState(detail: ThreadDetail): ThreadState {
  const acknowledgedPingIdx = detail.pongs.reduce((max, pong) => Math.max(max, pong.respondThroughPingIdx), -1);
  const latestPingIdx = detail.pings.reduce((max, ping) => Math.max(max, ping.pingIdx), -1);
  const latestPong = detail.pongs.length === 0 ? null : detail.pongs[detail.pongs.length - 1];

  return {
    open: latestPingIdx > acknowledgedPingIdx,
    latestPingIdx,
    acknowledgedPingIdx,
    latestPong,
    latestPongIsPlain: latestPong !== null && latestPong.resultLocations.length === 0,
  };
}
```

`packages/tenant-portal-webui/src/model/discussion-summary.ts`：

```ts
/**
 * 作品卡片的讨论计数。
 *
 * N+1 集中在这里：listThreads 只返回 ThreadRef（仅 threadId），DocumentRecord 也没有
 * 讨论计数，所以只能逐个 getThread。假后端下没有性能问题。缺口记在
 * docs/design/platform-v0/tenant/TODO.md；协议补上计数后只改本文件。
 */
import type { ThreadDetail } from "@unidocs/protocol-platform";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import { deriveThreadState, type ThreadState } from "./thread-state.js";

export interface SummarizedThread {
  readonly detail: ThreadDetail;
  readonly state: ThreadState;
}

export interface DiscussionSummary {
  readonly openCount: number;
  readonly answeredCount: number;
  readonly threads: readonly SummarizedThread[];
  /** 最近一条 Agent 回复，供工作台顶部的「Agent 最新回复」用。 */
  readonly latestPong: { readonly threadId: string; readonly text: string | null; readonly isPlain: boolean } | null;
}

export async function loadDiscussionSummary(
  client: TenantPortalClient,
  documentId: string,
): Promise<DiscussionSummary> {
  const refs = await client.listThreads(documentId);
  const details = await Promise.all(refs.items.map((ref) => client.getThread(documentId, ref.threadId)));
  const threads = details.map((detail) => ({ detail, state: deriveThreadState(detail) }));

  let latestPong: DiscussionSummary["latestPong"] = null;
  let latestAt = "";
  for (const { detail, state } of threads) {
    if (state.latestPong === null) continue;
    if (state.latestPong.createdAt <= latestAt) continue;
    latestAt = state.latestPong.createdAt;
    latestPong = { threadId: detail.threadId, text: state.latestPong.content.text, isPlain: state.latestPongIsPlain };
  }

  return {
    openCount: threads.filter((thread) => thread.state.open).length,
    answeredCount: threads.filter((thread) => !thread.state.open).length,
    threads,
    latestPong,
  };
}
```

- [ ] **Step 3: 写右栏判定的失败测试**

`packages/tenant-portal-webui/tests/compare.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createMarkdownTextRange } from "@unidocs/tenant-portal-client";
import { decideRightPane } from "../src/model/compare.js";

const content = "# 标题\n\n保留的一段。\n\n另一段。\n";
const at = (quote: string) =>
  createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf(quote), end: content.indexOf(quote) + quote.length });

const ping = (baseVersionIdx: number, quote: string) => ({
  pingIdx: 0, baseVersionIdx, location: at(quote),
  content: { text: "c", richContent: null, attachments: [] }, authorId: "u", createdAt: "x",
});

describe("decideRightPane", () => {
  it("有覆盖该 ping 的 pong 时金色高亮结果位置", () => {
    const decision = decideRightPane({
      ping: ping(0, "保留的一段。"),
      pongs: [{ pongIdx: 0, respondThroughPingIdx: 0, resultLocations: [at("另一段。")], content: { text: "改好了", richContent: null, attachments: [] }, authorAgentId: "a", submissionId: "s", createdAt: "x" }] as never,
      currentVersionIdx: 1,
      currentContent: content,
    });

    expect(decision.kind).toBe("pong-result");
    if (decision.kind === "pong-result") expect(decision.markers[0].role).toBe("pong-result");
  });

  it("ping 就写在 current 上时不重复高亮", () => {
    const decision = decideRightPane({ ping: ping(1, "保留的一段。"), pongs: [], currentVersionIdx: 1, currentContent: content });

    expect(decision).toEqual({ kind: "same-version", markers: [] });
  });

  it("基于旧版本且内容仍在时给灰底虚线", () => {
    const decision = decideRightPane({ ping: ping(0, "保留的一段。"), pongs: [], currentVersionIdx: 1, currentContent: content });

    expect(decision.kind).toBe("stale-present");
    if (decision.kind === "stale-present") expect(decision.markers[0].role).toBe("stale-ping");
  });

  it("基于旧版本且原文已被改写时不高亮", () => {
    const decision = decideRightPane({
      ping: ping(0, "保留的一段。"), pongs: [], currentVersionIdx: 1,
      currentContent: "# 标题\n\n全换了。\n",
    });

    expect(decision).toEqual({ kind: "stale-rewritten", markers: [] });
  });

  it("有 pong 但只回复、没有结果位置时仍按 pong-result 分支且 markers 为空", () => {
    const decision = decideRightPane({
      ping: ping(0, "保留的一段。"),
      pongs: [{ pongIdx: 0, respondThroughPingIdx: 0, resultLocations: [], content: { text: "解释", richContent: null, attachments: [] }, authorAgentId: "a", submissionId: "s", createdAt: "x" }] as never,
      currentVersionIdx: 1, currentContent: content,
    });

    expect(decision.kind).toBe("pong-result");
    if (decision.kind === "pong-result") expect(decision.markers).toEqual([]);
  });

  it("ping 没有位置锚点时按 same-version 处理，不假装能高亮", () => {
    const decision = decideRightPane({
      ping: { ...ping(0, "保留的一段。"), location: null }, pongs: [], currentVersionIdx: 1, currentContent: content,
    });

    expect(decision.markers).toEqual([]);
  });
});
```

- [ ] **Step 4: 写右栏判定实现**

`packages/tenant-portal-webui/src/model/compare.ts`：

```ts
/**
 * 右栏四种渲染的判定，对应 tenant-webui-v0.md §2.2 与 spec §4.2。
 *
 * 平台不做语义迁移，也不因为 current 前移就作废旧版本上的评论。第三、四种的常见成因
 * 不是用户自己改的，而是 Agent 处理别的一处评论时顺带改掉了这段内容。
 */
import type { PingRecord, PongRecord, VersionIdx } from "@unidocs/protocol-platform";
import { resolveMarkdownTextRange } from "@unidocs/tenant-portal-client";
import type { RoledMarker } from "../view/markers.js";

export type RightPaneKind = "pong-result" | "same-version" | "stale-present" | "stale-rewritten";

export interface RightPaneDecision {
  readonly kind: RightPaneKind;
  readonly markers: readonly RoledMarker[];
}

export function decideRightPane(input: {
  ping: PingRecord;
  pongs: readonly PongRecord[];
  currentVersionIdx: VersionIdx | null;
  currentContent: string;
}): RightPaneDecision {
  const { ping, pongs, currentVersionIdx, currentContent } = input;

  const covering = pongs.filter((pong) => pong.respondThroughPingIdx >= ping.pingIdx);
  if (covering.length > 0) {
    const latest = covering[covering.length - 1];
    return {
      kind: "pong-result",
      markers: latest.resultLocations.map((location, index) => ({
        threadId: "", pingIdx: ping.pingIdx, open: false, location, role: "pong-result" as const,
      })).map((marker, index) => ({ ...marker, pingIdx: ping.pingIdx + index * 0 })),
    };
  }

  if (ping.baseVersionIdx === currentVersionIdx) return { kind: "same-version", markers: [] };
  if (ping.location === null) return { kind: "same-version", markers: [] };

  const resolution = resolveMarkdownTextRange(ping.location, currentContent);
  if (!resolution.located) return { kind: "stale-rewritten", markers: [] };

  return {
    kind: "stale-present",
    markers: [{ threadId: "", pingIdx: ping.pingIdx, open: true, location: ping.location, role: "stale-ping" }],
  };
}
```

判定顺序就是 spec §4.2 表格的行序，命中即停。注意 `pong-result` 必须排在 `same-version` 前面——一条基于 current 的 ping 也可能已经被回复。

- [ ] **Step 5: 运行确认通过并提交**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: PASS，新增 14 个测试。

```bash
git add packages/tenant-portal-webui
git commit -m "feat(portal): derive thread state and right-pane comparison decisions"
```

---

## Task 11: 我的作品列表

**Files:**
- Modify: `packages/tenant-portal-webui/src/pages/workbench.tsx`（替换 Task 7 的占位）
- Create: `packages/tenant-portal-webui/src/pages/workbench.css`
- Test: `packages/tenant-portal-webui/tests/workbench.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 `useClient`、Task 10 的 `loadDiscussionSummary`、Task 7 的 `routeToHash`。
- Produces: `WorkbenchPage`。Task 14 会往卡片上加未发送草稿数。

对应 `tenant-webui-v0.md` §4：卡片底部暴露讨论状态，顶部一条「Agent 最新回复」，文案上明确 **pong 只表示已处理，不表示你已接受**。纯 pong 用中性色，不穿版本号的衣服。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-webui/tests/workbench.test.tsx`：

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { WorkbenchPage } from "../src/pages/workbench.js";

function renderPage() {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(<ClientProvider client={client}><WorkbenchPage /></ClientProvider>);
}

describe("WorkbenchPage", () => {
  it("平铺列出作品，不按业务状态分组", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: /UniDocs · 产品构想/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /共创空间 · 发布手记/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /待审阅/ })).not.toBeInTheDocument();
  });

  it("卡片暴露讨论状态", async () => {
    renderPage();
    const card = (await screen.findByRole("link", { name: /UniDocs · 产品构想/ })).closest("article")!;

    expect(within(card).getByText(/处待回复/)).toBeInTheDocument();
    expect(within(card).getByText(/Agent 已回复/)).toBeInTheDocument();
  });

  it("没有讨论的作品显示暂无讨论", async () => {
    renderPage();
    const card = (await screen.findByRole("link", { name: /共创空间 · 发布手记/ })).closest("article")!;

    expect(within(card).getByText("暂无讨论")).toBeInTheDocument();
  });

  it("顶部列出 Agent 最新回复，并说明已处理不等于已接受", async () => {
    renderPage();
    const strip = await screen.findByRole("status", { name: "Agent 最新回复" });

    expect(within(strip).getByText(/已处理.*不表示你已接受/)).toBeInTheDocument();
  });

  it("关键词筛选匹配标题", async () => {
    renderPage();
    await screen.findByRole("link", { name: /UniDocs · 产品构想/ });

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索作品" }), "发布手记");

    expect(screen.queryByRole("link", { name: /UniDocs · 产品构想/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /共创空间 · 发布手记/ })).toBeInTheDocument();
  });

  it("卡片链接指向文档路由", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: /UniDocs · 产品构想/ });

    expect(link).toHaveAttribute("href", "#/d/doc-sample");
  });

  it("列表为空时给空态而不是伪造样例", async () => {
    const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: { documents: [] } }) });
    render(<ClientProvider client={client}><WorkbenchPage /></ClientProvider>);

    expect(await screen.findByText("还没有作品")).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: FAIL — 找不到 `我的作品` 之外的任何内容（Task 7 的占位只渲染标题）。

- [ ] **Step 3: 写实现**

`packages/tenant-portal-webui/src/pages/workbench.tsx`：

```tsx
import { useEffect, useMemo, useState } from "react";
import type { DocumentRecord } from "@unidocs/protocol-platform";
import { useClient } from "../client-context.js";
import { loadDiscussionSummary, type DiscussionSummary } from "../model/discussion-summary.js";
import { routeToHash } from "../router.js";
import "./workbench.css";

interface Entry {
  readonly document: DocumentRecord;
  readonly summary: DiscussionSummary;
}

function discussionLabel(summary: DiscussionSummary): string {
  if (summary.threads.length === 0) return "暂无讨论";
  const parts: string[] = [];
  if (summary.openCount > 0) parts.push(`${summary.openCount} 处待回复`);
  if (summary.answeredCount > 0) parts.push(`Agent 已回复 ${summary.answeredCount} 处`);
  return parts.join(" · ");
}

export function WorkbenchPage() {
  const client = useClient();
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  const [keyword, setKeyword] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.listDocuments();
        const loaded = await Promise.all(page.items.map(async (document) => ({
          document,
          summary: await loadDiscussionSummary(client, document.documentId),
        })));
        if (!cancelled) setEntries(loaded);
      } catch (cause) {
        if (!cancelled) setFailure(cause instanceof Error ? cause.message : "加载失败");
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const visible = useMemo(() => {
    if (entries === null) return null;
    const needle = keyword.trim();
    if (needle === "") return entries;
    return entries.filter((entry) => entry.document.name.includes(needle));
  }, [entries, keyword]);

  const latest = useMemo(
    () => entries?.flatMap((entry) => entry.summary.latestPong === null
      ? []
      : [{ document: entry.document, pong: entry.summary.latestPong }]) ?? [],
    [entries],
  );

  return (
    <main className="workbench">
      <header className="workbench-head">
        <h1>我的作品</h1>
        <input
          type="search"
          aria-label="搜索作品"
          placeholder="搜索标题"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </header>

      <section className="agent-strip" role="status" aria-label="Agent 最新回复">
        <h2>Agent 最新回复</h2>
        <p className="agent-strip-note">回复只表示 Agent 已处理，不表示你已接受。不同意就在原处追加一条评论。</p>
        {latest.length === 0
          ? <p className="muted">还没有回复。</p>
          : (
            <ul>
              {latest.map(({ document, pong }) => (
                <li key={document.documentId}>
                  <a href={routeToHash({ kind: "document", documentId: document.documentId, threadId: pong.threadId })}>
                    {document.name}
                  </a>
                  <span className={pong.isPlain ? "pong-plain" : "pong-versioned"}>{pong.text}</span>
                </li>
              ))}
            </ul>
          )}
      </section>

      {failure !== null && <p role="alert">加载失败：{failure}</p>}
      {visible === null && failure === null && <p className="muted">加载中……</p>}
      {visible !== null && visible.length === 0 && <p className="muted">还没有作品</p>}

      <ul className="document-grid">
        {(visible ?? []).map((entry) => (
          <li key={entry.document.documentId}>
            <article>
              <a href={routeToHash({ kind: "document", documentId: entry.document.documentId })}>
                {entry.document.name}
              </a>
              <footer>{discussionLabel(entry.summary)}</footer>
            </article>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

`discussionLabel` 刻意不做「N 处讨论」这种合并说法——§4 要求把待回复与已回复分开暴露，因为它们对用户意味着完全不同的下一步。

`packages/tenant-portal-webui/src/pages/workbench.css`：

```css
.workbench { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
.workbench-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.workbench-head h1 { font-size: 20px; font-weight: 600; margin: 0; }
.workbench-head input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }

.agent-strip { margin: 24px 0; padding: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.agent-strip h2 { font-size: 14px; margin: 0 0 4px; }
.agent-strip-note { margin: 0 0 12px; color: var(--text-muted); font-size: 12px; }
.agent-strip ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.agent-strip li { display: flex; gap: 12px; align-items: baseline; }
.pong-plain { color: var(--text-muted); }
.pong-versioned { color: var(--text); }

.document-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.document-grid article { display: grid; gap: 12px; padding: 16px; min-height: 140px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.document-grid a { color: inherit; font-weight: 600; text-decoration: none; }
.document-grid footer { margin-top: auto; color: var(--text-muted); font-size: 12px; }
.muted { color: var(--text-muted); }
```

- [ ] **Step 4: 运行确认通过并提交**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: PASS，新增 7 个测试。`app.test.tsx` 里那条「没有编辑入口」的护栏此时会因为搜索框而失败——把它改成只断言 `textbox`（搜索框的 role 是 `searchbox`，不是 `textbox`），保持护栏含义不变：

```tsx
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
```

```bash
git add packages/tenant-portal-webui
git commit -m "feat(portal): list documents with derived discussion status"
```

---

## Task 12: 文档页单栏与讨论面板

**Files:**
- Modify: `packages/tenant-portal-webui/src/pages/document.tsx`（替换 Task 7 的占位）
- Create: `packages/tenant-portal-webui/src/pages/document.css`
- Create: `packages/tenant-portal-webui/src/view/view-host.tsx`
- Create: `packages/tenant-portal-webui/src/panel/thread-panel.tsx`
- Create: `packages/tenant-portal-webui/src/panel/thread-card.tsx`
- Create: `packages/tenant-portal-webui/src/model/use-document.ts`
- Test: `packages/tenant-portal-webui/tests/document-page.test.tsx`

**Interfaces:**
- Consumes: Task 8 的 `createLocalChannel`、Task 9 的 `createMarkdownView`、Task 10 的三个 model。
- Produces: `useDocumentSession(documentId)`（返回 `{ document, currentVersion, threads, reload, failure }`）、`ViewHost`、`ThreadPanel`、`ThreadCard`、`DocumentPage`。Task 13 把 `DocumentPage` 扩成分屏，Task 14/15 往 `ThreadCard` 加草稿与输入框。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-webui/tests/document-page.test.tsx`：

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { DocumentPage } from "../src/pages/document.js";

function renderPage(props: { threadId?: string; pingIdx?: number } = {}) {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(
    <ClientProvider client={client}>
      <DocumentPage documentId="doc-sample" threadId={props.threadId} pingIdx={props.pingIdx} />
    </ClientProvider>,
  );
}

describe("DocumentPage", () => {
  it("顶栏标出内容只读、由 Agent 编辑", async () => {
    renderPage();
    expect(await screen.findByText("只读 · 内容由 Agent 编辑")).toBeInTheDocument();
  });

  it("没有选中一处时是单栏 current", async () => {
    renderPage();
    await screen.findByText("只读 · 内容由 Agent 编辑");

    expect(screen.getByRole("region", { name: "当前版本" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /评论所基于的版本/ })).not.toBeInTheDocument();
  });

  it("渲染 current 的正文", async () => {
    renderPage();
    const pane = await screen.findByRole("region", { name: "当前版本" });

    expect(within(pane).getByText(/这一节已重写为简明表述。/)).toBeInTheDocument();
  });

  it("讨论面板按待回复/已回复分别标出每一处", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    expect(within(panel).getAllByText("待回复").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("已回复").length).toBeGreaterThan(0);
  });

  it("面板上没有解决、重新打开或批量提交", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    expect(within(panel).queryByRole("button", { name: /解决/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /重新打开/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /提交.*条/ })).not.toBeInTheDocument();
  });

  it("评论卡片标出各自的版本号与落后多少版", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    expect(within(panel).getAllByText(/^v\d+$/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/基于 v0 · 已过 2 版/).length).toBeGreaterThan(0);
  });

  it("纯 pong 用中性色且不显示版本号", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });
    const plain = within(panel).getByText(/指平台上一切有版本身份的创作产物/).closest(".pong-card")!;

    expect(plain).toHaveClass("pong-plain");
    expect(within(plain as HTMLElement).queryByText(/^v\d+$/)).not.toBeInTheDocument();
  });

  it("筛选只看待回复", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await userEvent.click(within(panel).getByRole("button", { name: "待回复" }));

    expect(within(panel).queryByText("已回复")).not.toBeInTheDocument();
  });

  it("点一处会把它写进 hash，供定位链接使用", async () => {
    renderPage();
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await userEvent.click(within(panel).getByRole("button", { name: /这一句还能再收紧吗？/ }));

    expect(window.location.hash).toBe("#/d/doc-sample/th-open");
  });

  it("文档还没有 current version 时给初始化空态", async () => {
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: createMemoryTransport({ seed: { documents: [{ documentId: "doc-new", name: "新作品", versions: [], threads: [] }] } }),
    });
    render(<ClientProvider client={client}><DocumentPage documentId="doc-new" /></ClientProvider>);

    expect(await screen.findByText("这件作品还在初始化，暂时没有可读的版本。")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: FAIL — 占位页只渲染 `doc-sample`。

- [ ] **Step 3: 写数据加载 hook**

`packages/tenant-portal-webui/src/model/use-document.ts`：

```ts
import { useCallback, useEffect, useState } from "react";
import type { DocumentRecord, VersionRecord } from "@unidocs/protocol-platform";
import { PlatformError } from "@unidocs/tenant-portal-client";
import { useClient } from "../client-context.js";
import { loadDiscussionSummary, type DiscussionSummary } from "./discussion-summary.js";

export interface DocumentSession {
  readonly document: DocumentRecord | null;
  readonly currentVersion: VersionRecord | null;
  readonly summary: DiscussionSummary | null;
  readonly failure: PlatformError | Error | null;
  readonly loading: boolean;
  reload(): void;
}

export function useDocumentSession(documentId: string): DocumentSession {
  const client = useClient();
  const [state, setState] = useState<Omit<DocumentSession, "reload">>({
    document: null, currentVersion: null, summary: null, failure: null, loading: true,
  });
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true }));

    void (async () => {
      try {
        const document = await client.getDocument(documentId);
        const currentVersion = document.currentVersionIdx === null
          ? null
          : await client.getVersion(documentId, document.currentVersionIdx);
        const summary = await loadDiscussionSummary(client, documentId);
        if (!cancelled) setState({ document, currentVersion, summary, failure: null, loading: false });
      } catch (cause) {
        if (!cancelled) {
          setState({
            document: null, currentVersion: null, summary: null, loading: false,
            failure: cause instanceof Error ? cause : new Error("加载失败"),
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [client, documentId, epoch]);

  const reload = useCallback(() => setEpoch((value) => value + 1), []);
  return { ...state, reload };
}
```

`reload` 用 epoch 计数而不是直接重跑——Task 15 发送评论后要刷新，而 Agent 是异步接手的（§2.6），所以刷新必须能被重复触发。

- [ ] **Step 4: 写 ViewHost**

`packages/tenant-portal-webui/src/view/view-host.tsx`：

```tsx
import { useEffect, useRef } from "react";
import type { SValue, VersionRecord } from "@unidocs/protocol-platform";
import { createLocalChannel, type HostImplementation, type ViewChannel } from "./channel.js";
import { createMarkdownView } from "./markdown-view.js";
import { toProtocolMarkers, type RoledMarker } from "./markers.js";

const noopHost: HostImplementation = {
  readBlob: async () => { throw new Error("readBlob is not available in this round"); },
  listThreads: async () => ({ items: [], nextCursor: null }),
  getThread: async () => { throw new Error("getThread is not available in this round"); },
  createThread: async () => { throw new Error("createThread is wired in Task 15"); },
  appendPing: async () => { throw new Error("appendPing is wired in Task 15"); },
  storeBlob: async () => { throw new Error("storeBlob is not available in this round"); },
};

export function ViewHost(props: {
  label: string;
  version: VersionRecord | null;
  markers: readonly RoledMarker[];
  host?: HostImplementation;
  className?: string;
  onReady?: (channel: ViewChannel) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ViewChannel | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const channel = createLocalChannel({
      view: createMarkdownView({ container }),
      host: props.host ?? noopHost,
    });
    channelRef.current = channel;
    props.onReady?.(channel);

    return () => {
      void channel.callView("dispose", {}).catch(() => undefined);
      channel.dispose();
      channelRef.current = null;
    };
    // host 与 onReady 的身份变化不应重建 view；只在挂载时建一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const channel = channelRef.current;
    if (channel === null) return;

    const context = {
      contextId: props.label,
      document: {} as never,
      viewVersion: props.version,
      viewBundleId: "local-markdown",
      readOnly: true,
    };

    void (async () => {
      await channel.callView("initialize", {
        protocol: "unidocs-view-host/v1",
        context: context as never,
        mode: { kind: "interactive" },
      });
      await channel.callView("loadSnapshot", {
        context: context as never,
        snapshot: (props.version?.snapshot ?? null) as SValue | null,
      });
      await channel.callView("setMarkers", {
        revision: 1,
        markers: toProtocolMarkers(props.markers) as never,
      });
    })();
  }, [props.label, props.version, props.markers]);

  return <div ref={containerRef} role="region" aria-label={props.label} className={props.className} />;
}
```

`toProtocolMarkers` 在这里剥掉 `role`，而 `MarkdownView.setMarkers` 又需要它——这是 §3.2 缺口的直接代价。本轮 `MarkdownView` 从 `marker.role ?? "ping"` 兜底读取，所以**改成传原始 `props.markers`**，并在本文件留下注释：

```tsx
      await channel.callView("setMarkers", {
        revision: 1,
        // role 尚未进协议（见 view/markers.ts），本地通道下原样透传；
        // 换成 postMessage 前必须先把 role 加进协议 marker。
        markers: props.markers as never,
      });
```

- [ ] **Step 5: 写讨论面板**

`packages/tenant-portal-webui/src/panel/thread-card.tsx`：

```tsx
import type { PingRecord, PongRecord, VersionIdx } from "@unidocs/protocol-platform";
import type { ThreadState } from "../model/thread-state.js";

export function PingCard(props: { ping: PingRecord; currentVersionIdx: VersionIdx | null }) {
  const behind = props.currentVersionIdx === null ? 0 : props.currentVersionIdx - props.ping.baseVersionIdx;

  return (
    <li className="ping-card">
      <p>{props.ping.content.text}</p>
      <footer>
        <span className="version-badge">v{props.ping.baseVersionIdx}</span>
        {behind > 0 && <span className="behind">基于 v{props.ping.baseVersionIdx} · 已过 {behind} 版</span>}
      </footer>
    </li>
  );
}

export function PongCard(props: { pong: PongRecord }) {
  const plain = props.pong.resultLocations.length === 0;

  return (
    <li className={`pong-card ${plain ? "pong-plain" : "pong-versioned"}`}>
      <p>{props.pong.content.text}</p>
      <footer>{plain ? "Agent 已回复，未改动内容" : "Agent 已处理并提交了新版本"}</footer>
    </li>
  );
}

export function ThreadCard(props: {
  threadId: string;
  pings: readonly PingRecord[];
  pongs: readonly PongRecord[];
  state: ThreadState;
  currentVersionIdx: VersionIdx | null;
  selected: boolean;
  onSelect(): void;
}) {
  const first = props.pings[0];

  return (
    <article className={`thread-card${props.selected ? " selected" : ""}`}>
      <button type="button" onClick={props.onSelect}>
        <span className={props.state.open ? "status-open" : "status-answered"}>
          {props.state.open ? "待回复" : "已回复"}
        </span>
        <span className="thread-excerpt">{first?.content.text}</span>
      </button>

      {props.selected && (
        <ul className="thread-messages">
          {props.pings.map((ping) => (
            <PingCard key={ping.pingIdx} ping={ping} currentVersionIdx={props.currentVersionIdx} />
          ))}
          {props.pongs.map((pong) => <PongCard key={pong.pongIdx} pong={pong} />)}
        </ul>
      )}
    </article>
  );
}
```

`PongCard` 的 footer 文案区分纯 pong 与产新版的 pong，但**两者都不显示版本号**——纯 pong 没有版本可显示，产新版的 pong 其版本号属于文档本身，挂在 pong 上会让用户以为那是「这条回复的版本」。

`packages/tenant-portal-webui/src/panel/thread-panel.tsx`：

```tsx
import { useState } from "react";
import type { VersionIdx } from "@unidocs/protocol-platform";
import type { SummarizedThread } from "../model/discussion-summary.js";
import { ThreadCard } from "./thread-card.js";

export type ThreadFilter = "all" | "open" | "answered";

const FILTERS: readonly { value: ThreadFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "open", label: "待回复" },
  { value: "answered", label: "已回复" },
];

export function ThreadPanel(props: {
  threads: readonly SummarizedThread[];
  currentVersionIdx: VersionIdx | null;
  selectedThreadId?: string;
  onSelect(threadId: string): void;
}) {
  const [filter, setFilter] = useState<ThreadFilter>("all");

  const visible = props.threads.filter(({ state }) =>
    filter === "all" || (filter === "open" ? state.open : !state.open));

  return (
    <aside className="thread-panel" role="complementary" aria-label="讨论">
      <nav className="thread-filter">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </nav>

      {visible.length === 0 && <p className="muted">暂无讨论。在正文里选中一段内容即可添加评论。</p>}

      {visible.map(({ detail, state }) => (
        <ThreadCard
          key={detail.threadId}
          threadId={detail.threadId}
          pings={detail.pings}
          pongs={detail.pongs}
          state={state}
          currentVersionIdx={props.currentVersionIdx}
          selected={props.selectedThreadId === detail.threadId}
          onSelect={() => props.onSelect(detail.threadId)}
        />
      ))}
    </aside>
  );
}
```

面板上**没有常驻输入区，也没有底部批次提交条**（§2.6）。Task 15 加的「回复」按钮也是点开才出输入框。

- [ ] **Step 6: 写文档页**

`packages/tenant-portal-webui/src/pages/document.tsx`：

```tsx
import type { MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import { useDocumentSession } from "../model/use-document.js";
import { ThreadPanel } from "../panel/thread-panel.js";
import { routeToHash } from "../router.js";
import { ViewHost } from "../view/view-host.js";
import "./document.css";

export function DocumentPage(props: { documentId: string; threadId?: string; pingIdx?: number }) {
  const session = useDocumentSession(props.documentId);

  if (session.failure !== null) return <main className="document"><p role="alert">{session.failure.message}</p></main>;
  if (session.loading || session.document === null) return <main className="document"><p className="muted">加载中……</p></main>;

  const currentContent = (session.currentVersion?.snapshot as unknown as MarkdownSnapshot | undefined)?.content ?? "";

  return (
    <main className="document">
      <header className="document-top">
        <h1>{session.document.name}</h1>
        <span className="readonly-badge">只读 · 内容由 Agent 编辑</span>
      </header>

      <div className="document-body">
        {session.currentVersion === null
          ? <p className="muted">这件作品还在初始化，暂时没有可读的版本。</p>
          : <ViewHost label="当前版本" version={session.currentVersion} markers={[]} className="pane pane-current" />}

        <ThreadPanel
          threads={session.summary?.threads ?? []}
          currentVersionIdx={session.document.currentVersionIdx}
          selectedThreadId={props.threadId}
          onSelect={(threadId) => {
            window.location.hash = routeToHash({ kind: "document", documentId: props.documentId, threadId });
          }}
        />
      </div>
    </main>
  );
}
```

`currentContent` 目前没用到，Task 13 的右栏判定会用它——先算出来会让 Task 13 只改 JSX 不动数据流。

`packages/tenant-portal-webui/src/pages/document.css`：

```css
.document { display: grid; grid-template-rows: auto 1fr; height: 100dvh; }
.document-top { display: flex; gap: 12px; align-items: baseline; padding: 16px 24px; border-bottom: 1px solid var(--border); background: var(--surface); }
.document-top h1 { font-size: 16px; margin: 0; }
.readonly-badge { padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); font-size: 12px; }

.document-body { display: grid; grid-template-columns: 1fr var(--panel-width); min-height: 0; }
.pane { overflow: auto; padding: 24px 32px; }
.pane-current { background: var(--surface); }

.thread-panel { border-left: 1px solid var(--border); background: var(--surface-sunken); overflow: auto; padding: 16px; }
.thread-filter { display: flex; gap: 4px; margin-bottom: 12px; }
.thread-filter button { padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font-size: 12px; cursor: pointer; }
.thread-filter button[aria-pressed="true"] { background: var(--text); color: var(--surface); border-color: var(--text); }

.thread-card { margin-bottom: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.thread-card.selected { border-color: var(--text-muted); }
.thread-card > button { display: grid; gap: 4px; width: 100%; padding: 12px; border: 0; background: none; text-align: left; cursor: pointer; font: inherit; }
.status-open { color: var(--accent-ping); font-size: 12px; }
.status-answered { color: var(--text-muted); font-size: 12px; }
.thread-excerpt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.thread-messages { list-style: none; margin: 0; padding: 0 12px 12px; display: grid; gap: 8px; }
.ping-card, .pong-card { padding: 10px; border-radius: 6px; background: var(--surface-sunken); }
.ping-card p, .pong-card p { margin: 0 0 6px; }
.ping-card footer, .pong-card footer { display: flex; gap: 8px; color: var(--text-muted); font-size: 12px; }
.version-badge { padding: 0 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); }
.pong-card.pong-plain { border-left: 2px solid var(--accent-stale); }
.pong-card.pong-versioned { border-left: 2px solid var(--accent-pong); }
```

- [ ] **Step 7: 运行确认通过并提交**

Run: `pnpm --filter @unidocs/tenant-portal-webui test && pnpm --filter @unidocs/tenant-portal-webui typecheck`
Expected: PASS，新增 10 个测试。

```bash
git add packages/tenant-portal-webui
git commit -m "feat(portal): add read-only document page with discussion panel"
```

---

## Task 13: 分屏对照与右栏四种情况

**Files:**
- Modify: `packages/tenant-portal-webui/src/pages/document.tsx`
- Modify: `packages/tenant-portal-webui/src/pages/document.css`
- Modify: `packages/tenant-portal-webui/src/panel/thread-card.tsx`
- Test: `packages/tenant-portal-webui/tests/split-view.test.tsx`

**Interfaces:**
- Consumes: Task 10 的 `decideRightPane`、Task 12 的 `useDocumentSession` 与 `ViewHost`。
- Produces: `DocumentPage` 在 `threadId` 存在时渲染分屏；`PingCard` 新增 `onSelect` 让逐条评论切基版（§2.3）。

对应 `tenant-webui-v0.md` §2.2、§2.3 与 spec §4.2。左栏灰底、只读徽标、绿色 ping 高亮；右栏四选一；最右仍是 316px 讨论面板。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-webui/tests/split-view.test.tsx`：

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { DocumentPage } from "../src/pages/document.js";

function renderAt(threadId: string, pingIdx?: number) {
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
  return render(
    <ClientProvider client={client}>
      <DocumentPage documentId="doc-sample" threadId={threadId} pingIdx={pingIdx} />
    </ClientProvider>,
  );
}

const base = () => screen.findByRole("region", { name: "评论所基于的版本" });
const current = () => screen.getByRole("region", { name: "当前版本" });

describe("分屏对照", () => {
  it("选中一处后出现左右两栏与讨论面板", async () => {
    renderAt("th-answered");

    expect(await base()).toBeInTheDocument();
    expect(current()).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "讨论" })).toBeInTheDocument();
  });

  it("左栏渲染该 ping 的基版，不是 current", async () => {
    renderAt("th-answered");
    const pane = await base();

    expect(within(pane).getByText(/引用固定到明确版本，源作品更新时提示。/)).toBeInTheDocument();
    expect(within(pane).queryByText(/由人主动切换/)).not.toBeInTheDocument();
  });

  it("左栏带只读徽标与基版版本号", async () => {
    renderAt("th-answered");
    const wrapper = (await base()).closest(".pane-wrapper")!;

    expect(within(wrapper as HTMLElement).getByText("基版 v0 · 只读")).toBeInTheDocument();
  });

  it("有 pong 时右栏金色高亮结果位置", async () => {
    renderAt("th-answered");
    await base();

    expect(current().querySelector(".marker-pong-result")).not.toBeNull();
  });

  it("ping 就写在 current 上时右栏标暂无改动且不重复高亮", async () => {
    renderAt("th-on-current");
    await base();

    expect(screen.getByText("暂无改动 · 与左栏同一版本")).toBeInTheDocument();
    expect(current().querySelector(".marker-pong-result")).toBeNull();
    expect(current().querySelector(".marker-stale-ping")).toBeNull();
  });

  it("基于旧版本、内容仍在时右栏灰底虚线并说明这不是 Agent 的改动", async () => {
    renderAt("th-stale-present");
    await base();

    expect(current().querySelector(".marker-stale-ping")).not.toBeNull();
    expect(screen.getByText(/这不是 Agent 的改动/)).toBeInTheDocument();
  });

  it("基于旧版本、原文已被改写时不高亮，只给说明", async () => {
    renderAt("th-stale-rewritten");
    await base();

    expect(current().querySelector(".marker-stale-ping")).toBeNull();
    expect(screen.getByText(/这段内容已经不在当前版本里/)).toBeInTheDocument();
  });

  it("说明文案指出常见成因是 Agent 处理别处评论时顺带改的", async () => {
    renderAt("th-stale-rewritten");
    await base();

    expect(screen.getByText(/处理别的一处评论时顺带改动/)).toBeInTheDocument();
  });

  it("点具体某一条评论，左栏切到那条的基版", async () => {
    renderAt("th-answered");
    const panel = await screen.findByRole("complementary", { name: "讨论" });

    await userEvent.click(within(panel).getByRole("button", { name: /这里要说清楚谁来切换/ }));

    expect(window.location.hash).toBe("#/d/doc-sample/th-answered/0");
  });

  it("pingIdx 指定时左栏用那一条的基版", async () => {
    renderAt("th-answered", 0);
    const wrapper = (await base()).closest(".pane-wrapper")!;

    expect(within(wrapper as HTMLElement).getByText("基版 v0 · 只读")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: FAIL — 找不到 `评论所基于的版本` 这个 region。

- [ ] **Step 3: 让 PingCard 可点**

`packages/tenant-portal-webui/src/panel/thread-card.tsx` 的 `PingCard` 改为：

```tsx
export function PingCard(props: {
  ping: PingRecord;
  currentVersionIdx: VersionIdx | null;
  selected?: boolean;
  onSelect?(): void;
}) {
  const behind = props.currentVersionIdx === null ? 0 : props.currentVersionIdx - props.ping.baseVersionIdx;

  return (
    <li className={`ping-card${props.selected === true ? " selected" : ""}`}>
      <button type="button" onClick={props.onSelect}>
        <p>{props.ping.content.text}</p>
        <footer>
          <span className="version-badge">v{props.ping.baseVersionIdx}</span>
          {behind > 0 && <span className="behind">基于 v{props.ping.baseVersionIdx} · 已过 {behind} 版</span>}
        </footer>
      </button>
    </li>
  );
}
```

`ThreadCard` 相应地接收并透传：

```tsx
export function ThreadCard(props: {
  threadId: string;
  pings: readonly PingRecord[];
  pongs: readonly PongRecord[];
  state: ThreadState;
  currentVersionIdx: VersionIdx | null;
  selected: boolean;
  selectedPingIdx?: number;
  onSelect(): void;
  onSelectPing?(pingIdx: number): void;
}) {
  const first = props.pings[0];

  return (
    <article className={`thread-card${props.selected ? " selected" : ""}`}>
      <button type="button" onClick={props.onSelect}>
        <span className={props.state.open ? "status-open" : "status-answered"}>
          {props.state.open ? "待回复" : "已回复"}
        </span>
        <span className="thread-excerpt">{first?.content.text}</span>
      </button>

      {props.selected && (
        <ul className="thread-messages">
          {props.pings.map((ping) => (
            <PingCard
              key={ping.pingIdx}
              ping={ping}
              currentVersionIdx={props.currentVersionIdx}
              selected={props.selectedPingIdx === ping.pingIdx}
              onSelect={() => props.onSelectPing?.(ping.pingIdx)}
            />
          ))}
          {props.pongs.map((pong) => <PongCard key={pong.pongIdx} pong={pong} />)}
        </ul>
      )}
    </article>
  );
}
```

`ThreadPanel` 把 `selectedPingIdx` 与 `onSelectPing` 从 props 透传下去（新增这两个 props，签名与 `ThreadCard` 同名）。

- [ ] **Step 4: 写分屏**

`packages/tenant-portal-webui/src/pages/document.tsx` 替换为：

```tsx
import { useEffect, useState } from "react";
import type { VersionRecord } from "@unidocs/protocol-platform";
import { createMarkdownTextRange, type MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import { decideRightPane, type RightPaneDecision } from "../model/compare.js";
import { useDocumentSession } from "../model/use-document.js";
import { useClient } from "../client-context.js";
import { ThreadPanel } from "../panel/thread-panel.js";
import { routeToHash } from "../router.js";
import { ViewHost } from "../view/view-host.js";
import type { RoledMarker } from "../view/markers.js";
import "./document.css";

const RIGHT_PANE_NOTE: Readonly<Record<RightPaneDecision["kind"], string | null>> = {
  "pong-result": null,
  "same-version": "暂无改动 · 与左栏同一版本",
  "stale-present": "这段内容还在，但这不是 Agent 的改动——常见成因是它处理别的一处评论时顺带改动了附近内容。",
  "stale-rewritten": "这段内容已经不在当前版本里。平台不做语义迁移，这条评论依然有效，由 Agent 判断它是否仍然适用；常见成因是它处理别的一处评论时顺带改动了这里。",
};

export function DocumentPage(props: { documentId: string; threadId?: string; pingIdx?: number }) {
  const client = useClient();
  const session = useDocumentSession(props.documentId);
  const [baseVersion, setBaseVersion] = useState<VersionRecord | null>(null);

  const selected = session.summary?.threads.find(({ detail }) => detail.threadId === props.threadId) ?? null;
  const ping = selected === null
    ? null
    : selected.detail.pings.find((candidate) => candidate.pingIdx === props.pingIdx)
      ?? selected.detail.pings[selected.detail.pings.length - 1];

  useEffect(() => {
    if (ping === undefined || ping === null) { setBaseVersion(null); return; }
    let cancelled = false;
    void client.getVersion(props.documentId, ping.baseVersionIdx)
      .then((version) => { if (!cancelled) setBaseVersion(version); })
      .catch(() => { if (!cancelled) setBaseVersion(null); });
    return () => { cancelled = true; };
  }, [client, props.documentId, ping?.baseVersionIdx]);

  if (session.failure !== null) return <main className="document"><p role="alert">{session.failure.message}</p></main>;
  if (session.loading || session.document === null) return <main className="document"><p className="muted">加载中……</p></main>;

  const currentContent = (session.currentVersion?.snapshot as unknown as MarkdownSnapshot | undefined)?.content ?? "";
  const decision = ping === null || ping === undefined
    ? null
    : decideRightPane({
        ping,
        pongs: selected!.detail.pongs,
        currentVersionIdx: session.document.currentVersionIdx,
        currentContent,
      });

  const leftMarkers: readonly RoledMarker[] = ping?.location == null
    ? []
    : [{ threadId: props.threadId!, pingIdx: ping.pingIdx, open: selected!.state.open, location: ping.location, role: "ping" }];

  const note = decision === null ? null : RIGHT_PANE_NOTE[decision.kind];
  const split = ping !== null && ping !== undefined && baseVersion !== null;

  return (
    <main className="document">
      <header className="document-top">
        <h1>{session.document.name}</h1>
        <span className="readonly-badge">只读 · 内容由 Agent 编辑</span>
      </header>

      <div className={`document-body${split ? " split" : ""}`}>
        {split && (
          <div className="pane-wrapper pane-base">
            <p className="pane-label">基版 v{baseVersion.versionIdx} · 只读</p>
            <ViewHost label="评论所基于的版本" version={baseVersion} markers={leftMarkers} className="pane" />
          </div>
        )}

        <div className="pane-wrapper">
          {note !== null && <p className="pane-note">{note}</p>}
          {session.currentVersion === null
            ? <p className="muted">这件作品还在初始化，暂时没有可读的版本。</p>
            : <ViewHost label="当前版本" version={session.currentVersion} markers={decision?.markers ?? []} className="pane pane-current" />}
        </div>

        <ThreadPanel
          threads={session.summary?.threads ?? []}
          currentVersionIdx={session.document.currentVersionIdx}
          selectedThreadId={props.threadId}
          selectedPingIdx={props.pingIdx}
          onSelect={(threadId) => {
            window.location.hash = routeToHash({ kind: "document", documentId: props.documentId, threadId });
          }}
          onSelectPing={(pingIdx) => {
            window.location.hash = routeToHash({
              kind: "document", documentId: props.documentId, threadId: props.threadId!, pingIdx,
            });
          }}
        />
      </div>
    </main>
  );
}
```

`RIGHT_PANE_NOTE` 把 §2.2 那句最关键的话写死在代码里：**这不是 Agent 的改动，常见成因是它处理别的一处评论时顺带改的**。不写清楚，用户会把「灰底虚线」读成对自己那条评论的回应。

`decideRightPane` 返回的 `markers` 里 `threadId` 是空串（Task 10 里这样写的）。补上真实值：在上面调用处把结果 map 一遍。

```tsx
  const rightMarkers: readonly RoledMarker[] = (decision?.markers ?? [])
    .map((marker) => ({ ...marker, threadId: props.threadId ?? "" }));
```

然后右栏 `ViewHost` 用 `rightMarkers`。

- [ ] **Step 5: 加分屏样式**

`packages/tenant-portal-webui/src/pages/document.css` 追加：

```css
.document-body.split { grid-template-columns: 1fr 1fr var(--panel-width); }
.pane-wrapper { display: grid; grid-template-rows: auto 1fr; min-height: 0; border-right: 1px solid var(--border); }
.pane-base { background: var(--surface-sunken); }
.pane-label { margin: 0; padding: 8px 32px; color: var(--text-muted); font-size: 12px; border-bottom: 1px solid var(--border); }
.pane-note { margin: 0; padding: 8px 32px; color: var(--text-muted); font-size: 12px; background: var(--surface-sunken); border-bottom: 1px solid var(--border); }
```

- [ ] **Step 6: 运行确认通过并提交**

Run: `pnpm --filter @unidocs/tenant-portal-webui test && pnpm --filter @unidocs/tenant-portal-webui typecheck`
Expected: PASS，新增 10 个测试。

```bash
git add packages/tenant-portal-webui
git commit -m "feat(portal): split base and current versions with four right-pane states"
```

---

## Task 14: 本地草稿

**Files:**
- Create: `packages/tenant-portal-webui/src/drafts/draft-store.ts`
- Create: `packages/tenant-portal-webui/src/drafts/use-drafts.ts`
- Test: `packages/tenant-portal-webui/tests/drafts.test.ts`

**Interfaces:**
- Consumes: 无（纯本地）。
- Produces:
  - `Draft`：`{ draftId, documentId, anchorKey, threadId, location, baseVersionIdx, text, idempotencyKey, editedFromPingIdx, updatedAt }`。
  - `createDraftStore(storage)`：`list` / `save` / `remove` / `listForDocument` / `countForDocument`。
  - `useDrafts(documentId)`：`{ drafts, saveDraft, removeDraft, countByAnchor }`。

**关键约束（§2.7）：** 同一锚点可以并存多份；`idempotencyKey` 在草稿**创建时**就生成并持久化，重试复用同一个 key。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-webui/tests/drafts.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDraftStore, anchorKeyOf, type Draft } from "../src/drafts/draft-store.js";

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    draftId: "d1", documentId: "doc-1", anchorKey: "th-1", threadId: "th-1",
    location: null, baseVersionIdx: 0, text: "写了一半",
    idempotencyKey: "key-1", editedFromPingIdx: null, updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createDraftStore", () => {
  beforeEach(() => localStorage.clear());

  it("保存后能读回来", () => {
    const store = createDraftStore(localStorage);
    store.save(draft());

    expect(store.list()).toEqual([draft()]);
  });

  it("跨实例持久化（模拟刷新）", () => {
    createDraftStore(localStorage).save(draft());

    expect(createDraftStore(localStorage).list()).toHaveLength(1);
  });

  it("同一锚点可以并存多份", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ draftId: "d1", text: "第一份" }));
    store.save(draft({ draftId: "d2", idempotencyKey: "key-2", text: "第二份" }));

    expect(store.listForDocument("doc-1")).toHaveLength(2);
    expect(store.countForDocument("doc-1")).toBe(2);
  });

  it("同 draftId 覆盖而不是追加", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ text: "一稿" }));
    store.save(draft({ text: "二稿" }));

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].text).toBe("二稿");
  });

  it("覆盖时保留原 idempotencyKey", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ idempotencyKey: "key-1" }));
    store.save({ ...draft({ text: "改了" }), idempotencyKey: "key-1" });

    expect(store.list()[0].idempotencyKey).toBe("key-1");
  });

  it("remove 只删指定一份", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ draftId: "d1" }));
    store.save(draft({ draftId: "d2", idempotencyKey: "key-2" }));

    store.remove("d1");

    expect(store.list().map((item) => item.draftId)).toEqual(["d2"]);
  });

  it("按文档隔离", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ draftId: "d1", documentId: "doc-1" }));
    store.save(draft({ draftId: "d2", documentId: "doc-2", idempotencyKey: "key-2" }));

    expect(store.listForDocument("doc-1")).toHaveLength(1);
  });

  it("存储里是坏数据时当作空，不抛错", () => {
    localStorage.setItem("unidocs.portal.drafts.v1", "{ 不是 JSON");

    expect(createDraftStore(localStorage).list()).toEqual([]);
  });

  it("storage 抛异常（无痕模式）时退化为内存，不影响写入", () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    } as unknown as Storage;
    const store = createDraftStore(throwing);

    store.save(draft());

    expect(store.list()).toHaveLength(1);
  });
});

describe("anchorKeyOf", () => {
  it("已有 thread 用 threadId", () => {
    expect(anchorKeyOf({ threadId: "th-1", location: null })).toBe("thread:th-1");
  });

  it("新评论用 location 的稳定摘要", () => {
    const location = { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 3, end: 9, quote: "一段话" } };

    expect(anchorKeyOf({ threadId: null, location })).toBe(anchorKeyOf({ threadId: null, location: { ...location } }));
  });

  it("不同位置得到不同 key", () => {
    const a = { documentContractIdx: 0, locationType: "t", payload: { start: 0, end: 1, quote: "a" } };
    const b = { documentContractIdx: 0, locationType: "t", payload: { start: 5, end: 6, quote: "b" } };

    expect(anchorKeyOf({ threadId: null, location: a })).not.toBe(anchorKeyOf({ threadId: null, location: b }));
  });
});
```

倒数第二、三条防的是**草稿丢失**——localStorage 在无痕模式或被策略禁用时会抛异常，草稿是用户写的字，不能因为存储不可用就消失。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: FAIL — `Cannot find module '../src/drafts/draft-store.js'`

- [ ] **Step 3: 写 store**

`packages/tenant-portal-webui/src/drafts/draft-store.ts`：

```ts
/**
 * 未发送的评论是草稿：只在本地，Agent 看不到。每个位置一份、可以同时存多份，
 * 写到一半切去看别处不会丢（tenant-webui-v0.md §2.7）。
 */
import type { DocumentLocation, VersionIdx } from "@unidocs/protocol-platform";

const STORAGE_KEY = "unidocs.portal.drafts.v1";

export interface Draft {
  readonly draftId: string;
  readonly documentId: string;
  /** 同一锚点的草稿归为一组；见 anchorKeyOf。 */
  readonly anchorKey: string;
  /** 追加到已有一处时是 threadId；新评论时为 null。 */
  readonly threadId: string | null;
  readonly location: DocumentLocation | null;
  readonly baseVersionIdx: VersionIdx;
  readonly text: string;
  /** 创建时生成并持久化；发送失败重试时复用，真后端接上时幂等天然成立。 */
  readonly idempotencyKey: string;
  /** 「改自评论 N」：这份草稿改自哪一条已发送的评论。 */
  readonly editedFromPingIdx: number | null;
  readonly updatedAt: string;
}

export interface DraftStore {
  list(): readonly Draft[];
  listForDocument(documentId: string): readonly Draft[];
  countForDocument(documentId: string): number;
  save(draft: Draft): void;
  remove(draftId: string): void;
}

export function anchorKeyOf(input: { threadId: string | null; location: DocumentLocation | null }): string {
  if (input.threadId !== null) return `thread:${input.threadId}`;
  if (input.location === null) return "document";
  return `location:${input.location.locationType}:${JSON.stringify(input.location.payload)}`;
}

export function createDraftStore(storage: Storage): DraftStore {
  // storage 可能抛异常（无痕模式、站点存储被禁用）。草稿是用户写的字，
  // 存不进去也不能丢——退化为内存副本，本次会话内仍然可用。
  let cache: Draft[] = read();

  function read(): Draft[] {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Draft[]) : [];
    } catch {
      return [];
    }
  }

  function write(drafts: Draft[]): void {
    cache = drafts;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    } catch {
      // 只保留内存副本。
    }
  }

  return {
    list: () => cache,
    listForDocument: (documentId) => cache.filter((draft) => draft.documentId === documentId),
    countForDocument: (documentId) => cache.filter((draft) => draft.documentId === documentId).length,

    save(draft) {
      const existing = cache.find((candidate) => candidate.draftId === draft.draftId);
      const merged: Draft = existing === undefined
        ? draft
        : { ...draft, idempotencyKey: existing.idempotencyKey };
      write([...cache.filter((candidate) => candidate.draftId !== draft.draftId), merged]);
    },

    remove(draftId) {
      write(cache.filter((candidate) => candidate.draftId !== draftId));
    },
  };
}
```

`save` 在覆盖时**强制保留原 `idempotencyKey`**：用户改了几轮文字仍是同一次发送意图，换 key 会让失败重试在真后端变成两条 ping。

- [ ] **Step 4: 写 hook**

`packages/tenant-portal-webui/src/drafts/use-drafts.ts`：

```ts
import { useCallback, useMemo, useState } from "react";
import { anchorKeyOf, createDraftStore, type Draft } from "./draft-store.js";

export interface DraftsApi {
  readonly drafts: readonly Draft[];
  readonly count: number;
  draftsForAnchor(anchorKey: string): readonly Draft[];
  saveDraft(input: {
    draftId?: string;
    threadId: string | null;
    location: Draft["location"];
    baseVersionIdx: number;
    text: string;
    editedFromPingIdx?: number | null;
  }): Draft;
  removeDraft(draftId: string): void;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function useDrafts(documentId: string): DraftsApi {
  const store = useMemo(() => createDraftStore(globalThis.localStorage), []);
  const [epoch, setEpoch] = useState(0);

  const drafts = useMemo(
    () => store.listForDocument(documentId),
    // epoch 参与依赖，让写入后重新读一遍。
    [store, documentId, epoch],
  );

  const saveDraft = useCallback<DraftsApi["saveDraft"]>((input) => {
    const draftId = input.draftId ?? newId();
    const draft: Draft = {
      draftId,
      documentId,
      anchorKey: anchorKeyOf({ threadId: input.threadId, location: input.location }),
      threadId: input.threadId,
      location: input.location,
      baseVersionIdx: input.baseVersionIdx,
      text: input.text,
      idempotencyKey: newId(),
      editedFromPingIdx: input.editedFromPingIdx ?? null,
      updatedAt: new Date().toISOString(),
    };
    store.save(draft);
    setEpoch((value) => value + 1);
    return store.list().find((candidate) => candidate.draftId === draftId) ?? draft;
  }, [store, documentId]);

  const removeDraft = useCallback((draftId: string) => {
    store.remove(draftId);
    setEpoch((value) => value + 1);
  }, [store]);

  return {
    drafts,
    count: drafts.length,
    draftsForAnchor: (anchorKey) => drafts.filter((draft) => draft.anchorKey === anchorKey),
    saveDraft,
    removeDraft,
  };
}
```

`saveDraft` 返回的是 `store.list()` 里的那一份而不是刚构造的 `draft`——因为 store 在覆盖时会把 `idempotencyKey` 换回原值，调用方拿到的必须是真正生效的那份。

- [ ] **Step 5: 运行确认通过并提交**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: PASS，新增 12 个测试。

```bash
git add packages/tenant-portal-webui
git commit -m "feat(portal): keep unsent comments as local drafts"
```

---

## Task 15: 评论发送、追加、「改自评论 N」与错误重试

**Files:**
- Create: `packages/tenant-portal-webui/src/panel/composer.tsx`
- Create: `packages/tenant-portal-webui/src/panel/draft-block.tsx`
- Create: `packages/tenant-portal-webui/src/model/send-comment.ts`
- Create: `packages/tenant-portal-webui/src/error-text.ts`
- Modify: `packages/tenant-portal-webui/src/panel/thread-panel.tsx`
- Modify: `packages/tenant-portal-webui/src/panel/thread-card.tsx`
- Modify: `packages/tenant-portal-webui/src/pages/document.tsx`
- Modify: `packages/tenant-portal-webui/src/pages/workbench.tsx`
- Modify: `packages/tenant-portal-webui/src/view/view-host.tsx`
- Test: `packages/tenant-portal-webui/tests/comment-flow.test.tsx`

**Interfaces:**
- Consumes: Task 14 的 `useDrafts`、Task 12 的 `useDocumentSession`、Task 8 的 `HostImplementation`。
- Produces: `Composer`、`DraftBlock`、`sendDraft(client, documentId, draft)`、`errorText(error)`。

对应 §2.6、§2.7 与 spec §6.3、§7。

- [ ] **Step 1: 写失败的测试**

`packages/tenant-portal-webui/tests/comment-flow.test.tsx`：

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryStore, createMemoryTransport, createScriptedAgent, createTenantPortalClient, sampleSeed,
} from "@unidocs/tenant-portal-client";
import { ClientProvider } from "../src/client-context.js";
import { DocumentPage } from "../src/pages/document.js";

function setup(threadId?: string) {
  const store = createMemoryStore(sampleSeed());
  const agent = createScriptedAgent({ store });
  const client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ store }) });
  const view = render(
    <ClientProvider client={client}><DocumentPage documentId="doc-sample" threadId={threadId} /></ClientProvider>,
  );
  return { store, agent, client, view };
}

const panel = () => screen.findByRole("complementary", { name: "讨论" });

describe("评论流程", () => {
  beforeEach(() => { localStorage.clear(); window.location.hash = ""; });

  it("面板上没有常驻输入框", async () => {
    setup("th-open");
    expect(within(await panel()).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("点回复才出输入框，取消后收起", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    expect(within(p).getByRole("textbox", { name: "回复这一处" })).toBeInTheDocument();

    await userEvent.click(within(p).getByRole("button", { name: "取消" }));
    expect(within(p).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("发送后追加为该处的新一条，并且该处变回待回复", async () => {
    const { store } = setup("th-answered");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "还想再改一处");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    expect(await within(p).findByText("还想再改一处")).toBeInTheDocument();
    expect(store.getThread("doc-sample", "th-answered").pings).toHaveLength(2);
    expect(within(p).getAllByText("待回复").length).toBeGreaterThan(0);
  });

  it("发送成功后草稿被清掉", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "补一句");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    await within(p).findByText("补一句");
    expect(within(p).queryByText(/条未发送/)).not.toBeInTheDocument();
  });

  it("写到一半切去看别处不会丢，并计入「N 条未发送」", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "写了一半");
    await userEvent.click(within(p).getByRole("button", { name: /这一节改得不错/ }));

    expect(within(p).getByText("1 条未发送")).toBeInTheDocument();
  });

  it("未发送筛选只留有草稿的一处，草稿显示为黄色虚线块", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "半截话");
    await userEvent.click(within(p).getByRole("button", { name: "未发送" }));

    const blocks = within(p).getAllByRole("note", { name: "未发送的评论" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveTextContent("半截话");
  });

  it("已发送的评论不可编辑不可删除，只有「修改」", async () => {
    setup("th-open");
    const p = await panel();

    expect(within(p).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(within(p).getByRole("button", { name: "修改" })).toBeInTheDocument();
  });

  it("点修改把原文压回草稿并注明改自哪一条，原评论留在原地", async () => {
    setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "修改" }));

    expect(within(p).getByRole("note", { name: "未发送的评论" })).toHaveTextContent("改自评论 1");
    expect(within(p).getByText("这一句还能再收紧吗？")).toBeInTheDocument();
  });

  it("水位未覆盖的已发送评论标为正在执行", async () => {
    setup("th-open");
    const p = await panel();

    expect(within(p).getByText("正在执行")).toBeInTheDocument();
  });

  it("水位已覆盖的已发送评论标为已处理", async () => {
    setup("th-answered");
    const p = await panel();

    expect(within(p).getByText("已处理")).toBeInTheDocument();
  });

  it("改后发送是同一处的新一条，不覆盖原评论", async () => {
    const { store } = setup("th-open");
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "修改" }));
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    const thread = store.getThread("doc-sample", "th-open");
    expect(thread.pings).toHaveLength(2);
    expect(thread.pings[0].content.text).toBe("这一句还能再收紧吗？");
  });

  it("发送失败时保留草稿并给出中文说明与重试", async () => {
    const store = createMemoryStore(sampleSeed());
    let failNext = true;
    const inner = createMemoryTransport({ store });
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: async (request) => {
        if (failNext && request.method === "POST") {
          failNext = false;
          return { ok: false, error: { error: { code: "limit_exceeded", message: "too many", requestId: "r1" } } };
        }
        return inner(request);
      },
    });
    render(<ClientProvider client={client}><DocumentPage documentId="doc-sample" threadId="th-open" /></ClientProvider>);
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "会失败一次");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));

    expect(await within(p).findByRole("alert")).toHaveTextContent("操作太频繁");
    expect(within(p).getByRole("note", { name: "未发送的评论" })).toHaveTextContent("会失败一次");

    await userEvent.click(within(p).getByRole("button", { name: "重试" }));

    expect(await within(p).findByText("会失败一次")).toBeInTheDocument();
    expect(store.getThread("doc-sample", "th-open").pings).toHaveLength(2);
  });

  it("重试复用同一个 idempotencyKey", async () => {
    const store = createMemoryStore(sampleSeed());
    const keys: string[] = [];
    const inner = createMemoryTransport({ store });
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: async (request) => {
        if (request.idempotencyKey !== undefined) keys.push(request.idempotencyKey);
        if (keys.length === 1) return { ok: false, error: { error: { code: "limit_exceeded", message: "x", requestId: "r1" } } };
        return inner(request);
      },
    });
    render(<ClientProvider client={client}><DocumentPage documentId="doc-sample" threadId="th-open" /></ClientProvider>);
    const p = await panel();

    await userEvent.click(within(p).getByRole("button", { name: "回复" }));
    await userEvent.type(within(p).getByRole("textbox", { name: "回复这一处" }), "重试用同 key");
    await userEvent.click(within(p).getByRole("button", { name: "发送" }));
    await within(p).findByRole("alert");
    await userEvent.click(within(p).getByRole("button", { name: "重试" }));

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("依然没有解决、重新打开或批量提交", async () => {
    setup("th-open");
    const p = await panel();

    expect(within(p).queryByRole("button", { name: /解决/ })).not.toBeInTheDocument();
    expect(within(p).queryByRole("button", { name: /重新打开/ })).not.toBeInTheDocument();
    expect(within(p).queryByRole("button", { name: /提交.*条/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @unidocs/tenant-portal-webui test`
Expected: FAIL — 找不到「回复」按钮。

- [ ] **Step 3: 写错误文案与发送**

`packages/tenant-portal-webui/src/error-text.ts`：

```ts
/**
 * 错误码映射成中文文案。不要把 code 弹给用户（spec §7）。
 */
import { PlatformError } from "@unidocs/tenant-portal-client";

const TEXT: Readonly<Record<string, string>> = {
  version_conflict: "当前版本已经变了，请刷新后再试。",
  pong_watermark_conflict: "Agent 正在处理这一处，请稍后再试。",
  idempotency_conflict: "这条评论已经用另一份内容发送过了，请新写一条。",
  not_found: "这件作品或这一处已经不存在了。",
  forbidden: "你没有访问这件作品的权限。",
  unauthorized: "登录已失效，请重新登录。",
  limit_exceeded: "操作太频繁，请稍后再试。",
  invalid_request: "这条评论没能被接受，请检查内容后重试。",
  location_contract_violation: "这个位置在当前文档类型下不被接受。",
  content_unavailable: "内容暂时读不到，请稍后再试。",
  transport_failure: "网络不通，请检查连接后重试。",
};

export function errorText(error: unknown): string {
  if (error instanceof PlatformError) return TEXT[error.code] ?? "操作没有成功，请稍后再试。";
  return "操作没有成功，请稍后再试。";
}
```

`packages/tenant-portal-webui/src/model/send-comment.ts`：

```ts
/**
 * 把一份草稿发送成 ping。新评论建 thread，追加评论走 appendPing。
 * 两条路径都带草稿自己的 idempotencyKey——重试不会产生第二条。
 */
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import type { Draft } from "../drafts/draft-store.js";

export async function sendDraft(
  client: TenantPortalClient,
  documentId: string,
  draft: Draft,
): Promise<void> {
  const content = { text: draft.text, richContent: null, attachments: [] };

  if (draft.threadId === null) {
    await client.createThread(documentId, draft.idempotencyKey, {
      baseVersionIdx: draft.baseVersionIdx,
      content,
      location: draft.location,
    });
    return;
  }

  await client.appendPing(documentId, draft.threadId, draft.idempotencyKey, {
    baseVersionIdx: draft.baseVersionIdx,
    content,
    location: draft.location,
  });
}
```

- [ ] **Step 4: 写 Composer 与 DraftBlock**

`packages/tenant-portal-webui/src/panel/composer.tsx`：

```tsx
import { useState } from "react";

export function Composer(props: {
  label: string;
  initialText?: string;
  onSend(text: string): void;
  onCancel(): void;
  onChange?(text: string): void;
}) {
  const [text, setText] = useState(props.initialText ?? "");

  return (
    <div className="composer">
      <textarea
        aria-label={props.label}
        value={text}
        autoFocus
        onChange={(event) => { setText(event.target.value); props.onChange?.(event.target.value); }}
      />
      <div className="composer-actions">
        <button type="button" onClick={() => props.onSend(text)} disabled={text.trim() === ""}>发送</button>
        <button type="button" onClick={props.onCancel}>取消</button>
      </div>
    </div>
  );
}
```

`packages/tenant-portal-webui/src/panel/draft-block.tsx`：

```tsx
import type { Draft } from "../drafts/draft-store.js";

export function DraftBlock(props: {
  draft: Draft;
  failure: string | null;
  onRetry(): void;
  onDiscard(): void;
}) {
  return (
    <div className="draft-block" role="note" aria-label="未发送的评论">
      {props.draft.editedFromPingIdx !== null && (
        <p className="draft-origin">改自评论 {props.draft.editedFromPingIdx + 1}</p>
      )}
      <p className="draft-text">{props.draft.text}</p>
      {props.failure !== null && <p role="alert">{props.failure}</p>}
      <div className="draft-actions">
        <button type="button" onClick={props.onRetry}>{props.failure === null ? "发送" : "重试"}</button>
        <button type="button" onClick={props.onDiscard}>丢弃</button>
      </div>
    </div>
  );
}
```

`改自评论 {editedFromPingIdx + 1}` 用 1 起的序号——`pingIdx` 从 0 开始是协议的事，界面上「改自评论 1」比「改自评论 0」可读。

- [ ] **Step 5: 接进面板与卡片**

`ThreadCard` 新增 props 并在展开时渲染：已发送评论的执行状态徽标（`props.state.acknowledgedPingIdx >= ping.pingIdx ? "已处理" : "正在执行"`）、「修改」按钮、「回复」按钮、该处的草稿块。`ThreadPanel` 新增「未发送」筛选档与顶部「N 条未发送」。`DocumentPage` 把 `useDrafts` 与 `sendDraft` 串起来，发送成功后调 `session.reload()`。

具体接法：

```tsx
// thread-card.tsx —— PingCard 增加状态徽标与「修改」
export function PingCard(props: {
  ping: PingRecord;
  currentVersionIdx: VersionIdx | null;
  acknowledged: boolean;
  selected?: boolean;
  onSelect?(): void;
  onEdit?(): void;
}) {
  const behind = props.currentVersionIdx === null ? 0 : props.currentVersionIdx - props.ping.baseVersionIdx;

  return (
    <li className={`ping-card${props.selected === true ? " selected" : ""}`}>
      <button type="button" onClick={props.onSelect}>
        <p>{props.ping.content.text}</p>
        <footer>
          <span className="version-badge">v{props.ping.baseVersionIdx}</span>
          {behind > 0 && <span className="behind">基于 v{props.ping.baseVersionIdx} · 已过 {behind} 版</span>}
          <span className="ping-status">{props.acknowledged ? "已处理" : "正在执行"}</span>
        </footer>
      </button>
      {/* 已发送的评论不可编辑也不可删除：只提供「修改」，它会压回一份新草稿。 */}
      <button type="button" className="ping-edit" onClick={props.onEdit}>修改</button>
    </li>
  );
}
```

`ThreadCard` 在展开区末尾追加：

```tsx
          {props.drafts.map((draft) => (
            <li key={draft.draftId}>
              <DraftBlock
                draft={draft}
                failure={props.draftFailures[draft.draftId] ?? null}
                onRetry={() => props.onSendDraft(draft)}
                onDiscard={() => props.onDiscardDraft(draft.draftId)}
              />
            </li>
          ))}
          <li>
            {props.composing
              ? <Composer
                  label="回复这一处"
                  initialText={props.composingInitialText}
                  onChange={props.onComposeChange}
                  onSend={props.onComposeSend}
                  onCancel={props.onComposeCancel}
                />
              : <button type="button" onClick={props.onComposeOpen}>回复</button>}
          </li>
```

`ThreadPanel` 的筛选项改为：

```tsx
const FILTERS: readonly { value: ThreadFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "open", label: "待回复" },
  { value: "answered", label: "已回复" },
  { value: "unsent", label: "未发送" },
];
```

`unsent` 档只留下有草稿的一处；面板顶部在 `draftCount > 0` 时渲染 `<p className="draft-count">{draftCount} 条未发送</p>`。

`DocumentPage` 里的状态与回调：

```tsx
  const drafts = useDrafts(props.documentId);
  const [composingThreadId, setComposingThreadId] = useState<string | null>(null);
  const [composeDraftId, setComposeDraftId] = useState<string | null>(null);
  const [draftFailures, setDraftFailures] = useState<Record<string, string>>({});

  const send = async (draft: Draft) => {
    try {
      await sendDraft(client, props.documentId, draft);
      drafts.removeDraft(draft.draftId);
      setDraftFailures(({ [draft.draftId]: _removed, ...rest }) => rest);
      session.reload();
    } catch (cause) {
      // 失败一律保留草稿，复用原 idempotencyKey 重试。
      setDraftFailures((previous) => ({ ...previous, [draft.draftId]: errorText(cause) }));
    }
  };
```

「修改」的回调（§2.7 第 2 步）：

```tsx
  const editFrom = (threadId: string, ping: PingRecord) => {
    const draft = drafts.saveDraft({
      threadId,
      location: ping.location,
      baseVersionIdx: session.document!.currentVersionIdx ?? ping.baseVersionIdx,
      text: ping.content.text ?? "",
      editedFromPingIdx: ping.pingIdx,
    });
    setComposeDraftId(draft.draftId);
  };
```

新草稿的 `baseVersionIdx` 取 **current**，不是原 ping 的基版——这是一条新评论，它基于用户此刻看到的版本。

「回复」输入过程中每次 `onChange` 都调 `drafts.saveDraft({ draftId: composeDraftId ?? undefined, ... })` 并把返回的 `draftId` 记下来，这样切走也不丢（§2.7）。

- [ ] **Step 6: 接上 View 的「添加评论」**

`ViewHost` 的 `host` 现在要能真的建 thread。`DocumentPage` 传入：

```tsx
  const viewHost: HostImplementation = useMemo(() => ({
    ...noopHost,
    createThread: async (request) => client.createThread(props.documentId, crypto.randomUUID(), request),
  }), [client, props.documentId]);
```

先把 `view-host.tsx` 里的 `noopHost` 改成 `export const noopHost`，再在 `document.tsx` 里
`import { noopHost, ViewHost } from "../view/view-host.js"`。选区上方浮出「添加评论」的浮层由 `MarkdownView` 自己管（它持有容器与 `selectionRange()`）——本轮的最小实现是：`MarkdownView` 在容器上监听 `mouseup`，有非空选区且 `selectionRange()` 非 null 时插入一个浮动按钮，点击后调 `host.createThread`。这条路径的测试因 jsdom 的 Selection 支持有限而**不在本 task 的自动化范围**，改为在 Step 8 做一次浏览器手工验证并记录结果。

- [ ] **Step 7: 工作台卡片显示未发送条数**

`WorkbenchPage` 里为每件作品读一次草稿数：

```tsx
import { createDraftStore } from "../drafts/draft-store.js";

const draftStore = useMemo(() => createDraftStore(globalThis.localStorage), []);
// 卡片 footer：
<footer>
  {discussionLabel(entry.summary)}
  {draftStore.countForDocument(entry.document.documentId) > 0 && (
    <span className="draft-count">{draftStore.countForDocument(entry.document.documentId)} 条未发送</span>
  )}
</footer>
```

- [ ] **Step 8: 加样式、跑测试、手工验证、提交**

`packages/tenant-portal-webui/src/pages/document.css` 追加：

```css
.composer { display: grid; gap: 6px; }
.composer textarea { width: 100%; min-height: 64px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; font: inherit; resize: vertical; }
.composer-actions { display: flex; gap: 6px; }

.draft-block { padding: 10px; border: 1px dashed var(--accent-draft); border-radius: 6px; background: color-mix(in srgb, var(--accent-draft) 8%, transparent); }
.draft-origin { margin: 0 0 4px; color: var(--accent-draft); font-size: 12px; }
.draft-text { margin: 0 0 6px; }
.draft-actions { display: flex; gap: 6px; }
.draft-count { color: var(--accent-draft); font-size: 12px; }
.ping-status { color: var(--text-muted); }
.ping-edit { border: 0; background: none; color: var(--text-muted); font-size: 12px; cursor: pointer; padding: 0 10px 10px; }
```

Run: `pnpm --filter @unidocs/tenant-portal-webui test && pnpm typecheck && pnpm --filter @unidocs/tenant-portal-client test`
Expected: 全部 PASS。

手工验证（Step 6 里未自动化的那条路径），跑 `pnpm --filter @unidocs/tenant-portal-webui dev` 后在浏览器里逐项确认并把结果写进提交信息：

1. 在 current 正文里选中一段 → 选区上方浮出「添加评论」→ 输入并发送 → 该处出现在面板「待回复」。
2. 刷新页面 → 未发送的草稿仍在，「N 条未发送」计数正确。
3. 1440 宽下分屏三栏不横向溢出；窄于 760px 显示「请在电脑或平板上查看」。

```bash
git add packages/tenant-portal-webui
git commit -m "feat(portal): send, append, and revise comments with local drafts"
```

---

## Self-Review 记录

**Spec 覆盖核对**（spec 章节 → task）：

| spec | task |
| --- | --- |
| §2.1 client 与两个 transport | 1、2、4、5 |
| §2.1 脚本化 Agent 与样本数据 | 6 |
| §2.2 webui 包与栈 | 7 |
| §3 ViewChannel / 本地 adapter | 8、9 |
| §3.1 两个评论入口的归属 | 15 |
| §3.2 marker role 本地类型 | 8 |
| §3.3 讨论计数 N+1 | 10 |
| §4.1 分屏布局、§4.2 右栏四种 | 10、13 |
| §5 页面与组件分解 | 11、12、13、15 |
| §6.1 thread 状态纯派生 | 10 |
| §6.2 草稿、§6.3 已发送不可改 | 14、15 |
| §7 错误与空状态 | 11、12、15 |
| §8 测试策略 | 每个 task 的测试步骤 |
| §9 交付切分 | 15 个 task 对应 6 个 PR：1–3 / 4–6 / 7–8+9 / 10–11 / 12–13 / 14–15 |

**已知偏差（与 spec 不一致，以本计划为准）：**

- spec §2.2 写「tsconfig 加入根 `tsconfig.json` 的 `references`」，对 webui 是错的——`@unidocs/web-gateway` 也没进，应用包是 `noEmit` 不是 composite，`tsc -b` 拉不动。Task 1 只把 **client** 加进 references。
- spec §3 的 Host RPC 图漏了 `host.storeBlob`，Task 8 的 `HostImplementation` 六个方法齐全。

**待实施时修正的两处计划内缺陷：**

- Task 10 的 `decideRightPane` 里 `pong-result` 分支写成了 `.map(...).map(...)` 且带一个恒为 0 的 `index * 0`，是多余的。实施时写成一次 map 即可：

```ts
      markers: latest.resultLocations.map((location) => ({
        threadId: "", pingIdx: ping.pingIdx, open: false, location, role: "pong-result" as const,
      })),
```

- Task 6 的 seed 要求删掉 Task 4 `loadDocument` 里那两行 `appendVersion`。实施 Task 4 时可以直接不写它们，`SeedPong.producesContent` 从一开始就只用于 Agent 运行时。
