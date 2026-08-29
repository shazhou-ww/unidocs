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
import type { DocumentTypeFactory, SBlobReadRange, SBlobSource } from "@unidocs/protocol";
import {
  CasClientError,
  createTenantCasClient,
  type HttpFetcher,
} from "@unicas/tenant-client";
import { createCasBlobClient, leaseNodeContent } from "@unicas/tenant-blob-client";
import type { TenantCasClient } from "@unicas/tenant-client";
import type { CasBlobClient } from "@unicas/tenant-blob-client";
import type {
  DocCapabilityVerifier,
  SessionDeps,
  SessionIdentity,
} from "@unidocs/doctype-server-common";
import {
  createDocTypeHandler,
  createSBlobContext,
  DocAuthConfigCache,
  byteStreamFromReadableStream,
  readableStreamFromSBlobSource,
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
  docCapabilityVerifier: DocCapabilityVerifier;
  casCapabilityVerifier: DocCapabilityVerifier;
  /**
   * 过渡形态（阶段 4 删除）：指向 Cloudflare CAS worker 的基地址。
  * 注意它必须指向 CAS worker 本身，不能指向 gateway —— CAS client
   * 的 `updateRootRefs` 打的是 `${origin}/_internal/root-refs`，
  * gateway 不代理 `/_internal/*`。
   * 未给时 CAS 调用一律 501（markdown 的 TDoc/ops 不含 SBlob，
   * 不给它配 CAS 是正确的默认）。
   */
  casBaseUrl?: string;
  /** 单次上传字节上限;超过返回 413。undefined = 不限。 */
  maxUploadBytes?: number;
  /**
  * 栈模式：注册的 azure 栈命名空间。设置后 capability client
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
 * 过渡形态（阶段 4 删除）：把 CAS fetcher 使用的假源
 * (`https://cas.internal`)重写到真实的 CAS worker 基地址，其余原样转发。
 *
 * fetcher 把 client 生成的 canonical URL 重写到实际 CAS endpoint，同时
 * 保留请求级 Bearer capability。
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
    const delegatedCapability = requestContext.authKind === "capability"
      ? requestContext.delegatedCasCapability
      : undefined;
    const nodeCas = delegatedCapability === undefined
      ? unavailableCasGateway()
      : createTenantCasClient({
        baseUrl: "https://cas.internal",
        fetcher: config.casBaseUrl ? httpCasFetcher(config.casBaseUrl) : casStubFetcher,
        stackId: requireCasStackId(config.casStackId),
        tenantId: identity.tenantId,
        getToken: async () => delegatedCapability,
      });
    const cas = Object.freeze({ ...nodeCas, ...createCasBlobClient(nodeCas) });
    const context = createSBlobContext({
      leaseNodeContent: (hash, content, contentType, refs) =>
        leaseNodeContent(cas, hash, content, contentType, refs),
      leaseNode: (hash) => cas.leaseNode(hash),
      storeBlob: (source: SBlobSource) => cas.storeBlob(
        readableStreamFromSBlobSource(source),
        {
          contentType: source.contentType,
          ...("data" in source
            ? { size: source.data.length }
            : source.size === undefined ? {} : { size: source.size }),
        },
      ),
      statBlob: (hash) => cas.statBlob(hash),
      openBlob: async (hash, range?: SBlobReadRange) => byteStreamFromReadableStream(
        (await cas.openBlob(hash)).read(range),
      ),
    });

    return {
      documentType: documentTypeFactory(context),
      deps: {
        deltas: new PgDeltaLog(pool, identity),
        snapshots: new BlobSnapshotCache(blobService, identity, `unidocs-${docType}-snapshots`),
        blobs: new BlobCasStore(blobService, `unidocs-${docType}-roots`),
        unitOfWork: new PgUnitOfWork(pool, identity),
        cas: {
          leaseNode: hash => cas.leaseNode(hash),
          updateRootRefs: update => cas.updateRootRefs(update),
        },
        identity,
        now: () => Date.now(),
      },
    };
  }

  const handler = createDocTypeHandler({
    docType,
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
    }, config.maxUploadBytes),
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

function unavailableCasGateway(): TenantCasClient & CasBlobClient {
  const unavailable = async (): Promise<never> => {
    throw new CasClientError(501, "Not Implemented", "delegated authority");
  };
  return {
    node: () => ({ metadata: unavailable, read: unavailable }),
    leaseNode: unavailable,
    updateRootRefs: unavailable,
    usage: unavailable,
    gc: unavailable,
    storeBlob: unavailable,
    statBlob: unavailable,
    openBlob: async () => {
      throw new CasClientError(501, "Not Implemented", "delegated authority");
    },
  };
}

function requireCasStackId(stackId: string | undefined): string {
  if (stackId === undefined || stackId.length === 0) {
    throw new Error("CAS_STACK_ID is required for delegated CAS access");
  }
  return stackId;
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
  // 0 / 缺省 = 不限,与这个开关存在之前的行为一致。
  const declaredLimit = Number(process.env.MAX_UPLOAD_BYTES ?? 0);
  const maxUploadBytes = Number.isSafeInteger(declaredLimit) && declaredLimit > 0
    ? declaredLimit
    : undefined;
  const handle = await startDocTypeService({
    docType,
    documentTypeFactory,
    port: Number(process.env.PORT ?? defaultPort),
    config: {
      databaseUrl: requireEnv("DATABASE_URL"),
      ...resolveBlobConfig(),
      docCapabilityVerifier: auth.docCapabilityVerifier,
      casCapabilityVerifier: auth.casCapabilityVerifier,
      casBaseUrl,
      casStackId: process.env.CAS_STACK_ID,
      ...(maxUploadBytes === undefined ? {} : { maxUploadBytes }),
    },
  });
  console.log(`azure-${docType} CAS: baseUrl=${process.env.CAS_BASE_URL ?? "(none)"} stackId=${process.env.CAS_STACK_ID ?? "(none)"}`);
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
