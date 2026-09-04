import type {
  AgentContentPart, AgentMessage, AgentPlatform, AgentTool, AgentToolDefinition,
  AgentToolResult, DocumentAgent, JsonValue, LlmProvider,
} from "@unidocs/protocol";
import { noopObserver, observedFailure } from "@unidocs/protocol-doc";
import type { ObserveFn } from "@unidocs/protocol-doc";
import { ByteLru, materializeMessages } from "./messages.js";
import { defaultOpToolResult, defaultQueryToolResult, toolResultToMessage } from "./tool-result.js";

/** 文档类型没设 maxIterations 时的循环上限。PSD 传 25。 */
export const DEFAULT_MAX_ITERATIONS = 10;

/** 一次 effect 的墙钟上限。图像模型同步返回约 6s，两分钟足够覆盖重试与慢响应。 */
export const EFFECT_TIMEOUT_MS = 120_000;

/** 与 sblob-context.ts:69 的默认一致。 */
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;

export type AgentRunOutcome =
  | {
    readonly ok: true;
    readonly content: readonly AgentContentPart[];
    /** 兼容旧客户端：从 content 的 text parts 派生，不是权威字段。 */
    readonly response: string;
    readonly iterations: number;
  }
  | { readonly ok: false; readonly error: string };

export interface AgentSessionDeps<TQuery, TOp> {
  readonly agent: DocumentAgent<TQuery, TOp>;
  readonly platform: AgentPlatform<TQuery, TOp>;
  readonly provider: LlmProvider;
  readonly maxIterations?: number;
  /**
   * 起始对话历史。省略 = 空数组，即 Cloudflare 今天的行为。
   *
   * 给需要跨请求持久化的运行时用：Azure 是多副本无亲和的容器，每次 /run 都要
   * 重建 AgentSession，历史只能从外部灌进来。Cloudflare 把 AgentSession 对象
   * 本身留在 DO 字段上跨请求存活，所以它不传这个。
   */
  readonly history?: readonly AgentMessage[];
  /**
   * 每一轮模型调用、每一次工具调用各产出一条事件，run 的首尾各一条。
   * 默认 noop，所以单测和既有调用方行为不变；composition root 注入
   * `consoleObserver`。
   *
   * 没有它的时候，一次 agent 故障在日志里只剩下它顺带打出的那几条出站 HTTP：
   * 调了哪些工具、跑了几轮、在第几步崩的，全靠猜。
   */
  readonly observe?: ObserveFn;
  /** 只用于给事件打标，便于在多文档类型的日志里筛。 */
  readonly docType?: string;
}

export class AgentSession<TQuery, TOp> {
  readonly #deps: AgentSessionDeps<TQuery, TOp>;
  readonly #tools: ReadonlyMap<string, AgentTool<TQuery, TOp>>;
  readonly #definitions: readonly AgentToolDefinition[];
  readonly #blobCache = new ByteLru(BLOB_CACHE_BYTES);
  #history: AgentMessage[];

  constructor(deps: AgentSessionDeps<TQuery, TOp>) {
    // 复制而不是直接持有：调用方那份数组不该随 run 增长。
    this.#history = deps.history ? [...deps.history] : [];
    this.#deps = deps;
    this.#tools = new Map(deps.agent.tools.map(t => [t.name, t]));
    this.#definitions = deps.agent.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async run(content: readonly AgentContentPart[]): Promise<AgentRunOutcome> {
    const observe = this.#deps.observe ?? noopObserver;
    const docType = this.#deps.docType;
    const started = Date.now();
    /** 本次 run 里工具被调用的顺序，只留名字 —— 结束时靠它说清轮次花在哪。 */
    const trace: string[] = [];
    const finish = (outcome: AgentRunOutcome, iterations: number): AgentRunOutcome => {
      observe({
        event: "agent_run", phase: "end",
        ...(docType ? { docType } : {}),
        ok: outcome.ok, iterations, durationMs: Date.now() - started,
        tools: summarise(trace),
        ...(outcome.ok ? {} : { error: outcome.error }),
      });
      return outcome;
    };

    this.#history.push({ role: "user", content });
    const maxIterations = this.#deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    observe({ event: "agent_run", phase: "start", ...(docType ? { docType } : {}) });

    let iterations = 0;
    try {
      for (iterations = 1; iterations <= maxIterations; iterations++) {
        // 模型调用与消息实体化都在这一段。以前它们不在任何 try 里，一抛就直接
        // 穿出 DO，被 Cloudflare 包成 `internal error; reference = …` —— 原因
        // 彻底丢失。实测一次故障：两次图像编辑都成功，然后静默 18 秒、500，
        // 日志里没有任何线索。整个循环现在兜在下面那个 catch 里。
        const llmStarted = Date.now();
        const messages = await materializeMessages(
          this.#history,
          blob => this.#deps.platform.readBlob(blob),
          this.#blobCache,
        );
        const completion = await this.#deps.provider.complete({
          system: this.#deps.agent.instructions,
          messages,
          tools: this.#definitions,
        });

        // provider 返回的文字直接成为 assistant 的 text part。将来 provider
        // 返回二进制时，这里先走 platform.writeBlob 再进历史（spec 5.4.2）。
        const assistantContent = completion.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map(p => ({ type: "text" as const, text: p.text }));
        const toolCalls = completion.toolCalls ?? [];
        observe({
          event: "agent_step", kind: "llm", iteration: iterations,
          durationMs: Date.now() - llmStarted, ok: true,
          toolCalls: toolCalls.map(c => c.name),
          ...(completion.stopReason ? { stopReason: completion.stopReason } : {}),
        });

        // 既没有可说的话也没有要调的工具 —— 思考阶段用光 max_tokens、refusal、
        // pause_turn 都会这样。这条**不能进历史**：空 content 的 assistant 消息
        // 一旦留下，此后每次 run 都会把它发给模型，而 Anthropic 拒收空 content，
        // 这个会话就只能靠 reset 救活了。直接以失败结束，把原因说出来。
        if (toolCalls.length === 0 && assistantContent.length === 0) {
          const why = completion.stopReason ?? "未知";
          return finish({ ok: false, error: `模型没有返回可用内容（stop_reason: ${why}）` }, iterations);
        }

        this.#history.push({
          role: "assistant",
          content: assistantContent,
          ...(toolCalls.length ? { toolCalls } : {}),
        });

        if (toolCalls.length === 0) {
          return finish({
            ok: true,
            content: assistantContent,
            response: assistantContent.map(p => p.text).join(""),
            iterations,
          }, iterations);
        }

        for (const call of toolCalls) {
          trace.push(call.name);
          const toolStarted = Date.now();
          const result = await this.#dispatch(call.name, call.arguments);
          // #dispatch 从不抛：它把异常折成 {error} 交给模型。所以"这一步成不成"
          // 只能从结果里读，而不能靠 try/catch —— 靠 catch 会让每一次工具失败
          // 都显示成成功。
          const failed = (result.structuredContent as { error?: unknown } | undefined)?.error;
          observe({
            event: "agent_step", kind: "tool", iteration: iterations, name: call.name,
            durationMs: Date.now() - toolStarted, ok: failed === undefined,
            args: summariseArgs(call.arguments),
            ...(failed === undefined ? {} : { error: String(failed) }),
          });
          this.#history.push(toolResultToMessage(call.id, result));
        }
      }
    } catch (err) {
      // 走到这里说明异常来自模型调用或消息实体化 —— 工具那条路自己会兜。
      // 记下来并折成一个**普通的失败结果**：抛出去只会变成一个不透明的 500。
      const detail = observedFailure(err);
      observe({
        event: "agent_step", kind: "llm", iteration: iterations,
        durationMs: Date.now() - started, ok: false, ...detail,
      });
      return finish({ ok: false, error: `Agent run failed: ${detail.error}` }, iterations);
    }

    // 光说"到上限了"对排查毫无用处。一次真实故障里，用户拿到的就是
    // `Max iterations (25) reached`，而 25 轮到底花在哪儿完全看不出来 ——
    // 是一直在找图层，还是一直在重画，还是某个工具每次都报错，这三种成因的
    // 修法完全不同。把调用序列压缩后带出来，一眼就能分辨。
    return finish({
      ok: false,
      error: `Max iterations (${maxIterations}) reached. Tools called: ${summarise(trace)}`,
    }, maxIterations);
  }

  reset(): void {
    this.#history = [];
  }

  /**
   * 当前对话历史的快照，供需要跨请求持久化的运行时取出写回。
   *
   * 返回副本，不把内部数组交出去 —— 调用方在写回之前改坏它，只会在下一次
   * run 读到脏历史时才暴露，离现场很远。
   */
  snapshotHistory(): readonly AgentMessage[] {
    return [...this.#history];
  }

  /**
   * 内核对工具的全部认知：它叫什么、是读还是写、把参数交给它的纯函数会
   * 得到一个 query 或一批 op。不认识图层或段落，也不认识版本号（spec 5.1.6）。
   *
   * 任何一步抛错都变成一条给模型的 tool 消息，循环不中断 —— apply 自己
   * 就是校验器，错了让模型重新生成（spec 5.2）。
   */
  async #dispatch(name: string, args: JsonValue): Promise<AgentToolResult> {
    try {
      const tool = this.#tools.get(name);
      if (!tool) throw new Error(`Unknown agent tool: ${name}`);
      const parameters = requireJsonObject(args);
      if (tool.kind === "query") {
        const { data, version } = await this.#deps.platform.query(tool.toQuery(parameters));
        return (tool.toResult ?? defaultQueryToolResult)(data, version);
      }
      if (tool.kind === "effect") {
        const outcome = await tool.run(parameters, {
          query: q => this.#deps.platform.query(q),
          readBlob: b => this.#deps.platform.readBlob(b),
          writeBlob: d => this.#deps.platform.writeBlob(d),
          signal: AbortSignal.timeout(EFFECT_TIMEOUT_MS),
        });
        // 空 ops 不落库：一次被拒绝的生成不该在历史里留下一个空版本。
        if (outcome.ops.length > 0) {
          await this.#deps.platform.apply(outcome.ops, outcome.description ?? `Agent: ${name}`);
        }
        // 版本号不合并进去 —— effect 自己说清楚发生了什么就够了，
        // 而且它通常还要附一张 after 预览图（spec 5.2.1：agent 不管版本）。
        return outcome.result;
      }
      const { version } = await this.#deps.platform.apply(tool.toOps(parameters), `Agent: ${name}`);
      return defaultOpToolResult(version);
    } catch (err) {
      // 工具失败一直是**静默**的：异常在这里被折成一段文本交给模型，循环继续，
      // 而外面什么记录都没有。一次真实故障里这让排查彻底卡住 —— 用户只拿到
      // `Max iterations (25) reached`，而"某个工具每次都抛"和"模型在反复重画"
      // 在日志里长得一模一样。出站 HTTP 有观测，工具没有，这是个洞。
      //
      // 用 console.error 而不是注入一个 observer：这里是内核，加依赖要动所有
      // 调用方；而 Worker 的 console 本来就进 wrangler tail 和生产日志。
      console.error(JSON.stringify({
        event: "agent_tool_error", tool: name, error: String(err),
      }));
      return { structuredContent: { error: String(err) } };
    }
  }
}

/**
 * `["getLayers","getPreview","getPreview","getPreview"]` → `getLayers, getPreview x3`。
 * 压掉连续重复，因为循环恰恰长这样，而原样列出 25 个名字反而看不出来。
 */
/**
 * 工具参数的摘要，进 `agent_step`。
 *
 * 只记到能定位问题为止：一次实测排查里，日志显示 agent 调了 `editPixels`，
 * 却看不出**编辑的是哪一层** —— 而"它为什么没改用 setText"完全取决于那层
 * 是不是可编辑的文字层。工具名不够，参数才够。
 *
 * 截断而不是全记：`editPixels` 的参数带自然语言指令、`setText` 带整串新
 * 内容，全记会把日志淹掉。`ARGS_CHARS` 取 200 是因为 layerId 这类定位字段
 * 总在前面 —— 长文本在后面被切掉不影响定位。
 */
const ARGS_CHARS = 200;

function summariseArgs(args: unknown): string {
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args) ?? String(args);
  } catch {
    // 循环引用之类：记不下来也不能让观测把整个 run 弄挂。
    text = "<unserialisable>";
  }
  return text.length > ARGS_CHARS ? `${text.slice(0, ARGS_CHARS)}…(+${text.length - ARGS_CHARS})` : text;
}

function summarise(trace: readonly string[]): string {
  if (trace.length === 0) return "none";
  const runs: { name: string; n: number }[] = [];
  for (const name of trace) {
    const last = runs[runs.length - 1];
    if (last && last.name === name) last.n++;
    else runs.push({ name, n: 1 });
  }
  return runs.map(r => (r.n > 1 ? `${r.name} x${r.n}` : r.name)).join(", ");
}

function requireJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent tool parameters must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}
