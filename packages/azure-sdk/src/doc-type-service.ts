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
import type { DocumentType } from "@unidocs/core";
import {
  CasClient,
  createDocTypeHandler,
  type DocIdentity,
  type HttpFetcher,
  type SessionDeps,
} from "@unidocs/server-core";
import { attachPoolErrorLogger, requireEnv, resolveBlobConfig } from "./env.js";
import { createLocalEditorNamespace, createStubOperatorNamespace } from "./local-editor.js";
import { BlobCasStore, BlobSnapshotCache } from "./ports-blob.js";
import { PgDeltaLog, PgDocIndex, PgUnitOfWork } from "./ports-pg.js";
import { createBlobService, createPool } from "./pool.js";
import { serve } from "./http-shell.js";

export interface DocTypeServiceConfig {
  databaseUrl: string;
  blobConnectionString?: string;
  /** 云上模式：Blob 账户端点 URL，与 `blobConnectionString` 互斥。 */
  blobAccountUrl?: string;
  internalToken: string;
  /**
   * 过渡形态（阶段 4 删除）：指向 Cloudflare CAS worker 的基地址。
   * 注意它必须指向 CAS worker 本身，不能指向 gateway —— `CasClient`
   * 的 `updateRootRefs` 打的是 `${origin}/_internal/root-refs`，
   * gateway 只路由 `/users/...`，不代理 `/_internal/*`。
   * 未给时 CAS 调用一律 501（markdown 的 TDoc/ops 不含 SBlob，
   * 不给它配 CAS 是正确的默认）。
   */
  casBaseUrl?: string;
}

export interface DocTypeServiceOptions<TDoc, TQuery, TOp> {
  docType: string;
  documentType: DocumentType<TDoc, TQuery, TOp>;
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
 * 与 `X-User-Id` —— 那两个头只有 fetcher 模式会发。之前这里用的是
 * `{ baseUrl, userId, internalToken }`，选中的正是 baseUrl 分支：
 * `internalToken` 在那个分支上不存在对应字段，`authToken` 又没给，结果是
 * 一个鉴权头都不发，TypeScript 因为联合类型的另一个成员里存在
 * `internalToken` 而没有报错。
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
  const { docType, documentType, port, config } = options;
  const host = options.host ?? "0.0.0.0";

  const pool = createPool(config);
  attachPoolErrorLogger(pool, `azure-${docType}`);
  const blobService = createBlobService(config);

  // 过渡形态（阶段 4 删除）。
  const casStubFetcher = {
    fetch: async () =>
      Response.json({ error: "CAS is not implemented on Azure yet" }, { status: 501 }),
  };

  function buildDeps(identity: DocIdentity): SessionDeps {
    return {
      deltas: new PgDeltaLog(pool, identity),
      snapshots: new BlobSnapshotCache(blobService, identity),
      blobs: new BlobCasStore(blobService),
      index: new PgDocIndex(pool, identity),
      unitOfWork: new PgUnitOfWork(pool, identity),
      cas: new CasClient({
        fetcher: config.casBaseUrl ? httpCasFetcher(config.casBaseUrl) : casStubFetcher,
        userId: identity.userId,
        internalToken: config.internalToken,
      }),
      identity,
      now: () => Date.now(),
    };
  }

  const handler = createDocTypeHandler({
    docType,
    internalToken: config.internalToken,
    editor: createLocalEditorNamespace(documentType, buildDeps),
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
  documentType: DocumentType<TDoc, TQuery, TOp>;
  defaultPort: number;
}): Promise<void> {
  const { docType, documentType, defaultPort } = options;
  const handle = await startDocTypeService({
    docType,
    documentType,
    port: Number(process.env.PORT ?? defaultPort),
    config: {
      databaseUrl: requireEnv("DATABASE_URL"),
      ...resolveBlobConfig(),
      internalToken: requireEnv("INTERNAL_TOKEN"),
      casBaseUrl: process.env.CAS_BASE_URL,
    },
  });
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
