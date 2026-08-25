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
import type { DocumentType } from "@unidocs/protocol";
import {
  CasClient,
  type HttpFetcher,
} from "@unidocs/cas-client";
import type { DocIdentity, SessionDeps } from "@unidocs/doctype-server-common";
import { createDocTypeHandler } from "@unidocs/doctype-server-common";
import { attachPoolErrorLogger, requireEnv, resolveBlobConfig } from "./env.js";
import { createLocalEditorNamespace, createStubOperatorNamespace } from "./local-editor.js";
import { BlobCasStore, BlobSnapshotCache } from "./ports-blob.js";
import { PgDeltaLog, PgDocIndex, PgUnitOfWork } from "./ports-pg.js";
import { createBlobService, createPool } from "./pool.js";
import { PgDocTypeRegistry } from "./registry-pg.js";
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
 * 服务 listen 成功后,把自己 upsert 进 `doc_types` 注册表——或者,若
 * `SELF_WORKER_URL` 没设(本地栈没有 Container Apps,拿不到内部 FQDN),
 * 打一行日志跳过,本地继续走 `{TYPE}_WORKER_URL` 环境变量的兜底路径。
 *
 * 拆成独立、可导出的函数是为了可测性:`runDocTypeService()` 本身从
 * `process.env` 取配置、装 SIGINT/SIGTERM 处理器、返回的 Promise 只在收到
 * 信号后才 resolve——不适合直接在单元测试里调用。这里只做注册这一件事,
 * 输入输出都是显式参数/Promise,测试可以直接对着真实 Postgres 调用并查
 * `doc_types` 表验证。
 *
 * 两层失败都不致命,只记日志:
 * - `register()` 抛错(通常是 Postgres 抖动):这个副本已经 listen 成功、
 *   已经能正常处理请求了,一次注册表写入失败不代表它本身有问题。让进程
 *   崩溃重启并不能更快地重新注册——Container Apps 的重启退避通常比"等
 *   下一次部署/人工重启再试一次"更慢,反而制造了一次不必要的、真实存在
 *   的服务中断。日志把后果说清楚:注册没写进去,网关这段时间只能靠
 *   `{TYPE}_WORKER_URL` 环境变量兜底发现本服务;云上部署不设这个变量,
 *   所以网关会打不到这个副本,直到下次重启重试注册或人工介入。
 * - `registryPool.end()` 抛错:与"这个副本能不能服务请求"无关,单独
 *   catch 掉,不让它冒泡到顶层杀掉一个健康进程,也不会覆盖掉上面
 *   `register()` 的原始错误(那条已经在它自己的 catch 里记下来了)。
 *
 * 这里另建一条只用于注册的连接,而不是复用 `startDocTypeService` 内部的
 * 连接池:那个池没有从 handle 上暴露出来,为此改 `startDocTypeService`
 * 的签名会波及 `local-editor.ts` 及其调用方,超出本次改动范围。
 */
export async function registerSelfIfConfigured(options: {
  docType: string;
  databaseUrl: string;
  selfWorkerUrl: string | undefined;
}): Promise<void> {
  const { docType, databaseUrl, selfWorkerUrl } = options;
  if (!selfWorkerUrl) {
    console.log(`azure-${docType} SELF_WORKER_URL not set — skipping registry (local mode)`);
    return;
  }

  const registryPool = createPool({ databaseUrl });
  try {
    const registry = new PgDocTypeRegistry(registryPool);
    await registry.register(docType, selfWorkerUrl);
    console.log(`azure-${docType} registered at ${selfWorkerUrl}`);
  } catch (err) {
    console.error(
      `azure-${docType} failed to register at ${selfWorkerUrl} — the gateway will not ` +
        `discover this replica via the registry until a retry succeeds (falling back to ` +
        `{TYPE}_WORKER_URL if set); continuing to serve requests:`,
      err,
    );
  } finally {
    try {
      await registryPool.end();
    } catch (closeErr) {
      console.error(`azure-${docType} failed to close the registry pg connection:`, closeErr);
    }
  }
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
  const databaseUrl = requireEnv("DATABASE_URL");
  const handle = await startDocTypeService({
    docType,
    documentType,
    port: Number(process.env.PORT ?? defaultPort),
    config: {
      databaseUrl,
      ...resolveBlobConfig(),
      internalToken: requireEnv("INTERNAL_TOKEN"),
      casBaseUrl: process.env.CAS_BASE_URL,
    },
  });
  console.log(`azure-${docType} listening on ${handle.url}`);

  // 注册发生在服务真的 listen 之后:注册表反映的是「谁真的起来了」,不是
  // 「谁被部署过」。部署成功但进程起不来时,不该在表里留一行指向死地址。
  await registerSelfIfConfigured({
    docType,
    databaseUrl,
    selfWorkerUrl: process.env.SELF_WORKER_URL,
  });

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
