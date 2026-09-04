/**
 * Azure 的 operator 命名空间 —— 替换掉一律 501 的
 * `createStubOperatorNamespace()`。
 *
 * 与 Cloudflare 的 `OperatorDO` 端点逐字对齐（`operator-do-agent.ts:83-107`），
 * 只多一个状态码:抢不到租约返回 409。
 *
 * 与编辑器命名空间同理（见 `local-editor.ts` 的模块注释）：每次请求新建
 * `AgentSession`，不缓存。Azure 是 2-5 副本、无会话亲和，缓存在进程里的会话
 * 下一次请求就落到别的副本上了。历史因此必须落库，这正是
 * `PgAgentSessionStore` 存在的原因。
 */
import type { Pool } from "pg";
import type { AgentContentPart, DocumentAgent, JsonValue } from "@unidocs/protocol";
import { consoleObserver } from "@unidocs/protocol-doc";
import {
  AgentSession,
  createHttpAgentPlatform,
  decodeHistory,
  encodeHistory,
  type EditorFetcher,
  type LlmProvider,
} from "@unidocs/doctype-server-common/agent";
import type { SessionIdentity } from "@unidocs/doctype-server-common";
import { AGENT_LEASE_SECONDS, PgAgentSessionStore } from "./agent-session-store.js";
import type { LocalNamespace } from "./local-editor.js";

/** 转发给编辑器的头，与 CF 的 `#captureIdentity` 同一张表。 */
const FORWARDED_HEADERS = [
  "X-Tenant-Id",
  "X-Session-Id",
  "X-Doc-Type",
  "X-Internal-Token",
  "X-UniDocs-Auth-Context",
  "X-UniDocs-Doc-Operation",
  "X-UniDocs-CAS-Capability",
] as const;

export interface LocalOperatorDeps<TQuery, TOp> {
  readonly pool: Pool;
  /** 同一个进程里的编辑器命名空间；agent 的读写都打到它。 */
  readonly editor: LocalNamespace;
  /**
   * 按会话身份构造的工厂，不是启动期就定死的值 —— 字体索引是租户级的
   * （见本文件模块注释），而 `runDocTypeService()` 启动时根本没有租户。
   * 必须在 `captureIdentity(request)` 拿到身份**之后**调用，与 CF 的
   * `agent: (env, identity) => ...` 对齐（cloudflare-psd/src/worker.ts:53）。
   */
  readonly agent: (identity: SessionIdentity) => DocumentAgent<TQuery, TOp>;
  readonly provider: LlmProvider;
  readonly docType: string;
  /** 只给测试用；生产走 AGENT_LEASE_SECONDS。 */
  readonly leaseSeconds?: number;
}

const json = (body: JsonValue, status = 200): Response =>
  Response.json(body as never, { status });

export function createLocalOperatorNamespace<TQuery, TOp>(
  deps: LocalOperatorDeps<TQuery, TOp>,
): LocalNamespace {
  const leaseSeconds = deps.leaseSeconds ?? AGENT_LEASE_SECONDS;

  /**
   * 与 CF 的 `#captureIdentity` 同理，但**只在路由分支内部调用** ——
   * 未知端点 / 非 POST 方法必须先判 404，再谈身份（评审 Important #1）：
   * 挪到路由分发之前会让"缺身份头 + 未知端点"在 CF 上是 404，在这里变成
   * 401，是一处未声明的契约差异。
   */
  function captureIdentity(request: Request): SessionIdentity | null {
    const tenantId = request.headers.get("X-Tenant-Id");
    const sessionId = request.headers.get("X-Session-Id");
    if (!tenantId || !sessionId) return null;
    return { tenantId, docType: deps.docType, sessionId };
  }

  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);

        try {
          if (request.method === "POST" && url.pathname === "/_internal/reset") {
            const identity = captureIdentity(request);
            if (!identity) {
              return json({ success: false, error: "Missing tenant or session identity" }, 401);
            }
            await new PgAgentSessionStore(deps.pool, identity).clear();
            return json({ success: true });
          }

          if (request.method === "POST" && url.pathname === "/_internal/run") {
            const identity = captureIdentity(request);
            if (!identity) {
              return json({ success: false, error: "Missing tenant or session identity" }, 401);
            }
            const store = new PgAgentSessionStore(deps.pool, identity);

            const body = await request.json() as { instruction?: unknown };
            if (typeof body.instruction !== "string") {
              return json({ success: false, error: "instruction must be a string" }, 400);
            }

            const raw = await store.acquire(leaseSeconds);
            if (raw === null) {
              // CF 那边是排队等（DO 单线程里的 promise 链，等待不占资源）。
              // 跨副本没有等价物，所以这里快速失败，由调用方重试。
              return json({
                success: false,
                error: "Another agent run is in progress for this document",
              }, 409);
            }

            // 租约已经抢到手：从这里开始的每一步都可能抛（decodeHistory 对
            // 畸形历史是故意设计成抛而不是静默丢弃——见 history-codec.ts），
            // 一旦抛出又不释放，这份文档的租约要悬空到 1800 秒自然过期
            // （评审 Important #2）。所以 finally 要罩住 acquire() 之后的
            // 全部代码，不能只罩 session.run()。`session` 用 let 是因为
            // decodeHistory 本身就可能在它被赋值之前抛出：那种情况下没有
            // AgentSession 可以 snapshotHistory()，只能把原样的 raw 写回去
            // ——不改内容，纯粹为了释放锁。
            let session: AgentSession<TQuery, TOp> | undefined;
            try {
              const headers = new Headers();
              for (const name of FORWARDED_HEADERS) {
                const value = request.headers.get(name);
                if (value) headers.set(name, value);
              }
              const editorFetcher: EditorFetcher = {
                fetch: (u, init) => deps.editor.get(deps.editor.idFromName(identity.sessionId))
                  .fetch(new Request(u, init)),
              };

              session = new AgentSession<TQuery, TOp>({
                agent: deps.agent(identity),
                platform: createHttpAgentPlatform<TQuery, TOp, undefined>({
                  env: undefined,
                  getEditorStub: () => editorFetcher,
                  requestHeaders: () => headers,
                  editorObjectName: () => identity.sessionId,
                }),
                provider: deps.provider,
                history: decodeHistory(raw),
                docType: deps.docType,
                // 评审 Important #2:CF 传了这个(operator-do-agent.ts:136),
                // Azure 没传,于是这条全新上生产的路径恰恰是可观测性最差的
                // 那条——一次故障连调了哪些工具、跑了几轮、在第几步崩的都要
                // 靠猜。与出站 HTTP(doc-type-service.ts 的 httpCasFetcher)
                // 用同一个 observer,落到同一条日志流里。
                observe: consoleObserver,
              });

              const content: readonly AgentContentPart[] = [{ type: "text", text: body.instruction }];
              const outcome = await session.run(content);
              if (!outcome.ok) return json({ success: false, error: outcome.error }, 500);
              return json({
                success: true,
                data: { response: outcome.response, iterations: outcome.iterations },
              });
            } finally {
              // finally,不是成功路径。CF 的 #history.push 在 try 之前
              // (session.ts:81),失败那轮也留在历史里 —— 两条运行时在"重试时
              // 模型看到什么"上不一致是最难查的那种 bug。
              await store.release(session ? encodeHistory(session.snapshotHistory()) : raw);
            }
          }

          return json({ success: false, error: `Unknown endpoint: ${url.pathname}` }, 404);
        } catch (err) {
          return json({ success: false, error: String(err) }, 500);
        }
      },
    }),
  };
}
