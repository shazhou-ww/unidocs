import type {
  AgentContentPart, AgentMessage, AgentPlatform, AgentTool, AgentToolDefinition,
  AgentToolResult, DocumentAgent, JsonValue, LlmProvider,
} from "@unidocs/protocol";
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
}

export class AgentSession<TQuery, TOp> {
  readonly #deps: AgentSessionDeps<TQuery, TOp>;
  readonly #tools: ReadonlyMap<string, AgentTool<TQuery, TOp>>;
  readonly #definitions: readonly AgentToolDefinition[];
  readonly #blobCache = new ByteLru(BLOB_CACHE_BYTES);
  #history: AgentMessage[] = [];

  constructor(deps: AgentSessionDeps<TQuery, TOp>) {
    this.#deps = deps;
    this.#tools = new Map(deps.agent.tools.map(t => [t.name, t]));
    this.#definitions = deps.agent.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async run(content: readonly AgentContentPart[]): Promise<AgentRunOutcome> {
    this.#history.push({ role: "user", content });
    const maxIterations = this.#deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    /** 本次 run 里工具被调用的顺序，只留名字 —— 到上限时靠它说清 25 轮花在哪。 */
    const trace: string[] = [];

    for (let iterations = 1; iterations <= maxIterations; iterations++) {
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

      // 既没有可说的话也没有要调的工具 —— 思考阶段用光 max_tokens、refusal、
      // pause_turn 都会这样。这条**不能进历史**：空 content 的 assistant 消息
      // 一旦留下，此后每次 run 都会把它发给模型，而 Anthropic 拒收空 content，
      // 这个会话就只能靠 reset 救活了。直接以失败结束，把原因说出来。
      if (toolCalls.length === 0 && assistantContent.length === 0) {
        const why = completion.stopReason ?? "未知";
        return { ok: false, error: `模型没有返回可用内容（stop_reason: ${why}）` };
      }

      this.#history.push({
        role: "assistant",
        content: assistantContent,
        ...(toolCalls.length ? { toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        return {
          ok: true,
          content: assistantContent,
          response: assistantContent.map(p => p.text).join(""),
          iterations,
        };
      }

      for (const call of toolCalls) {
        trace.push(call.name);
        const result = await this.#dispatch(call.name, call.arguments);
        this.#history.push(toolResultToMessage(call.id, result));
      }
    }

    // 光说"到上限了"对排查毫无用处。一次真实故障里，用户拿到的就是
    // `Max iterations (25) reached`，而 25 轮到底花在哪儿完全看不出来 ——
    // 是一直在找图层，还是一直在重画，还是某个工具每次都报错，这三种成因的
    // 修法完全不同。把调用序列压缩后带出来，一眼就能分辨。
    return {
      ok: false,
      error: `Max iterations (${maxIterations}) reached. Tools called: ${summarise(trace)}`,
    };
  }

  reset(): void {
    this.#history = [];
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
