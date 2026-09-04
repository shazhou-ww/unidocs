/**
 * 打真 Postgres（容器由 tests/containers.ts 的 globalSetup 起一次），
 * 与 ports.test.ts 同一套夹具。租约的正确性只有真库能证明 —— 它靠的是
 * 一条 UPDATE 的原子性，用假 pool 测等于测自己写的假货。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool, runMigrations, PgSessionIdentityStore } from "../src/index.js";
import { PgAgentSessionStore, AGENT_LEASE_SECONDS } from "../src/agent-session-store.js";
import { DATABASE_URL } from "./containers.js";

const identity = { tenantId: "t-agent", docType: "psd", sessionId: "" };
let pool: Pool;
let seq = 0;

/** 每个用例一份新文档 —— 外键要求 doc_sessions 里先有行。 */
async function freshIdentity() {
  const id = { ...identity, sessionId: `s-${++seq}-${Date.now()}` };
  await new PgSessionIdentityStore(pool).register(id);
  return id;
}

beforeAll(async () => {
  pool = createPool({ databaseUrl: DATABASE_URL, blobConnectionString: "" });
  await runMigrations(pool);
});
afterAll(async () => { await pool.end(); });

describe("PgAgentSessionStore", () => {
  it("第一次 acquire 拿到空历史", async () => {
    const id = await freshIdentity();
    const store = new PgAgentSessionStore(pool, id);
    expect(await store.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });

  it("release 写回的历史，下一次 acquire 读得到", async () => {
    const id = await freshIdentity();
    const store = new PgAgentSessionStore(pool, id);
    await store.acquire(AGENT_LEASE_SECONDS);
    await store.release([{ role: "user", content: [{ type: "text", text: "记住我" }] }] as never);

    expect(await store.acquire(AGENT_LEASE_SECONDS)).toEqual(
      [{ role: "user", content: [{ type: "text", text: "记住我" }] }],
    );
  });

  // 这条是租约存在的全部理由：Azure 是 2-5 副本无亲和，两个 /run 会真的
  // 同时打到同一份文档上。
  it("租约未释放时，第二个 acquire 拿不到", async () => {
    const id = await freshIdentity();
    const a = new PgAgentSessionStore(pool, id);
    const b = new PgAgentSessionStore(pool, id);

    expect(await a.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
    expect(await b.acquire(AGENT_LEASE_SECONDS)).toBeNull();
  });

  it("并发抢占只有一个赢", async () => {
    const id = await freshIdentity();
    const stores = Array.from({ length: 8 }, () => new PgAgentSessionStore(pool, id));
    const results = await Promise.all(stores.map(s => s.acquire(AGENT_LEASE_SECONDS)));
    expect(results.filter(r => r !== null)).toHaveLength(1);
  });

  it("release 之后可以再抢", async () => {
    const id = await freshIdentity();
    const a = new PgAgentSessionStore(pool, id);
    const b = new PgAgentSessionStore(pool, id);
    await a.acquire(AGENT_LEASE_SECONDS);
    await a.release([] as never);
    expect(await b.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });

  it("租约过期后可以再抢", async () => {
    const id = await freshIdentity();
    const a = new PgAgentSessionStore(pool, id);
    const b = new PgAgentSessionStore(pool, id);
    await a.acquire(-1);                       // 立刻过期
    expect(await b.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });

  // /reset 是崩溃后唯一的人工逃生口：租约 1800 秒，没有它就得干等 30 分钟。
  it("clear 清空历史，并强制释放租约", async () => {
    const id = await freshIdentity();
    const a = new PgAgentSessionStore(pool, id);
    const b = new PgAgentSessionStore(pool, id);
    await a.acquire(AGENT_LEASE_SECONDS);
    await a.release([{ role: "user", content: [{ type: "text", text: "旧的" }] }] as never);
    await a.acquire(AGENT_LEASE_SECONDS);      // 故意不 release，模拟崩溃

    await b.clear();

    expect(await b.acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });

  it("不同文档之间互不影响", async () => {
    const one = await freshIdentity();
    const two = await freshIdentity();
    await new PgAgentSessionStore(pool, one).acquire(AGENT_LEASE_SECONDS);
    expect(await new PgAgentSessionStore(pool, two).acquire(AGENT_LEASE_SECONDS)).toEqual([]);
  });
});
