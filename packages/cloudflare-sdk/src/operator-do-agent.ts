import { decodeSValue, encodeSValue, isSBlob, toJsonValue } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type { AgentToolResult, DocumentAgent, DocumentAgentContext, DocumentAgentFactory, SBlob, SBlobData, SValue, SValueType } from "@unidocs/protocol";

export interface AgentToolResultRendererContext {
  readonly readBlob: (blob: SBlob) => Promise<SBlobData>;
}

export type AgentToolResultRenderer = (
  result: AgentToolResult,
  context: AgentToolResultRendererContext,
) => Promise<unknown> | unknown;

export interface OperatorConfig<TQuery, TOp, TEnv = unknown> {
  readonly agentFactory: DocumentAgentFactory<TQuery, TOp>;
  readonly llmProvider: (
    messages: unknown[],
    tools: unknown[],
    env: TEnv,
  ) => Promise<unknown>;
  readonly getEditorStub: (
    env: TEnv,
    userId: string,
    docId: string,
  ) => DurableObjectStub;
  readonly renderToolResult?: AgentToolResultRenderer;
  /**
   * Cap on ReAct loop turns for one `/run`. Defaults to
   * `DEFAULT_MAX_ITERATIONS`. Doc types whose edits are inherently multi-step
   * (PSD: locate a layer, preview it, transform it, re-preview to verify)
   * raise this — the default cuts such a run off mid-edit.
   */
  readonly maxIterations?: number;
}

/** Turn cap when a doc type doesn't set `maxIterations`. */
export const DEFAULT_MAX_ITERATIONS = 10;

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
    readonly #ctx: DurableObjectState;
    readonly #env: TEnv;
    readonly #agent: DocumentAgent;
    readonly #agentContext: DocumentAgentContext<TQuery, TOp>;
    #session: unknown[];
    #lastKnownVersion: number | null = null;
    #identityHeaders = new Headers();
    #docId: string | null = null;
    #userId: string | null = null;

    constructor(ctx: DurableObjectState, env: TEnv) {
      this.#ctx = ctx;
      this.#env = env;
      this.#agentContext = {
        query: query => this.#query(query),
        apply: (operations, description) => this.#apply(operations, description),
        resolveBlob: hash => this.#resolveBlob(hash),
        readBlob: blob => this.#readBlob(blob),
      };
      this.#agent = config.agentFactory(this.#agentContext);
      this.#session = [{ role: "system", content: this.#agent.instructions }];
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        if (request.method === "POST" && url.pathname === "/_internal/run") {
          const identityError = this.#captureIdentity(request);
          if (identityError) return identityError;
          const body = await request.json() as { instruction?: unknown };
          if (typeof body.instruction !== "string") {
            return Response.json({ success: false, error: "instruction must be a string" }, { status: 400 });
          }
          this.#session.push({ role: "user", content: body.instruction });

          const providerTools = Object.values(this.#agent.tools).map(tool => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          }));

          const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
          for (let iterations = 1; iterations <= maxIterations; iterations++) {
            const response = await config.llmProvider(this.#session, providerTools, this.#env) as any;
            const message = response.choices?.[0]?.message;
            if (!message) {
              return Response.json({ success: false, error: "LLM response malformed" }, { status: 500 });
            }
            this.#session.push(message);

            if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
              return Response.json({
                success: true,
                data: { response: message.content, iterations },
              });
            }

            for (const call of message.tool_calls) {
              const rendered = await this.#dispatchToolCall(call, config.renderToolResult);
              this.#session.push({
                role: "tool",
                tool_call_id: call.id,
                content: rendered,
              });
            }
          }

          return Response.json({
            success: false,
            error: `Max iterations (${maxIterations}) reached`,
          }, { status: 500 });
        }

        if (request.method === "POST" && url.pathname === "/_internal/reset") {
          this.#session = [{ role: "system", content: this.#agent.instructions }];
          this.#lastKnownVersion = null;
          return Response.json({ success: true });
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${url.pathname}` }, { status: 404 });
      } catch (err) {
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    }

    async #dispatchToolCall(
      call: any,
      renderer: AgentToolResultRenderer | undefined,
    ): Promise<unknown> {
      let result: AgentToolResult;
      try {
        const name = call?.function?.name;
        if (typeof name !== "string") throw new TypeError("Tool call name is missing");
        const rawArguments = typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
        const parameters = toJsonValue(rawArguments as SValue);
        result = await this.#agent.toolCall(name, parameters);
      } catch (err) {
        result = { structuredContent: { error: String(err) } };
      }

      try {
        return await (renderer ?? renderDefaultAgentToolResult)(result, {
          readBlob: blob => this.#agentContext.readBlob(blob),
        });
      } catch (err) {
        return renderDefaultAgentToolResult({
          structuredContent: { error: String(err) },
        });
      }
    }

    #captureIdentity(request: Request): Response | null {
      const userId = request.headers.get("X-User-Id");
      const docId = request.headers.get("X-Doc-Id");
      if (!userId || !docId) {
        return Response.json({ error: "Missing X-User-Id or X-Doc-Id header" }, { status: 401 });
      }
      if ((this.#userId !== null && this.#userId !== userId)
        || (this.#docId !== null && this.#docId !== docId)) {
        return Response.json({ error: "Operator identity mismatch" }, { status: 403 });
      }
      this.#docId = docId;
      this.#userId = userId;
      this.#identityHeaders = new Headers();
      for (const name of ["X-User-Id", "X-Doc-Id", "X-Doc-Type", "X-Internal-Token"]) {
        const value = request.headers.get(name);
        if (value) this.#identityHeaders.set(name, value);
      }
      return null;
    }

    async #query(query: SValueType<TQuery>): Promise<{ data: SValue; version: number }> {
      const response = await this.#editorValueRequest("/_internal/query", query as unknown as SValue);
      const value = await decodeValueResponse(response);
      if (!response.ok || !isRecord(value) || value.success !== true || typeof value.version !== "number") {
        throw editorError("query", value);
      }
      this.#lastKnownVersion = value.version;
      if (!("data" in value)) throw new Error("Editor query response has no data");
      return { data: value.data, version: value.version };
    }

    async #apply(
      operations: readonly SValueType<TOp>[],
      description: string,
    ): Promise<{ version: number }> {
      if (this.#lastKnownVersion === null) {
        throw new Error("No version known. Query the document before applying changes.");
      }
      const response = await this.#editorValueRequest("/_internal/apply", {
        operations: operations as unknown as readonly SValue[],
        description,
        baseVersion: this.#lastKnownVersion,
      });
      const value = await response.json() as {
        success?: unknown;
        version?: unknown;
        error?: unknown;
      };
      if (typeof value.version === "number") this.#lastKnownVersion = value.version;
      if (!response.ok || value.success !== true || typeof value.version !== "number") {
        throw new Error(`Editor apply failed: ${String(value.error ?? response.statusText)}`);
      }
      return { version: value.version };
    }

    async #resolveBlob(hash: string): Promise<SBlob> {
      const response = await this.#editorValueRequest("/_internal/resolve_blob", { hash });
      const value = await decodeValueResponse(response);
      if (!response.ok || !isRecord(value) || !isSBlob(value.blob)) {
        throw editorError("resolve blob", value);
      }
      return value.blob;
    }

    async #readBlob(blob: SBlob): Promise<SBlobData> {
      const response = await this.#editorValueRequest("/_internal/read_blob", { blob });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Editor read blob failed: ${error || response.statusText}`);
      }
      const contentType = response.headers.get("Content-Type");
      if (!contentType) throw new Error("Editor blob response has no Content-Type");
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType,
      };
    }

    #editorValueRequest(path: string, value: SValue): Promise<Response> {
      if (!this.#docId || !this.#userId) throw new Error("Agent has no document identity");
      const headers = new Headers(this.#identityHeaders);
      headers.set("Content-Type", SValueContentType);
      headers.set("Accept", SValueContentType);
      const bytes = encodeSValue(value);
      return config.getEditorStub(this.#env, this.#userId, this.#docId).fetch(`http://editor${path}`, {
        method: "POST",
        headers,
        body: Uint8Array.from(bytes).buffer,
      });
    }
  };
}

export function renderDefaultAgentToolResult(result: AgentToolResult): string {
  const media = result.content?.filter(part => part.type !== "text") ?? [];
  if (media.length > 0) {
    throw new Error("Multimodal tool result requires a provider-specific renderer");
  }
  const text = result.content?.flatMap(part => part.type === "text" ? [part.text] : []) ?? [];
  if (result.structuredContent === undefined) {
    if (text.length === 0) return "{}";
    if (text.length === 1) return text[0];
    return text.join("\n");
  }
  const structuredContent = toJsonValue(result.structuredContent);
  if (text.length === 0) return JSON.stringify(structuredContent);
  return JSON.stringify({
    structuredContent,
    content: text,
  });
}

async function decodeValueResponse(response: Response): Promise<SValue> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.toLowerCase() === SValueContentType) {
    return decodeSValue(new Uint8Array(await response.arrayBuffer()));
  }
  return toJsonValue(await response.json() as SValue);
}

function isRecord(value: SValue): value is { readonly [key: string]: SValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isSBlob(value);
}

function editorError(operation: string, value: SValue): Error {
  const message = isRecord(value) && typeof value.error === "string"
    ? value.error
    : JSON.stringify(toJsonValue(value));
  return new Error(`Editor ${operation} failed: ${message}`);
}
