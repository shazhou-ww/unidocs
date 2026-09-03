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
  readonly agent: DocumentAgent<TQuery, TOp>;
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

  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const tenantId = request.headers.get("X-Tenant-Id");
        const sessionId = request.headers.get("X-Session-Id");
        if (!tenantId || !sessionId) {
          return json({ success: false, error: "Missing tenant or session identity" }, 401);
        }
        const identity: SessionIdentity = { tenantId, docType: deps.docType, sessionId };
        const store = new PgAgentSessionStore(deps.pool, identity);

        try {
          if (request.method === "POST" && url.pathname === "/_internal/reset") {
            await store.clear();
            return json({ success: true });
          }

          if (request.method === "POST" && url.pathname === "/_internal/run") {
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

            const headers = new Headers();
            for (const name of FORWARDED_HEADERS) {
              const value = request.headers.get(name);
              if (value) headers.set(name, value);
            }
            const editorFetcher: EditorFetcher = {
              fetch: (u, init) => deps.editor.get(deps.editor.idFromName(sessionId))
                .fetch(new Request(u, init)),
            };

            const session = new AgentSession<TQuery, TOp>({
              agent: deps.agent,
              platform: createHttpAgentPlatform<TQuery, TOp, undefined>({
                env: undefined,
                getEditorStub: () => editorFetcher,
                requestHeaders: () => headers,
                editorObjectName: () => sessionId,
              }),
              provider: deps.provider,
              history: decodeHistory(raw),
              docType: deps.docType,
            });

            const content: readonly AgentContentPart[] = [{ type: "text", text: body.instruction }];
            try {
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
              await store.release(encodeHistory(session.snapshotHistory()));
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
