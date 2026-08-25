/**
 * OperatorSession — the cloud-neutral ReAct loop for document-type-specific
 * AI agents.
 *
 * This is the algorithm that used to live inside `OperatorDO`
 * (cloudflare-sdk/src/operator-do.ts). It owns:
 *
 *   - the conversation history (`#session`)
 *   - the ReAct loop (max 10 iterations)
 *   - `query_`/`apply_` tool-name dispatch to the Editor
 *   - optimistic-lock bookkeeping: the version returned by the last
 *     `query_` call becomes the `baseVersion` of the next `apply_` call;
 *     an `apply_` call before any `query_` is refused.
 *
 * It owns no transport concerns: HTTP request/response handling — reading
 * `request.json()`, mapping outcomes to `Response.json(...)` with a status
 * code, routing `/_internal/run` and `/_internal/reset` — stays in the DO
 * shell (`operator-do.ts`). `llmProvider` and `getEditorStub` are supplied
 * by the caller; this file never decides what they do (both are currently
 * throwing stubs everywhere they are wired up).
 */

import type { AgentToolDefinition } from "@unidocs/protocol";

/**
 * Structural view of a Durable Object stub. Deliberately not
 * `DurableObjectStub` — server-core stays cloud-neutral (no Cloudflare
 * imports), and Cloudflare's real stub type is structurally compatible
 * with this shape (see `doc-type-handler.ts`'s `DoNamespaceLike` for the
 * same trick applied to `DurableObjectNamespace`).
 */
export interface EditorStubLike {
  fetch(url: string, init?: { method?: string; body?: string }): Promise<Response>;
}

export interface OperatorSessionConfig {
  /** Agent tool definitions — only `name`/`description`/`inputSchema` are used. */
  tools: Record<string, AgentToolDefinition>;
  /** Document-type-specific operator instructions (the system message). */
  instructions: string;
  /** LLM provider function: takes messages + tools, returns completion. */
  llmProvider: (messages: unknown[], tools: unknown[]) => Promise<unknown>;
  /** Factory to get an Editor stub for a given sessionId. */
  getEditorStub: (sessionId: string) => EditorStubLike;
}

/** Outcome of one `run()` call — mirrors the JSON body the DO used to return. */
export type OperatorRunOutcome =
  | { success: true; response: unknown; iterations: number }
  | { success: false; error: string };

const MAX_ITERATIONS = 10;

export class OperatorSession {
  readonly #config: OperatorSessionConfig;
  #session: unknown[];
  #lastKnownVersion: number | null = null;

  constructor(config: OperatorSessionConfig) {
    this.#config = config;
    this.#session = [{ role: "system", content: config.instructions }];
  }

  /** Clear conversation history and the optimistic-lock version. */
  reset(): void {
    this.#session = [{ role: "system", content: this.#config.instructions }];
    this.#lastKnownVersion = null;
  }

  /**
  * Run one ReAct loop turn for `sessionId`, seeded with `instruction`.
   * Mirrors `OperatorDO#fetch`'s `/_internal/run` body from before the
   * server-core split, verbatim in behavior.
   */
  async run(sessionId: string, instruction: string): Promise<OperatorRunOutcome> {
    this.#session.push({ role: "user", content: instruction });

    const tools = Object.values(this.#config.tools).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = (await this.#config.llmProvider(this.#session, tools)) as any;
      const message = response.choices?.[0]?.message;

      if (!message) {
        return { success: false, error: "LLM response malformed" };
      }

      this.#session.push(message);

      // If no tool calls, we're done — return final response.
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return { success: true, response: message.content, iterations };
      }

      // Execute tool calls — route to Editor.
      for (const call of message.tool_calls) {
        const toolName = call.function.name;
        const args = JSON.parse(call.function.arguments);

        let result: unknown;
        try {
          const editorStub = this.#config.getEditorStub(sessionId);

          if (toolName.startsWith("query_")) {
            // Query operation — track version from response.
            const queryKind = toolName.slice(6);
            const resp = await editorStub.fetch("http://editor/_internal/query", {
              method: "POST",
              body: JSON.stringify({ kind: queryKind, payload: args }),
            });
            const json = (await resp.json()) as { success: boolean; data: unknown; version: number };
            if (json.success) {
              this.#lastKnownVersion = json.version;
              result = { data: json.data, version: json.version };
            } else {
              result = json;
            }
          } else if (toolName.startsWith("apply_")) {
            // Apply operation — enforce optimistic lock with last known version.
            const opKind = toolName.slice(6);

            if (this.#lastKnownVersion === null) {
              result = { error: "No version known. You must query the document first before applying changes." };
            } else {
              const resp = await editorStub.fetch("http://editor/_internal/apply", {
                method: "POST",
                body: JSON.stringify({
                  operations: [{ kind: opKind, payload: args }],
                  description: `Operator: ${toolName}`,
                  baseVersion: this.#lastKnownVersion,
                }),
              });
              const json = (await resp.json()) as { success: boolean; version: number; error?: string };
              if (json.success) {
                this.#lastKnownVersion = json.version;
                result = { success: true, version: json.version };
              } else {
                // Version conflict — tell LLM the current version so it can retry.
                result = {
                  error: json.error,
                  currentVersion: json.version,
                  hint: "Re-query the document to get the latest version, then retry your changes.",
                };
                if (json.version) {
                  this.#lastKnownVersion = json.version;
                }
              }
            }
          } else {
            result = { error: `Unknown tool: ${toolName}` };
          }
        } catch (err) {
          result = { error: String(err) };
        }

        this.#session.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    return { success: false, error: `Max iterations (${MAX_ITERATIONS}) reached` };
  }
}
