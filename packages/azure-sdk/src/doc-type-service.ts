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
import {
  consoleObserver,
  httpCallEvent,
  httpCallFailure,
  matchFontsRoute,
  pickObservedHeaders,
  readObservedBody,
} from "@unidocs/protocol-doc";
import type { HttpCallInput } from "@unidocs/protocol-doc";
import type { DocumentAgent, DocumentTypeContext, DocumentTypeFactory, SBlobSource } from "@unidocs/protocol";
import { createTenantCasClient, type HttpFetcher } from "@unicas/tenant-client";
import { CasClientError } from "@unicas/tenant-blob-client";
import { createCasBlobClient, leaseNodeContent } from "@unicas/tenant-blob-client";
import type { TenantCasClient } from "@unicas/tenant-client";
import type {
  DocCapabilityVerifier,
  FontRegistry,
  SessionDeps,
  SessionIdentity,
} from "@unidocs/doctype-server-common";
import {
  createDocTypeHandler,
  createSBlobContext,
  DocAuthConfigCache,
  handleFontsRequest,
  readableStreamFromSBlobSource,
} from "@unidocs/doctype-server-common";
import { attachPoolErrorLogger, requireEnv, resolveBlobConfig } from "./env.js";
import {
  createLocalEditorNamespace,
  createStubOperatorNamespace,
  type PrivateDocRequestContext,
} from "./local-editor.js";
import { createLocalOperatorNamespace } from "./local-operator.js";
import type { LlmProvider } from "@unidocs/doctype-server-common/agent";
import { BlobCasStore, BlobSnapshotCache } from "./ports-blob.js";
import { PgDeltaLog, PgSessionIdentityStore, PgUnitOfWork } from "./ports-pg.js";
import { createBlobService, createPool } from "./pool.js";
import type { Pool } from "pg";
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
  /**
   * 给了就挂真 operator，省略则维持 501 stub —— markdown/docx/psd 可以分批接。
   *
   * 是**按会话身份构造的工厂**，不是值：字体索引是租户级的，而 `main.ts`
   * 起进程、把这个选项传下来的那一刻根本没有租户 —— 身份只在每次请求里
   * `local-operator.ts` 的 `captureIdentity(request)` 才拿得到。与 CF 的
   * `agent: (env, identity) => ...` 对齐（cloudflare-psd/src/worker.ts:53）。
   */
  documentAgent?: (identity: SessionIdentity, pool: Pool) => DocumentAgent<TQuery, TOp>;
  /** 与 `documentAgent` 必须同时给；只给一个在启动期抛错。 */
  llmProvider?: LlmProvider;
  /**
   * 给了就挂上租户级的 `/tenants/{t}/fonts`；缺省不挂（markdown/docx 没有
   * 字体索引，给它们开一个永远读到空表的端点只会误导调用方）。
   *
   * 收 `pool` 的理由和 `documentAgent` 收 `identity` 一样：连接池是
   * `startDocTypeService()` 自己建的，`main.ts` 传这个选项进来的那一刻还没有
   * 池。让调用方自己再建一个池，等于同一个进程开两套连接。
   */
  fontRegistryFor?: (tenantId: string, pool: Pool) => FontRegistry;
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
function httpCasFetcher(baseUrl: string, docType: string): HttpFetcher {
  const origin = baseUrl.replace(/\/$/, "");
  return {
    // doc service -> CAS 的唯一收口,所以计时埋在这里能盖住全部 CAS 调用。
    // op 从规范路径里取(/stacks/{s}/tenants/{t}/cas/nodes/{hash}/lease -> "lease"),
    // 这样按操作类型聚合耗时时,hash 不会把每一次调用打散成一个独立的桶。
    fetch: async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const target = `${origin}${url.pathname}${url.search}`;
      const segments = url.pathname.split("/").filter(Boolean);
      const casInput: HttpCallInput = {
        dir: "out",
        target: "cas",
        op: segments[segments.length - 1] ?? "unknown",
        method: req.method,
        durationMs: 0,
        docType,
        url: target,
        requestHeaders: pickObservedHeaders(req.headers),
      };
      const started = Date.now();
      try {
        const response = await fetch(target, req);
        const finished = { ...casInput, durationMs: Date.now() - started };
        const detail = response.status >= 400
          ? await readObservedBody(response.clone())
          : undefined;
        consoleObserver(httpCallEvent(finished, response.status, detail));
        return response;
      } catch (err) {
        consoleObserver(httpCallFailure({ ...casInput, durationMs: Date.now() - started }, err));
        throw err;
      }
    },
  };
}

export async function startDocTypeService<TDoc, TQuery, TOp>(
  options: DocTypeServiceOptions<TDoc, TQuery, TOp>,
): Promise<DocTypeServiceHandle> {
  const { docType, documentTypeFactory, port, config } = options;
  const host = options.host ?? "0.0.0.0";

  // 只给一半是那种"容器起来了、跑到第一次 /run 才炸"的配置错误。启动期响亮
  // 失败，不要等部署完看崩溃日志。
  if ((options.documentAgent === undefined) !== (options.llmProvider === undefined)) {
    throw new Error(
      "documentAgent 与 llmProvider 必须同时提供：只给一个会让 operator 在第一次 /run 时才失败",
    );
  }

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
    blobs: DocumentTypeContext;
  } {
    const delegatedCapability = requestContext.authKind === "capability"
      ? requestContext.delegatedCasCapability
      : undefined;
    const nodeCas = delegatedCapability === undefined
      ? unavailableTenantCasClient()
      : createTenantCasClient({
        baseUrl: "https://cas.internal",
        fetcher: config.casBaseUrl ? httpCasFetcher(config.casBaseUrl, docType) : casStubFetcher,
        stackId: requireCasStackId(config.casStackId),
        tenantId: identity.tenantId,
        getToken: async () => delegatedCapability,
      });
    const cas = createCasBlobClient(nodeCas);
    const context = createSBlobContext({
      leaseNodeContent: (hash, content, contentType, refs) =>
        leaseNodeContent(cas.unicasClient, hash, content, contentType, refs),
      leaseNode: (hash) => cas.unicasClient.leaseNode(hash),
      storeBlob: (source: SBlobSource) => cas.storeBlob(
        readableStreamFromSBlobSource(source),
        {
          contentType: source.contentType,
          ...("data" in source
            ? { size: source.data.length }
            : source.size === undefined ? {} : { size: source.size }),
        },
      ),
      openBlob: (hash) => cas.openBlob(hash),
    }, {
      // casConcurrency 取 8:这条路的内存远比 CF 的 DO isolate 宽松,而瓶颈是
      // 延迟 —— doc service 在 southeastasia,CAS 是 Cloudflare Worker,单次
      // 往返 ~1.3s(见 doctype-psd/src/resolve.ts 的说明)。8 是 psd 的
      // FaultConcurrency 已经在这条路上发过的值。
      casConcurrency: 8,
    });

    return {
      documentType: documentTypeFactory(context),
      // Same SBlobContext the DocumentType was built from, threaded to
      // `createLocalEditorNamespace` -> `createSessionHandler` so the
      // agent's `read_blob` / `write_blob` (platform-http.ts) have
      // something to talk to. See local-editor.ts's `buildSession` doc.
      blobs: context,
      deps: {
        deltas: new PgDeltaLog(pool, identity),
        snapshots: new BlobSnapshotCache(blobService, identity, `unidocs-${docType}-snapshots`),
        blobs: new BlobCasStore(blobService, `unidocs-${docType}-roots`),
        unitOfWork: new PgUnitOfWork(pool, identity),
        cas: {
          leaseNode: hash => cas.unicasClient.leaseNode(hash),
          updateRootRefs: update => cas.unicasClient.updateRootRefs(update),
        },
        identity,
        now: () => Date.now(),
      },
    };
  }

  const editorNamespace = createLocalEditorNamespace(buildSession, async (identity, creating) => {
    if (creating) await sessionIdentities.register(identity);
    const stored = await sessionIdentities.get(identity);
    if (!stored) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    if (stored.tenantId !== identity.tenantId || stored.docType !== identity.docType) {
      return Response.json({ error: "Session identity mismatch" }, { status: 403 });
    }
    return null;
  }, config.maxUploadBytes);

  // 一份审计输出，两条路由共用（doc handler 与 fonts handler 的事件形状不同，
  // 但落到日志里是同一条流）。参数取 `object` 是为了同时接住两种事件类型。
  const audit = (event: object): void =>
    console.log(JSON.stringify({ event: "doc_authentication", docType, ...event }));

  const documentAgent = options.documentAgent;
  const docHandler = createDocTypeHandler({
    docType,
    docCapabilityVerifier: config.docCapabilityVerifier,
    casCapabilityVerifier: config.casCapabilityVerifier,
    audit,
    editor: editorNamespace,
    operator: documentAgent && options.llmProvider
      ? createLocalOperatorNamespace({
        pool,
        editor: editorNamespace,
        // 池在这里补上：`LocalOperatorDeps.agent` 的签名是
        // `(identity) => agent`，每请求调一次（见 local-operator.ts）。
        agent: identity => documentAgent(identity, pool),
        provider: options.llmProvider,
        docType,
      })
      : createStubOperatorNamespace(),
  });

  const { close } = await serve(fontsRouter(docHandler), { port, host });

  /**
   * 租户级端点必须在 `createDocTypeHandler` **之前**分流：`matchDocRoute` 把
   * 路径硬编码成 `/tenants/{t}/sessions/{s}[/{op}]`，`/tenants/{t}/fonts` 不
   * 匹配，交给 doc handler 只会得到 404 "Unknown Doc endpoint"。与 CF 的
   * `cloudflare-psd/src/worker.ts` 里的分流同形。
   */
  function fontsRouter(
    fallback: (request: Request) => Promise<Response>,
  ): (request: Request) => Promise<Response> {
    const fontRegistryFor = options.fontRegistryFor;
    if (fontRegistryFor === undefined) return fallback;
    return async (request: Request): Promise<Response> => {
      const fonts = matchFontsRoute(new URL(request.url).pathname);
      if (!fonts) return fallback(request);
      // 中立的 `handleFontsRequest` 不兜底存储层的异常（`registry.list/put`
      // 抛出就直接 reject 出去）。这里再包一层**不是**为了防未处理拒绝 ——
      // `serve()` 自己就有顶层兜底（http-shell.ts），一次 Postgres 故障在
      // Node 宿主上本来也是 500，不会变成未处理拒绝。CF 那边"不兜就是未处理
      // 拒绝"的说法对 workerd 成立，照抄到这里是假的。
      //
      // 真实理由是**错误形状**：`serve()` 的兜底给的是
      // `{"error":"Unhandled error: ..."}`，那个前缀在语义上是"处理器本身坏
      // 了"（见 serve() 的文档注释：能走到那里就说明 handler 有 bug）。而
      // 一次存储故障是这个端点可预期的失败，应当以 fonts 端点自己的形状返回
      // ——`{"error":"Error: ..."}`，与它其余的错误响应一致。下面那条测试用
      // 精确的 body 相等区分这两条路径，删掉这个 catch 它会红。
      try {
        return await handleFontsRequest({
          docCapabilityVerifier: config.docCapabilityVerifier,
          registry: fontRegistryFor(fonts.tenantId, pool),
          audit,
        }, request, fonts);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    };
  }

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    async close() {
      await close();
      await pool.end();
    },
  };
}

function unavailableTenantCasClient(): TenantCasClient {
  const unavailable = async (): Promise<never> => {
    throw new CasClientError(501, "Not Implemented", "delegated authority");
  };
  return {
    readMetadata: unavailable,
    readContent: unavailable,
    leaseNode: unavailable,
    updateRootRefs: unavailable,
    // main 在 094b4af 之前给 TenantCasClient 加了 listRootRefs,这个 stub 没跟上,
    // 全仓 typecheck 因此红着(main 上同样红,错误逐字相同,只是行号不同)。
    // 与其余方法同样返回 501:这个 stub 的语义就是"没有委派权限,一律不可用"。
    listRootRefs: unavailable,
    usage: unavailable,
    gc: unavailable,
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
  documentAgent?: (identity: SessionIdentity, pool: Pool) => DocumentAgent<TQuery, TOp>;
  llmProvider?: LlmProvider;
  /** 见 `DocTypeServiceOptions.fontRegistryFor`：缺省不挂 fonts 路由。 */
  fontRegistryFor?: (tenantId: string, pool: Pool) => FontRegistry;
}): Promise<void> {
  const { docType, documentTypeFactory, defaultPort } = options;
  const auth = await new DocAuthConfigCache(docType).get(process.env);
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
    ...(options.documentAgent === undefined ? {} : { documentAgent: options.documentAgent }),
    ...(options.llmProvider === undefined ? {} : { llmProvider: options.llmProvider }),
    ...(options.fontRegistryFor === undefined ? {} : { fontRegistryFor: options.fontRegistryFor }),
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
