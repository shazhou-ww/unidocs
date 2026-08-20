/**
 * Anthropic (Claude) LLM provider for the Operator DO.
 *
 * The Operator speaks OpenAI Chat-Completions shape internally: it sends
 * `messages` (system/user/assistant/tool) + OpenAI `tools`, and expects a
 * `{ choices: [{ message }] }` response whose `message.tool_calls[]` carry
 * `{ id, function: { name, arguments(JSON string) } }`.
 *
 * Claude's Messages API uses a different shape (top-level `system`, content
 * blocks, `tool_use` / `tool_result`). This module translates in both
 * directions so the Operator loop is unchanged.
 *
 * Config comes from env (populate via packages/cloudflare-psd/.dev.vars):
 *   LLM_BASE_URL  default https://api.anthropic.com
 *   LLM_API_KEY   required
 *   LLM_MODEL     default claude-3-5-sonnet-latest
 */

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

// --- OpenAI-shaped session (what the Operator produces/consumes) ---
interface OpenAiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}
interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}
interface OpenAiTool {
  type: string;
  function: { name: string; description?: string; parameters?: unknown };
}

// --- Anthropic Messages shapes ---
interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
interface AnthropicImageBlock { type: "image"; source: { type: "base64"; media_type: string; data: string } }
interface AnthropicToolResultBlock { type: "tool_result"; tool_use_id: string; content: string | Array<AnthropicTextBlock | AnthropicImageBlock> }
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

/** Find a `getPreview`-style `$image` payload anywhere shallow in a tool result. */
function findImage(v: unknown): { base64: string; mediaType: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const img = o.$image as { base64?: string; mediaType?: string } | undefined;
  if (img?.base64) return { base64: img.base64, mediaType: img.mediaType ?? "image/png" };
  // The operator wraps query results as { data, version } — look one level in.
  return findImage(o.data);
}

/** Short human/agent-readable meta for a preview result (no base64). */
function previewMeta(parsed: Record<string, unknown>): string {
  const d = (parsed.data ?? parsed) as Record<string, unknown>;
  const region = d.region ? ` region=${JSON.stringify(d.region)}` : "";
  const v = parsed.version !== undefined ? ` v${parsed.version}` : "";
  return `[preview ${d.width}x${d.height}${region}${v}]`;
}
interface AnthropicMessage { role: "user" | "assistant"; content: string | AnthropicBlock[] }
interface AnthropicResponse { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> }

function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return {}; }
}

/** OpenAI-style session → Anthropic { system, messages }. */
export function toAnthropic(messages: unknown[]): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const raw of messages) {
    const m = raw as OpenAiMessage;
    if (m.role === "system") {
      if (m.content) systemParts.push(String(m.content));
    } else if (m.role === "user") {
      out.push({ role: "user", content: String(m.content ?? "") });
    } else if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: String(m.content) });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeParse(tc.function.arguments) });
      }
      // A tool-use turn always has blocks; a pure-text turn keeps its string.
      out.push({ role: "assistant", content: blocks.length ? blocks : String(m.content ?? "") });
    } else if (m.role === "tool") {
      // A getPreview result carries a base64 image — hand it to Claude as an
      // image block so it can actually see the render; otherwise plain text.
      const parsed = safeParse(String(m.content ?? "")) as Record<string, unknown>;
      const image = findImage(parsed);
      const block: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: image
          ? [
              { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
              // Compact meta only — never re-embed the base64 as text.
              { type: "text", text: previewMeta(parsed) },
            ]
          : String(m.content ?? ""),
      };
      // Claude wants tool results as user-role blocks; coalesce consecutive
      // results (from one multi-tool assistant turn) into a single message.
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) &&
          last.content.every(b => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }

  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: out };
}

/** Anthropic response → OpenAI `{ choices: [{ message }] }`. */
function toOpenAi(data: AnthropicResponse): unknown {
  const textParts: string[] = [];
  const toolCalls: OpenAiToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") {
      textParts.push(block.text ?? "");
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message: OpenAiMessage = {
    role: "assistant",
    content: textParts.join("") || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  return { choices: [{ message }] };
}

/** Build a llmProvider bound to `env`, matching OperatorConfig.llmProvider. */
export function createAnthropicLlmProvider(env: unknown) {
  const e = (env ?? {}) as AnthropicEnv;
  const endpoint = resolveEndpoint(e.LLM_BASE_URL || e.ANTHROPIC_API_BASE || "https://api.anthropic.com");
  const apiKey = e.LLM_API_KEY || e.ANTHROPIC_API_KEY;
  const model = e.LLM_MODEL || e.ANTHROPIC_MODELS?.split(",")[0]?.trim() || "claude-3-5-sonnet-latest";

  return async (messages: unknown[], tools: unknown[]): Promise<unknown> => {
    if (!apiKey) {
      throw new Error("No API key set — put LLM_API_KEY (or ANTHROPIC_API_KEY) in packages/cloudflare-psd/.dev.vars");
    }

    const { system, messages: anthMessages } = toAnthropic(messages);
    const anthTools = (tools as OpenAiTool[]).map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: toInputSchema(t.function.parameters),
    }));

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: anthMessages,
        ...(anthTools.length ? { tools: anthTools } : {}),
      }),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    }

    return toOpenAi(await resp.json() as AnthropicResponse);
  };
}
