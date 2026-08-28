/**
 * Anthropic (Claude) LLM provider —— 内核的适配层之一。
 *
 * 循环内部已经是中立格式（`LlmMessage` / `AgentCompletion`），这里只做
 * 单向翻译：中立格式 → Anthropic Messages API 的请求形状，以及响应形状 →
 * 中立的 `AgentCompletion`。原实现（cloudflare-psd/src/anthropic.ts）需要
 * 先把 OpenAI 形状翻成中立格式、再翻成 Anthropic，翻两次；现在只翻一次。
 *
 * Config comes from env (populate via packages/cloudflare-psd/.dev.vars):
 *   LLM_BASE_URL  default https://api.anthropic.com
 *   LLM_API_KEY   required
 *   LLM_MODEL     default claude-opus-5
 */
import type {
  AgentCompletion, AgentToolCall, AgentToolDefinition, JsonValue,
  LlmContentPart, LlmMessage, LlmProvider,
} from "@unidocs/protocol";

interface AnthropicEnv {
  // Preferred names.
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  // Also accepted (Anthropic-native names). ANTHROPIC_API_BASE may be a base
  // (…/anthropic.com) or the full endpoint (…/v1/messages); ANTHROPIC_MODELS
  // is a comma-separated list — the first is used.
  ANTHROPIC_API_BASE?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODELS?: string;
}

/** Anthropic requires input_schema to be a JSON-Schema object with a `type`. */
function toInputSchema(params: unknown): Record<string, unknown> {
  const s = (params && typeof params === "object") ? params as Record<string, unknown> : {};
  if (s.type) return s;
  return { type: "object", properties: {}, ...s };
}

/** Resolve the messages endpoint from a base-or-full URL. */
function resolveEndpoint(raw: string): string {
  const url = raw.replace(/\/+$/, "");
  if (url.endsWith("/messages")) return url;      // already the full endpoint
  if (url.endsWith("/v1")) return `${url}/messages`;
  return `${url}/v1/messages`;                     // a bare base host
}

interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicImageBlock { type: "image"; source: { type: "base64"; media_type: string; data: string } }
interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: Array<AnthropicTextBlock | AnthropicImageBlock>;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
export interface AnthropicMessage { role: "user" | "assistant"; content: AnthropicBlock[] }

/** 分块，避免 String.fromCharCode(...) 在大图上爆栈。原实现同一写法。 */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 一个中立 content part → 一个 Anthropic 块。图片是结构化字段，直接读。 */
function toBlock(part: LlmContentPart): AnthropicTextBlock | AnthropicImageBlock {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") {
    return { type: "image", source: { type: "base64", media_type: part.mediaType, data: toBase64(part.data) } };
  }
  // Anthropic 的 document 块另有形状，本区块不做 —— 先降级成一行文字，
  // 与裁剪/物化的降级用同一句式（spec 6.2.3）。
  return { type: "text", text: `[file: ${part.filename ?? part.mediaType}]` };
}

export function toAnthropicMessages(messages: readonly LlmMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content.map(toBlock) });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = m.content.map(toBlock);
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    // role === "tool"
    const content: Array<AnthropicTextBlock | AnthropicImageBlock> = m.content.map(toBlock);
    if (m.structuredContent !== undefined) {
      content.push({ type: "text", text: JSON.stringify(m.structuredContent) });
    }
    const block: AnthropicToolResultBlock = { type: "tool_result", tool_use_id: m.callId, content };
    // Claude 要求 tool 结果以 user 角色出现；把同一个 assistant 轮次产生的
    // 多个结果合并进一条消息（原实现 anthropic.ts:130-138 的逻辑）。
    const last = out[out.length - 1];
    if (last && last.role === "user" && last.content.every(b => b.type === "tool_result")) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
}

function toCompletion(data: AnthropicResponse): AgentCompletion {
  const content: LlmContentPart[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: (block.input ?? {}) as JsonValue,
      });
    }
  }
  // thinking / redacted_thinking 之类的块这里不翻译，于是一次"只思考没说话"
  // 的响应会得到空 content 和空 toolCalls。stop_reason 是唯一能说清那是
  // 为什么的信号（max_tokens 在思考阶段耗尽 / refusal / pause_turn），
  // 循环靠它给出可读的失败原因。
  return {
    content,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(data.stop_reason ? { stopReason: data.stop_reason } : {}),
  };
}

export function createAnthropicProvider(
  env: AnthropicEnv,
  fetchImpl: typeof fetch = fetch,
): LlmProvider {
  const endpoint = resolveEndpoint(env.LLM_BASE_URL || env.ANTHROPIC_API_BASE || "https://api.anthropic.com");
  const apiKey = env.LLM_API_KEY || env.ANTHROPIC_API_KEY;
  const model = env.LLM_MODEL || env.ANTHROPIC_MODELS?.split(",")[0]?.trim() || "claude-opus-5";

  return {
    async complete({ system, messages, tools }) {
      if (!apiKey) {
        throw new Error("No API key set — put LLM_API_KEY (or ANTHROPIC_API_KEY) in this worker's env");
      }
      const anthTools = tools.map((t: AgentToolDefinition) => ({
        name: t.name,
        description: t.description,
        input_schema: toInputSchema(t.inputSchema),
      }));
      const resp = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          // 非流式请求的常规上限。4096 偏低：默认模型开着思考，思考先花掉
          // 预算就会返回一条既没 text 也没 tool_use 的响应。
          max_tokens: 16000,
          ...(system ? { system } : {}),
          messages: toAnthropicMessages(messages),
          ...(anthTools.length ? { tools: anthTools } : {}),
        }),
      });
      if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
      return toCompletion(await resp.json() as AnthropicResponse);
    },
  };
}
