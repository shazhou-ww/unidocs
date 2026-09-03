/**
 * Operator Durable Object —— 内核的 Cloudflare 外壳。
 *
 * 这里只剩四件事：捕获并校验身份、把 DO 的请求串行化、惰性创建
 * AgentSession、把 AgentRunOutcome 映射成 /run 的 JSON 响应。循环、消息
 * 格式、工具分发都在 @unidocs/doctype-server-common/agent 里，文档读写在
 * ./agent-platform-do.ts 里。
 */
import { AgentSession } from "@unidocs/doctype-server-common/agent";
import type { AgentContentPart, DocumentAgent, LlmProvider } from "@unidocs/protocol";
import { docSessionObjectName } from "@unidocs/doctype-server-common";
import { consoleObserver } from "@unidocs/protocol-doc";
import { createCloudflareAgentPlatform } from "./agent-platform-do.js";

/** 一个 operator DO 实例固定服务的那一对身份。 */
export interface AgentIdentity {
  readonly tenantId: string;
  readonly sessionId: string;
}

export interface OperatorConfig<TQuery, TOp, TEnv = unknown> {
  /**
   * 工具表 + 系统提示词。
   *
   * 允许传函数，理由和下面的 provider 一模一样：有的工具需要按 env 构造的
   * 东西（PSD 的 editPixels 要一个带 API key 的 ImageEditor），而 env 只在
   * 构造 DO 时交到我们手上。传常量的文档类型照旧。
   *
   * 第二个参数是身份。有的工具还需要知道**是哪个租户**（PSD 的 setText 要打
   * 租户级的字体索引 DO）。给得起是因为 `#captureIdentity` 拒绝一个实例换
   * 身份（403 "Operator session mismatch"），所以一个 operator DO 固定服务
   * 一对 (租户, 会话)，而 agent 是惰性建的、建的时候身份已经在手上。
   * 只用 env 的工厂照旧 —— 少一个参数的函数赋给多参函数类型在 TypeScript 里
   * 合法，`cloudflare-docx` / `cloudflare-markdown` 不用动。
   */
  readonly agent:
    | DocumentAgent<TQuery, TOp>
    | ((env: TEnv, identity: AgentIdentity) => DocumentAgent<TQuery, TOp>);
  /**
   * provider 按 env 构造：一个 DO 实例活得比一次配置改动久，而 env 只在
   * 构造 DO 时交到我们手上。
   */
  readonly provider: (env: TEnv) => LlmProvider;
  readonly getEditorStub: (
    env: TEnv,
    editorObjectName: string,
  ) => DurableObjectStub;
  /**
   * Cap on loop turns for one `/run`. Defaults to the kernel's
   * `DEFAULT_MAX_ITERATIONS`. Doc types whose edits are inherently multi-step
   * (PSD: locate a layer, preview it, transform it, re-preview to verify)
   * raise this — the default cuts such a run off mid-edit.
   */
  readonly maxIterations?: number;
}

export interface OperatorDOInstance {
  fetch(request: Request): Promise<Response>;
}

export type OperatorDOClass<TEnv = unknown> = new (
  ctx: DurableObjectState,
  env: TEnv,
) => OperatorDOInstance;

export function createOperatorDO<TQuery, TOp, TEnv = unknown>(
  config: OperatorConfig<TQuery, TOp, TEnv>,
): OperatorDOClass<TEnv> {
  return class OperatorDO implements OperatorDOInstance {
    readonly #env: TEnv;
    #requestTail: Promise<void> = Promise.resolve();
    #agentSession: AgentSession<TQuery, TOp> | null = null;
    #requestHeaders = new Headers();
    #sessionId: string | null = null;
    #tenantId: string | null = null;

    constructor(_ctx: DurableObjectState, env: TEnv) {
      this.#env = env;
    }

    /**
     * 一个 DO 的请求逐个来，不并发。AgentSession.run() 不可重入 —— 并发
     * 调用会把 user 消息插进 assistant / tool 配对中间，产出多数 provider
     * 会硬拒的序列。这段串行化就是那个风险不成立的理由，不要去掉。
     */
    fetch(request: Request): Promise<Response> {
      const response = this.#requestTail.then(() => this.#handleRequest(request));
      this.#requestTail = response.then(
        () => undefined,
        () => undefined,
      );
      return response;
    }

    async #handleRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        if (request.method === "POST" && url.pathname === "/_internal/run") {
          const identityError = this.#captureIdentity(request);
          if (identityError) return identityError;
          const body = await request.json() as { instruction?: unknown };
          if (typeof body.instruction !== "string") {
            return Response.json({ success: false, error: "instruction must be a string" }, { status: 400 });
          }
          const content: readonly AgentContentPart[] = [{ type: "text", text: body.instruction }];
          const outcome = await this.#session().run(content);
          if (!outcome.ok) {
            return Response.json({ success: false, error: outcome.error }, { status: 500 });
          }
          return Response.json({
            success: true,
            data: { response: outcome.response, iterations: outcome.iterations },
          });
        }

        if (request.method === "POST" && url.pathname === "/_internal/reset") {
          const identityError = this.#captureIdentity(request);
          if (identityError) return identityError;
          this.#agentSession?.reset();
          return Response.json({ success: true });
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${url.pathname}` }, { status: 404 });
      } catch (err) {
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      } finally {
        this.#requestHeaders = new Headers();
      }
    }

    /**
     * 惰性创建：sessionId 来自请求头，DO 构造的时候还没有（spec 5.5.1）。
     * 建成之后跨请求存活 —— 对话历史在它里面，只有 /_internal/reset 清空。
     */
    #session(): AgentSession<TQuery, TOp> {
      if (this.#agentSession) return this.#agentSession;
      // 身份此刻一定在手上：两个内部端点都是先 #captureIdentity 再往下走，
      // 而 #session() 只在 /_internal/run 的捕获成功之后才被调到。这句断言
      // 是给以后加端点的人看的 —— 漏了捕获就当场抛，而不是让 agent 拿着
      // 空租户去打字体 DO。
      if (!this.#tenantId || !this.#sessionId) throw new Error("Agent has no session identity");
      const identity: AgentIdentity = { tenantId: this.#tenantId, sessionId: this.#sessionId };
      const platform = createCloudflareAgentPlatform<TQuery, TOp, TEnv>({
        env: this.#env,
        getEditorStub: config.getEditorStub,
        requestHeaders: () => this.#requestHeaders,
        editorObjectName: () => this.#editorObjectName(),
      });
      this.#agentSession = new AgentSession<TQuery, TOp>({
        agent: typeof config.agent === "function"
          ? config.agent(this.#env, identity)
          : config.agent,
        platform,
        provider: config.provider(this.#env),
        ...(config.maxIterations === undefined ? {} : { maxIterations: config.maxIterations }),
        // agent 自己的运行过程此前完全没有观测：一次失败在日志里只剩下它顺带
        // 打出的那几条出站 HTTP，调了哪些工具、跑了几轮、在第几步崩的全靠猜。
        // 与出站 HTTP 用同一个 observer，落到同一条日志流里。
        observe: consoleObserver,
      });
      return this.#agentSession;
    }

    /** 编辑器 DO 的对象名，按当次请求的 auth 模式解析。 */
    #editorObjectName(): string {
      if (!this.#sessionId || !this.#tenantId) throw new Error("Agent has no session identity");
      const authKind = this.#requestHeaders.get("X-UniDocs-Auth-Context");
      if (authKind !== "legacy" && authKind !== "capability") {
        throw new Error("Agent has no private auth context");
      }
      return authKind === "capability"
        ? docSessionObjectName(this.#tenantId, this.#sessionId)
        : this.#sessionId;
    }

    #captureIdentity(request: Request): Response | null {
      const tenantId = request.headers.get("X-Tenant-Id");
      const sessionId = request.headers.get("X-Session-Id");
      if (!tenantId || !sessionId) {
        return Response.json({ success: false, error: "Missing tenant or session identity" }, { status: 401 });
      }
      if ((this.#tenantId !== null && this.#tenantId !== tenantId)
        || (this.#sessionId !== null && this.#sessionId !== sessionId)) {
        return Response.json({ success: false, error: "Operator session mismatch" }, { status: 403 });
      }
      this.#sessionId = sessionId;
      this.#tenantId = tenantId;
      this.#requestHeaders = new Headers();
      for (const name of [
        "X-Tenant-Id",
        "X-Session-Id",
        "X-Doc-Type",
        "X-Internal-Token",
        "X-UniDocs-Auth-Context",
        "X-UniDocs-Doc-Operation",
        "X-UniDocs-CAS-Capability",
      ]) {
        const value = request.headers.get(name);
        if (value) this.#requestHeaders.set(name, value);
      }
      return null;
    }
  };
}
