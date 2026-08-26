/**
 * 一个 doc type 的 Azure/Node 服务入口。
 *
 * Cloudflare 那边每个 doc type 有一个 `worker.ts` 导出两个 Durable Object
 * 类；这里没有 DO 运行时，所以每个 doc type 起一个无状态 Node 进程。
 * 这些进程之间**唯一的差别**是 `docType` 字符串和 `DocumentType` 实现 ——
 * 其余（连接池、Blob 客户端、端口构造、每请求新建 session、CAS 接线、
 * 关停）在这里，只有一份。
 *
 * 这份代码曾经逐字住在 `azure-markdown/src/main.ts` 里。把它提到这里的
 * 直接原因是 `local-editor.ts` 携带的多副本不变量（每请求新建 session）——
 * 复制那条规则等于制造一条「只改一边就能悄悄产生数据损坏」的路径。
 */
import type { DocumentTypeFactory } from "@unidocs/protocol";
import {
  CasClient,
  type HttpFetcher,
} from "@unicas/client";
import type {
  DocCapabilityVerifier,
  DocInternalAuthMode,
  SessionDeps,
  SessionIdentity,
} from "@unidocs/doctype-server-common";
import {
  createDocTypeHandler,
  createSBlobContext,
  DocAuthConfigCache,
} from "@unidocs/doctype-server-common";
import { attachPoolErrorLogger, requireEnv, resolveBlobConfig } from "./env.js";
import {
  createLocalEditorNamespace,
  createStubOperatorNamespace,
  type PrivateDocRequestContext,
} from "./local-editor.js";
import { BlobCasStore, BlobSnapshotCache } from "./ports-blob.js";
import { PgDeltaLog, PgSessionIdentityStore, PgUnitOfWork } from "./ports-pg.js";
import { createBlobService, createPool } from "./pool.js";
import { serve } from "./http-shell.js";

export interface DocTypeServiceConfig {
  databaseUrl: string;
  blobConnectionString?: string;
  /** 云上模式：Blob 账户端点 URL，与 `blobConnectionString` 互斥。 */
  blobAccountUrl?: string;
  internalAuthMode: DocInternalAuthMode;
  serviceAccessKey?: string;
  docCapabilityVerifier?: DocCapabilityVerifier;
  casCapabilityVerifier?: DocCapabilityVerifier;
    casAccessKey?: string; // Make CAS access key optional for CAS-less local services
  /**
   * 过渡形态（阶段 4 删除）：指向 Cloudflare CAS worker 的基地址。
   * 注意它必须指向 CAS worker 本身，不能指向 gateway —— `CasClient`
   * 的 `updateRootRefs` 打的是 `${origin}/_internal/root-refs`，
  * gateway 不代理 `/_internal/*`。
   * 未给时 CAS 调用一律 501（markdown 的 TDoc/ops 不含 SBlob，
   * 不给它配 CAS 是正确的默认）。
   */
  casBaseUrl?: string;
  /**
   * 栈模式：注册的 azure 栈命名空间。设置后 CasClient 的 capability
   * 模式走规范路由 `/stacks/{stackId}/tenants/{tenantId}/...`，
   * `casBaseUrl` 指向本地/线上中间件端点而非 legacy CAS worker。
   */
  casStackId?: string;
}

export interface DocTypeServiceOptions<TDoc, TQuery, TOp> {
  docType: string;
  documentTypeFactory: DocumentTypeFactory<TDoc, TQuery, TOp>;
  port: number;
  host?: string;
  config: DocTypeServiceConfig;
}

export interface DocTypeServiceHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * 过渡形态（阶段 4 删除）：把 CasClient 在 fetcher 模式下生成的假源
 * (`https://cas.internal`)重写到真实的 CAS worker 基地址，其余原样转发。
 *
 * 之所以走 fetcher 而不是 CasClient 的 baseUrl 模式：baseUrl 模式发的是
 * `Authorization: Bearer`，而 CAS worker 的内部路由认的是 `X-Internal-Token`
 * 与 `X-Tenant-Id` —— 那两个头只有 fetcher 模式会发。之前这里用的是
 * 旧实现错误地选择了 baseUrl 分支：
 * CAS access key 在那个分支上没有对应字段，`authToken` 又没给，结果是
 * 一个鉴权头都不发，TypeScript 因为联合类型的另一个成员里存在
 * 旧联合类型因字段重叠而没有报错。
 */
function httpCasFetcher(baseUrl: string): HttpFetcher {
  const origin = baseUrl.replace(/\/$/, "");
  return {
    fetch: (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      return fetch(`${origin}${url.pathname}${url.search}`, req);
    },
  };
}

export async function startDocTypeService<TDoc, TQuery, TOp>(
  options: DocTypeServiceOptions<TDoc, TQuery, TOp>,
): Promise<DocTypeServiceHandle> {
  const { docType, documentTypeFactory, port, config } = options;
  const host = options.host ?? "0.0.0.0";

  const pool = createPool(config);
  attachPoolErrorLogger(pool, `azure-${docType}`);
  const blobService = createBlobService(config);
  const sessionIdentities = new PgSessionIdentityStore(pool);

  // 过渡形态（阶段 4 删除）。
  const casStubFetcher = {
    fetch: async () =>
      Response.json({ error: "CAS is not implemented on Azure yet" }, { status: 501 }),
  };

  function buildSession(
    identity: SessionIdentity,
    requestContext: PrivateDocRequestContext,
  ): {
    documentType: ReturnType<DocumentTypeFactory<TDoc, TQuery, TOp>>;
    deps: SessionDeps;
  } {
    const cas = requestContext.authKind === "capability"
      ? requestContext.delegatedCasCapability
        ? new CasClient({
          fetcher: config.casBaseUrl ? httpCasFetcher(config.casBaseUrl) : casStubFetcher,
          tenantId: identity.tenantId,
          sessionId: identity.sessionId,
          capability: requestContext.delegatedCasCapability,
          ...(config.casStackId === undefined ? {} : { stackId: config.casStackId }),
        })
        : unavailableCasGateway()
      : new CasClient({
        fetcher: config.casBaseUrl ? httpCasFetcher(config.casBaseUrl) : casStubFetcher,
        tenantId: identity.tenantId,
        accessKey: config.casAccessKey ?? "",
      });
    const context = createSBlobContext({
      ensureNode: (hash, content, contentType, refs) =>
        cas.ensureNode(hash, content, contentType, refs ? [...refs] : undefined),
      leaseExisting: (hash) => cas.leaseExisting(hash),
      metadata: (hash) => cas.metadata({ kind: "cas", hash }),
      read: (hash) => cas.read({ kind: "cas", hash }),
    });

    return {
      documentType: documentTypeFactory(context),
      deps: {
      deltas: new PgDeltaLog(pool, identity),
      snapshots: new BlobSnapshotCache(blobService, identity, `unidocs-${docType}-snapshots`),
      blobs: new BlobCasStore(blobService, `unidocs-${docType}-roots`),
      unitOfWork: new PgUnitOfWork(pool, identity),
      cas,
      identity,
      now: () => Date.now(),
      },
    };
  }

  const handler = createDocTypeHandler({
    docType,
    internalAuthMode: config.internalAuthMode,
    accessKey: config.serviceAccessKey,
    docCapabilityVerifier: config.docCapabilityVerifier,
    casCapabilityVerifier: config.casCapabilityVerifier,
    audit: event => console.log(JSON.stringify({ event: "doc_authentication", docType, ...event })),
    editor: createLocalEditorNamespace(buildSession, async (identity, creating) => {
      if (creating) await sessionIdentities.register(identity);
      const stored = await sessionIdentities.get(identity);
      if (!stored) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (stored.tenantId !== identity.tenantId || stored.docType !== identity.docType) {
        return Response.json({ error: "Session identity mismatch" }, { status: 403 });
      }
      return null;
    }),
    operator: createStubOperatorNamespace(),
  });

  const { close } = await serve(handler, { port, host });

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    async close() {
      await close();
      await pool.end();
    },
  };
}

function unavailableCasGateway(): CasClient {
  const unavailable = async (): Promise<never> => {
    throw new Error("This Doc operation has no delegated CAS authority");
  };
  return {
    read: unavailable,
    metadata: unavailable,
    store: unavailable,
    ensureNode: unavailable,
    leaseExisting: unavailable,
    updateRootRefs: unavailable,
  } as unknown as CasClient;
}

/**
 * 进程级入口：从环境变量取配置、起服务、装信号处理器。返回的 Promise
 * 只在收到 SIGINT/SIGTERM 并关停完成后 resolve。
 *
 * 迁移**不在**这里跑：`runMigrations()` 用 `import.meta.url` 定位
 * `migrations/*.sql`，而这些服务是 esbuild 打包后运行的，打包会把
 * `import.meta.url` 重写到 bundle 自己的位置。而且对 N 个横向扩展的
 * 副本每次启动都跑一遍迁移本身也不是想要的行为。迁移单独跑一次。
 */
export async function runDocTypeService<TDoc, TQuery, TOp>(options: {
  docType: string;
  documentTypeFactory: DocumentTypeFactory<TDoc, TQuery, TOp>;
  defaultPort: number;
}): Promise<void> {
  const { docType, documentTypeFactory, defaultPort } = options;
  const auth = new DocAuthConfigCache(docType).get(process.env);
  const casBaseUrl = process.env.CAS_BASE_URL;
  const casAccessKey = process.env.CAS_ACCESS_KEY;
  const stackMode = auth.internalAuthMode === "stack";
  if (casBaseUrl && !casAccessKey && !stackMode) {
    throw new Error("CAS_ACCESS_KEY is required when CAS_BASE_URL is configured");
  }
  const handle = await startDocTypeService({
    docType,
    documentTypeFactory,
    port: Number(process.env.PORT ?? defaultPort),
    config: {
      databaseUrl: requireEnv("DATABASE_URL"),
      ...resolveBlobConfig(),
      internalAuthMode: auth.internalAuthMode,
      serviceAccessKey: auth.accessKey,
      docCapabilityVerifier: auth.docCapabilityVerifier,
      casCapabilityVerifier: auth.casCapabilityVerifier,
      casAccessKey,
      casBaseUrl,
      casStackId: process.env.CAS_STACK_ID,
    },
  });
  console.log(`azure-${docType} CAS: mode=${auth.internalAuthMode} baseUrl=${process.env.CAS_BASE_URL ?? "(none)"} stackId=${process.env.CAS_STACK_ID ?? "(none)"}`);
  console.log(`azure-${docType} listening on ${handle.url}`);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`azure-${docType} received ${signal}, shutting down`);
      void handle.close().then(resolve);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
