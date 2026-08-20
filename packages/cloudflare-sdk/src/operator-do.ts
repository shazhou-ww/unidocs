/**
 * Operator Durable Object for document-type-specific AI agents.
 *
 * The ReAct loop itself — conversation history, `query_`/`apply_` tool
 * dispatch, optimistic-lock bookkeeping — lives in `@unidocs/server-core`'s
 * `OperatorSession`. This file is the DO shell: it owns the in-memory
 * session lifetime (recreated whenever the DO is evicted and reconstructed)
 * and the two HTTP routes (`/_internal/run`, `/_internal/reset`), including
 * request parsing and status-code mapping.
 *
 * Key behaviors (enforced by `OperatorSession`, unchanged by this split):
 * - query_ tools return { data, version } — version is tracked for locking
 * - apply_ tools use the last known version as baseVersion
 * - If 409 conflict, the error includes current version so LLM can retry
 */

import type { DocumentType } from "@unidocs/core";
import { OperatorSession } from "@unidocs/server-core";

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
    #ctx: DurableObjectState;
    #session: OperatorSession;

    constructor(ctx: DurableObjectState, _env: unknown) {
      this.#ctx = ctx;
      this.#session = new OperatorSession({
        tools: config.tools,
        instructions: config.instructions,
        llmProvider: config.llmProvider,
        getEditorStub: config.getEditorStub,
      });
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;
      const endpoint = url.pathname;

      try {
        // POST /_internal/run — execute a ReAct loop
        if (method === "POST" && endpoint === "/_internal/run") {
          const body = (await request.json()) as { instruction: string };
          const docId = this.#ctx.id.toString();
          const outcome = await this.#session.run(docId, body.instruction);

          if (outcome.success) {
            return Response.json({
              success: true,
              data: { response: outcome.response, iterations: outcome.iterations },
            });
          }
          return Response.json({ success: false, error: outcome.error }, { status: 500 });
        }

        // POST /_internal/reset — clear session
        if (method === "POST" && endpoint === "/_internal/reset") {
          this.#session.reset();
          return Response.json({ success: true });
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${endpoint}` }, { status: 404 });
      } catch (err) {
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    }
  };
}
