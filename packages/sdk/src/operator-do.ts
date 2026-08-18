/**
 * Operator Durable Object for document-type-specific AI agents.
 *
 * Each Operator wraps a DocumentType's tools and runs a ReAct loop,
 * calling the Editor DO to execute operations. It maintains conversation
 * history and enforces optimistic locking (read-before-write).
 *
 * Key behaviors:
 * - query_ tools return { data, version } — version is tracked for locking
 * - apply_ tools use the last known version as baseVersion
 * - If 409 conflict, the error includes current version so LLM can retry
 */

import type { DocumentType } from "./types.js";

export interface OperatorConfig<TDoc, TQuery, TOp> extends DocumentType<TDoc, TQuery, TOp> {
  /** LLM provider function: takes messages + tools, returns completion. */
  llmProvider: (messages: unknown[], tools: unknown[]) => Promise<unknown>;
  /** Factory to get Editor DO stub for a given docId. */
  getEditorStub: (docId: string) => DurableObjectStub;
}

export interface OperatorDOInstance {
  fetch(request: Request): Promise<Response>;
}

export type OperatorDOClass = new (ctx: DurableObjectState, env: unknown) => OperatorDOInstance;

export function createOperatorDO<TDoc, TQuery, TOp>(config: OperatorConfig<TDoc, TQuery, TOp>): OperatorDOClass {
  return class OperatorDO {
    #session: unknown[] = [{ role: "system", content: config.instructions }];
    #lastKnownVersion: number | null = null;
    #ctx: DurableObjectState;

    constructor(ctx: DurableObjectState, _env: unknown) {
      this.#ctx = ctx;
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;
      const endpoint = url.pathname;

      try {
        // POST /_internal/run — execute a ReAct loop
        if (method === "POST" && endpoint === "/_internal/run") {
          const body = await request.json() as { instruction: string };
          this.#session.push({ role: "user", content: body.instruction });

          const tools = Object.values(config.tools).map(t => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          }));

          let iterations = 0;
          const maxIterations = 10;

          while (iterations < maxIterations) {
            iterations++;

            const response = await config.llmProvider(this.#session, tools) as any;
            const message = response.choices?.[0]?.message;

            if (!message) {
              return Response.json({ success: false, error: "LLM response malformed" }, { status: 500 });
            }

            this.#session.push(message);

            // If no tool calls, we're done — return final response
            if (!message.tool_calls || message.tool_calls.length === 0) {
              return Response.json({
                success: true,
                data: { response: message.content, iterations },
              });
            }

            // Execute tool calls — route to Editor
            for (const call of message.tool_calls) {
              const toolName = call.function.name;
              const args = JSON.parse(call.function.arguments);

              let result: unknown;
              try {
                const editorStub = config.getEditorStub(this.#ctx.id.toString());

                if (toolName.startsWith("query_")) {
                  // Query operation — track version from response
                  const queryKind = toolName.slice(6);
                  const resp = await editorStub.fetch("http://editor/_internal/query", {
                    method: "POST",
                    body: JSON.stringify({ kind: queryKind, payload: args }),
                  });
                  const json = await resp.json() as { success: boolean; data: unknown; version: number };
                  if (json.success) {
                    this.#lastKnownVersion = json.version;
                    result = { data: json.data, version: json.version };
                  } else {
                    result = json;
                  }
                } else if (toolName.startsWith("apply_")) {
                  // Apply operation — enforce optimistic lock with last known version
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
                    const json = await resp.json() as { success: boolean; version: number; error?: string };
                    if (json.success) {
                      this.#lastKnownVersion = json.version;
                      result = { success: true, version: json.version };
                    } else {
                      // Version conflict — tell LLM the current version so it can retry
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

          return Response.json({
            success: false,
            error: `Max iterations (${maxIterations}) reached`,
          }, { status: 500 });
        }

        // POST /_internal/reset — clear session
        if (method === "POST" && endpoint === "/_internal/reset") {
          this.#session = [{ role: "system", content: config.instructions }];
          this.#lastKnownVersion = null;
          return Response.json({ success: true });
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${endpoint}` }, { status: 404 });
      } catch (err) {
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    }
  };
}
