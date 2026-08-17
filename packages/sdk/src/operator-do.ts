/**
 * OperatorDO — base Durable Object for agent-driven document operations.
 *
 * Wraps the Editor with a ReAct loop, tool dispatch, and LLM integration.
 */

import type { DocumentType } from "./types.js";

export interface OperatorConfig<TDoc, TQuery, TOp> extends DocumentType<TDoc, TQuery, TOp> {
  /** LLM provider function: takes messages, returns completion with tool calls. */
  llmProvider: (messages: unknown[], tools: unknown[]) => Promise<unknown>;
  /** Editor DO stub for making HTTP calls. */
  editorStub: DurableObjectStub;
}

export function createOperatorDO<TDoc, TQuery, TOp>(config: OperatorConfig<TDoc, TQuery, TOp>) {
  return class OperatorDO {
    #session: unknown[] = [];

    constructor(ctx: DurableObjectState, env: unknown) {
      // Session state managed internally
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;

      try {
        // POST /run — execute a ReAct loop with a user instruction
        if (method === "POST" && url.pathname === "/run") {
          const body = await request.json() as { instruction: string };
          this.#session.push({ role: "user", content: body.instruction });

          let iterations = 0;
          const maxIterations = 10;

          while (iterations < maxIterations) {
            iterations++;

            const tools = Object.values(config.tools).map(t => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              },
            }));

            const response = await config.llmProvider(this.#session, tools) as any;
            const message = response.choices?.[0]?.message;

            if (!message) {
              return Response.json({ success: false, error: "LLM response malformed" }, { status: 500 });
            }

            this.#session.push(message);

            if (!message.tool_calls || message.tool_calls.length === 0) {
              return Response.json({
                success: true,
                data: { response: message.content, iterations },
              });
            }

            for (const call of message.tool_calls) {
              const toolName = call.function.name;
              const args = JSON.parse(call.function.arguments);

              let result: unknown;
              try {
                if (toolName.startsWith("query_")) {
                  const queryKind = toolName.slice(6);
                  const query = { kind: queryKind, payload: args };
                  const resp = await config.editorStub.fetch("http://editor/query", {
                    method: "POST",
                    body: JSON.stringify(query),
                  });
                  result = await resp.json();
                } else if (toolName.startsWith("apply_")) {
                  const opKind = toolName.slice(6);
                  const operation = { kind: opKind, payload: args };
                  const resp = await config.editorStub.fetch("http://editor/apply", {
                    method: "POST",
                    body: JSON.stringify({ operation, description: `Operator tool: ${toolName}` }),
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

        // POST /reset — clear session
        if (method === "POST" && url.pathname === "/reset") {
          this.#session = [];
          return Response.json({ success: true });
        }

        return new Response("Not found", { status: 404 });
      } catch (err) {
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    }
  };
}
