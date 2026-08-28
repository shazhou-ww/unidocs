import type {
  AgentContentPart, AgentMessage, AgentPlatform, AgentTool, AgentToolDefinition,
  AgentToolResult, DocumentAgent, JsonValue, LlmProvider, SValue,
} from "@unidocs/protocol";
import { ByteLru, materializeMessages } from "./messages.js";
import { defaultOpToolResult, defaultQueryToolResult, toolResultToMessage } from "./tool-result.js";

/** 文档类型没设 maxIterations 时的循环上限。PSD 传 25。 */
export const DEFAULT_MAX_ITERATIONS = 10;

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
      this.#history.push({
        role: "assistant",
        content: assistantContent,
        ...(completion.toolCalls?.length ? { toolCalls: completion.toolCalls } : {}),
      });

      if (!completion.toolCalls?.length) {
        return {
          ok: true,
          content: assistantContent,
          response: assistantContent.map(p => p.text).join(""),
          iterations,
        };
      }

      for (const call of completion.toolCalls) {
        const result = await this.#dispatch(call.name, call.arguments);
        this.#history.push(toolResultToMessage(call.id, result));
      }
    }

    return { ok: false, error: `Max iterations (${maxIterations}) reached` };
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
        return (tool.toResult ?? defaultQueryToolResult)(data as SValue, version);
      }
      const { version } = await this.#deps.platform.apply(tool.toOps(parameters), `Agent: ${name}`);
      return defaultOpToolResult(version);
    } catch (err) {
      return { structuredContent: { error: String(err) } };
    }
  }
}

function requireJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent tool parameters must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}
