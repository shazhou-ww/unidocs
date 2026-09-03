import { describe, expect, it } from "vitest";
import type { DocumentAgent } from "@unidocs/protocol";
import { createOperatorDO } from "../src/operator-do-agent.js";

type Q = { kind: string };
type O = { kind: string; payload: Record<string, unknown> };

const agentFor = (label: string): DocumentAgent<Q, O> => ({
  instructions: label,
  tools: [{
    kind: "query", name: "getLayers", description: "READ.",
    inputSchema: { type: "object", properties: {} },
    toQuery: () => ({ kind: "getLayers" }) as never,
  }],
});

describe("OperatorConfig.agent 支持按 env 构造", () => {
  it("传常量时照旧可用", () => {
    expect(() => createOperatorDO<Q, O, { KEY?: string }>({
      agent: agentFor("常量"),
      provider: () => ({ complete: async () => ({ content: [] }) }),
      getEditorStub: () => ({} as DurableObjectStub),
    })).not.toThrow();
  });

  it("传函数时用 env 构造 —— 和 provider 同形", () => {
    const seen: unknown[] = [];
    const Klass = createOperatorDO<Q, O, { KEY?: string }>({
      agent: env => { seen.push(env); return agentFor("工厂"); },
      provider: () => ({ complete: async () => ({ content: [] }) }),
      getEditorStub: () => ({} as DurableObjectStub),
    });
    // 构造 DO 本身不该调工厂 —— agent 和 provider 一样是惰性建的
    new Klass({} as DurableObjectState, { KEY: "k" });
    expect(seen).toEqual([]);
  });
});
