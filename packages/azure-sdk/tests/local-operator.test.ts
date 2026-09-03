import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { AgentPlatform, DocumentAgent } from "@unidocs/protocol";
import { createPool, runMigrations, PgSessionIdentityStore, PgAgentSessionStore, AGENT_LEASE_SECONDS } from "../src/index.js";
import { createLocalOperatorNamespace } from "../src/local-operator.js";
import { DATABASE_URL } from "./containers.js";

let pool: Pool;
let seq = 0;

const agent: DocumentAgent<unknown, unknown> = { tools: [], instructions: "sys" };

/** 每次 complete 都直接收工，并把收到的 messages 记下来。 */
function recordingProvider() {
  const seen: unknown[][] = [];
  return {
    seen,
    provider: {
      async complete(req: { messages: readonly unknown[] }) {
        seen.push([...req.messages]);
        return { content: [{ type: "text", text: "ok" }], toolCalls: [] };
      },
    } as never,
  };
}

/** 编辑器永远不会被这个 agent 调到（工具表是空的）。 */
const editor = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("{}") }) };

function headers(sessionId: string): HeadersInit {
  return {
    "X-Tenant-Id": "t-op",
    "X-Session-Id": sessionId,
    "X-Doc-Type": "psd",
    "X-UniDocs-Auth-Context": "capability",
    "Content-Type": "application/json",
  };
}

async function freshSession(): Promise<string> {
  const sessionId = `op-${++seq}-${Date.now()}`;
  await new PgSessionIdentityStore(pool).register({ tenantId: "t-op", docType: "psd", sessionId });
  return sessionId;
}

beforeAll(async () => {
  pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
});
afterAll(async () => { await pool.end(); });

function ns(provider: never) {
  return createLocalOperatorNamespace({ pool, editor, agent, provider, docType: "psd" });
}

/** 断言一次 /run 真的成功了，不是被内核的 catch-all 兜成了 500。 */
async function expectRunOk(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ success: true });
}

describe("createLocalOperatorNamespace", () => {
  it("/run 跑通并返回与 CF 同形的响应体", async () => {
    const sessionId = await freshSession();
    const { provider } = recordingProvider();
    const res = await ns(provider).get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: "你好" }) },
    ));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { response: "ok" } });
  });

  // 这是整件事的目的：Azure 是多副本，历史必须活过请求边界。两次调用都要
  // 先证明"这次 run 真的成功了"，否则"看得见第一次对话"这条断言在每次 run
  // 都 500 的情况下也会通过——那证明的只是 finally 里写回执行了，不是一次
  // 成功的对话被正确接续。
  it("第二次 /run 时模型看得见第一次的对话", async () => {
    const sessionId = await freshSession();
    const { provider, seen } = recordingProvider();
    const namespace = ns(provider);
    const call = (text: string) => namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: text }) },
    ));

    await expectRunOk(await call("第一句"));
    await expectRunOk(await call("第二句"));

    expect(JSON.stringify(seen[1])).toContain("第一句");
  });

  it("/reset 之后历史清空", async () => {
    const sessionId = await freshSession();
    const { provider, seen } = recordingProvider();
    const namespace = ns(provider);
    const call = (text: string) => namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: text }) },
    ));

    await expectRunOk(await call("第一句"));
    const reset = await namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/reset", { method: "POST", headers: headers(sessionId) },
    ));
    expect(await reset.json()).toEqual({ success: true });

    await expectRunOk(await call("第二句"));
    expect(JSON.stringify(seen[1])).not.toContain("第一句");
  });

  it("instruction 不是字符串 -> 400", async () => {
    const sessionId = await freshSession();
    const { provider } = recordingProvider();
    const res = await ns(provider).get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: 42 }) },
    ));
    expect(res.status).toBe(400);
  });

  it("缺身份头 -> 401", async () => {
    const { provider } = recordingProvider();
    const res = await ns(provider).get("x").fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction: "a" }) },
    ));
    expect(res.status).toBe(401);
  });

  it("未知端点 -> 404", async () => {
    const sessionId = await freshSession();
    const { provider } = recordingProvider();
    const res = await ns(provider).get(sessionId).fetch(new Request(
      "http://operator/_internal/nope", { method: "POST", headers: headers(sessionId) },
    ));
    expect(res.status).toBe(404);
  });

  // 评审 Important #1：身份校验必须在路由分支内部，不能在分发之前。CF 的
  // #captureIdentity 只在 /_internal/run 与 /_internal/reset 分支内部调用，
  // 所以"缺身份头 + 未知端点"在 CF 上是 404（路由先判），不是 401。这条钉住
  // 那个顺序，不给它退化成"先判身份、后判路由"。
  it("缺身份头 + 未知端点 -> 404（不是 401，与 CF 逐字对齐：先判路由再判身份）", async () => {
    const { provider } = recordingProvider();
    const res = await ns(provider).get("x").fetch(new Request(
      "http://operator/_internal/nope",
      { method: "POST", headers: { "Content-Type": "application/json" } },
    ));
    expect(res.status).toBe(404);
  });

  // 租约在 HTTP 这一层的表现。慢 provider 让第一次 run 悬着，第二次就撞上。
  it("同一文档并发 /run -> 第二个 409", async () => {
    const sessionId = await freshSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = {
      async complete() { await gate; return { content: [{ type: "text", text: "ok" }], toolCalls: [] }; },
    } as never;
    const namespace = ns(provider);
    const call = () => namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: "a" }) },
    ));

    const first = call();
    await new Promise((r) => setTimeout(r, 50));   // 让第一次抢到租约
    const second = await call();
    expect(second.status).toBe(409);

    release();
    await expectRunOk(await first);
  });

  // 写回放 finally 的证据。CF 的 #history.push 在 try 之前(session.ts:81),
  // 失败那轮也留在历史里;两条运行时在"重试时模型看到什么"上必须一致。
  // 这条故意要第一次调用失败 —— 不给它加成功断言。
  it("run 失败时历史仍被写回，含失败那轮的 user 消息", async () => {
    const sessionId = await freshSession();
    const seen: unknown[][] = [];
    let failNext = true;
    const provider = {
      async complete(req: { messages: readonly unknown[] }) {
        seen.push([...req.messages]);
        if (failNext) { failNext = false; throw new Error("provider 挂了"); }
        return { content: [{ type: "text", text: "ok" }], toolCalls: [] };
      },
    } as never;
    const namespace = ns(provider);
    const call = (t: string) => namespace.get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: t }) },
    ));

    await call("失败的那句");
    await expectRunOk(await call("重试"));

    expect(JSON.stringify(seen[1])).toContain("失败的那句");
  });

  // 评审 Important #2：acquire() 成功之后、session.run() 之前的每一步都可能
  // 抛 —— decodeHistory 对畸形历史（未知 part 类型 / role）是故意设计成抛
  // 错而不是静默丢弃的（history-codec.ts）。这不是假设的风险：直接往库里
  // 塞一段畸形历史，验证 /run 会 500，但租约不会跟着悬空到 1800 秒——
  // release() 必须在 decodeHistory 抛出之后依然执行。
  it("acquire 之后 decodeHistory 抛出仍要释放租约，不留悬空", async () => {
    const sessionId = await freshSession();
    const identity = { tenantId: "t-op", docType: "psd", sessionId };

    const seedStore = new PgAgentSessionStore(pool, identity);
    await seedStore.acquire(AGENT_LEASE_SECONDS);
    // 一个未知的 content part 类型 —— decodePart 对此故意 fail()，不是
    // 静默丢弃。
    await seedStore.release([{ role: "user", content: [{ type: "not-a-real-part" }] }] as never);

    const { provider } = recordingProvider();
    const res = await ns(provider).get(sessionId).fetch(new Request(
      "http://operator/_internal/run",
      { method: "POST", headers: headers(sessionId), body: JSON.stringify({ instruction: "a" }) },
    ));
    expect(res.status).toBe(500);

    // 证明租约真的被释放了，不是悬空到自然过期：另一个 store 现在能立刻
    // 拿到租约（不是 null）。
    const verifyStore = new PgAgentSessionStore(pool, identity);
    expect(await verifyStore.acquire(AGENT_LEASE_SECONDS)).not.toBeNull();
  });
});
