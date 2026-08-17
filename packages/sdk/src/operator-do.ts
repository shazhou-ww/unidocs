/**
 * OperatorDO — base Durable Object for agent-driven document operations.
 *
 * Wraps the Editor with a ReAct loop, tool dispatch, and LLM integration.
 *
 * Internal endpoints (called by Gateway):
 *   POST /_internal/run    — execute ReAct loop (body: { instruction })
 *   POST /_internal/reset  — clear operator session
 */

import type { DocumentType } from "./types.js";

export interface OperatorConfig<TDoc, TQuery, TOp> extends DocumentType<TDoc, TQuery, TOp> {
  /** LLM provider function: takes messages, returns completion with tool calls. */
  llmProvider: (messages: unknown[], tools: unknown[]) => Promise<unknown>;
  /** Factory to get Editor DO stub for a given docId. */
  getEditorStub: (docId: string) => DurableObjectStub;
}

export function createOperatorDO<TDoc, TQuery, TOp>(config: OperatorConfig<TDoc, TQuery, TOp>) {
  return class OperatorDO {
    #session: unknown[] = [];
    #ctx: DurableObjectState;

    constructor(ctx: DurableObjectState, env: unknown) {
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
                  const queryKind = toolName.slice(6);
                  const resp = await editorStub.fetch("http://editor/_internal/query", {
                    method: "POST",
                    body: JSON.stringify({ kind: queryKind, payload: args }),
                  });
                  result = await resp.json();
                } else if (toolName.startsWith("apply_")) {
                  const opKind = toolName.slice(6);
                  const resp = await editorStub.fetch("http://editor/_internal/apply", {
                    method: "POST",
                    body: JSON.stringify({
                      operation: { kind: opKind, payload: args },
                      description: `Operator: ${toolName}`,
                      baseVersion: null, // Operator will need to fetch current version first
                    }),
                  });
                  result = await resp.json();
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
          this.#session = [];
          return Response.json({ success: true });
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${endpoint}` }, { status: 404 });
      } catch (err) {
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    }
  };
}
