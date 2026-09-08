/**
 * `createDoFontProvider` 跑中立层的共享契约（doctype-server-common 的
 * font-provider-contract）—— 与内存实现验证的是同一份行为，后端换成真的
 * `PsdFontsDurableObject`。
 *
 * `makeStubNamespace()` 抄的是 fonts-do.test.ts 里给 DO 造 sqlite 假体的
 * 同一招（`node:sqlite` 的 `DatabaseSync`），只是多包一层
 * `get`/`idFromName`，让它看起来像一个 `DurableObjectNamespace`。
 *
 * 关键的隔离点：契约里的 `make()` 每条用例都会被单独调用一次，而这里
 * `makeStubNamespace()` 每次调用都新建一个空 `Map`，`Map` 里按对象名懒建
 * `PsdFontsDurableObject`（各自持有独立的内存 sqlite）。所以哪怕两条用例用
 * 的是同一个 `objectName`，它们背后也是两个互不相干的 DO 实例 —— 不会出现
 * "同名登记两次只剩一条"这类断言被前一条用例的残留数据污染成假绿的情况。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runFontProviderContract } from "@unidocs/doctype-server-common/font-provider-contract";
import { createDoFontProvider } from "../src/font-provider-do.js";
import { PsdFontsDurableObject } from "../src/fonts-do.js";

/** `ctx.storage.sql` 的形状，背后是一个真的内存 sqlite。同 fonts-do.test.ts。 */
function fontsState(): DurableObjectState {
  const db = new DatabaseSync(":memory:");
  return {
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          const rows = db.prepare(query).all(...(bindings as never[]));
          return { toArray: () => rows };
        },
      },
    },
  } as unknown as DurableObjectState;
}

/**
 * 只有 `get`/`idFromName` 的假 namespace，把 `PsdFontsDurableObject` 包一层。
 * 每次调用本函数都新建一个空的 instances Map，所以每个 `make()` 拿到的都是
 * 全新、互相隔离的后端。
 */
function makeStubNamespace(): DurableObjectNamespace {
  const instances = new Map<string, PsdFontsDurableObject>();
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      let instance = instances.get(name);
      if (!instance) {
        instance = new PsdFontsDurableObject(fontsState());
        instances.set(name, instance);
      }
      const bound = instance;
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          bound.fetch(new Request(input as RequestInfo, init)),
      };
    },
  } as unknown as DurableObjectNamespace;
}

runFontProviderContract("createDoFontProvider", async () =>
  createDoFontProvider({ namespace: makeStubNamespace(), objectName: "s1|t1" }));

/**
 * 存储层故障时适配器要抛，不能吞。
 *
 * 中立的 `handleFontsRequest` 不兜底 provider 的 `list/put` 抛出的异常 —— 那是
 * `worker.ts` 那层顶层 try/catch 的责任（把它变成 500）。这两条用例锁住的是
 * 前一半：DO 侧一旦不返回 2xx，`createDoFontProvider` 必须让异常穿出去，
 * `worker.ts` 的 catch 才有东西可接。
 */
describe("createDoFontProvider 的故障穿透", () => {
  const failingNamespace = (status: number): DurableObjectNamespace => ({
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => Response.json({ error: "boom" }, { status }),
    }),
  } as unknown as DurableObjectNamespace);

  it("list() 遇到非 2xx 响应会抛，不是吞掉返回空数组", async () => {
    const provider = createDoFontProvider({ namespace: failingNamespace(500), objectName: "s1|t1" });
    await expect(provider.list()).rejects.toThrow(/Font index request failed 500/);
  });

  it("put() 遇到非 2xx 响应会抛，不是静默当成功", async () => {
    const provider = createDoFontProvider({ namespace: failingNamespace(400), objectName: "s1|t1" });
    await expect(provider.put({
      postScriptName: "NotoSans-Regular",
      family: "Noto Sans",
      hash: "a".repeat(64),
      unitsPerEm: 1000,
      coverage: [[0x20, 0x7e]],
    })).rejects.toThrow(/Font registration failed 400/);
  });
});
