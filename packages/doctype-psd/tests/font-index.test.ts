/**
 * `createFontIndex` 的缓存不变式 —— 从 `cloudflare-psd/tests/fonts-source.test.ts`
 * 搬来（Task 5）。60 秒缓存那段现在是中立实现，两个平台共用；后端从"假 DO
 * namespace"换成一个计数的假 `FontRegistry`。三条不变式：
 *   - TTL 内只打一次后端；
 *   - TTL 过期后重打（新登记的字体不该等到实例被回收才可见）；
 *   - 失败不留在缓存里（一次抖动不该被整整记住一个 TTL）。
 * 并发缓存的是 Promise 这一条单独一个用例——它和"TTL 内只打一次"是同一个
 * 不变式的两个角度（一个测顺序调用，一个测并发调用），一起搬。
 */
import { describe, expect, it, vi } from "vitest";
import type { FontRegistry } from "@unidocs/doctype-server-common";
import { sBlobSignature, type SBlob } from "@unidocs/protocol";
import { createFontIndex, parseFontFallbacks } from "../src/text/font-index.js";
import type { FontEntry } from "../src/text/registry.js";

const HASH_A = "a".repeat(64);

const latin: FontEntry = {
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: HASH_A,
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
};

/** blobFor 是调用方注入的；测试不关心它产出什么，只要是个合法 SBlob。 */
const fakeBlobFor = (entry: FontEntry): SBlob => ({ [sBlobSignature]: true, hash: entry.hash });

/** 计数的假 FontRegistry —— list() 每次调用都记一次，用于断言打了几次后端。 */
function fakeRegistry(entries: readonly FontEntry[]): { registry: FontRegistry; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () => entries);
  const registry: FontRegistry = {
    list,
    put: async () => { throw new Error("not used in these tests"); },
  };
  return { registry, list };
}

describe("createFontIndex 的缓存", () => {
  it("TTL 之内第二次 load 不再打后端", async () => {
    const { registry, list } = fakeRegistry([latin]);
    let clock = 0;
    const source = createFontIndex({ registry, fallbacks: [], blobFor: fakeBlobFor, now: () => clock });

    await source.load();
    clock = 59_999;
    await source.load();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("TTL 过了重新打一次 —— 新登记的字体不该等到实例被回收才可见", async () => {
    const { registry, list } = fakeRegistry([latin]);
    let clock = 0;
    const source = createFontIndex({ registry, fallbacks: [], blobFor: fakeBlobFor, now: () => clock });

    await source.load();
    clock = 60_000;
    await source.load();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("并发的两次 load 只打一次后端（缓存的是 Promise）", async () => {
    const { registry, list } = fakeRegistry([latin]);
    const source = createFontIndex({ registry, fallbacks: [], blobFor: fakeBlobFor, now: () => 0 });

    await Promise.all([source.load(), source.load()]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("失败不进缓存 —— 一次抖动不该被记住一整个 TTL", async () => {
    let failing = true;
    const list = vi.fn(async () => {
      if (failing) throw new Error("boom");
      return [latin];
    });
    const registry: FontRegistry = { list, put: async () => {} };
    const source = createFontIndex({ registry, fallbacks: [], blobFor: fakeBlobFor, now: () => 0 });

    await expect(source.load()).rejects.toThrow(/boom/);
    failing = false;
    await expect(source.load()).resolves.toBeInstanceOf(Map);
    expect(list).toHaveBeenCalledTimes(2);
  });
});

/**
 * 从 `cloudflare-psd/tests/fonts-source.test.ts` 搬来（Task 8）—— 实现搬到了
 * 这个包，用例跟着走。两个平台读的是同一个 `PSD_FONT_FALLBACKS`，语义只有
 * 一份，测试留在某一个平台包里就等于只有那一半被守住。
 */
describe("parseFontFallbacks", () => {
  it("逗号分隔，去空白，顺序即优先级", () => {
    expect(parseFontFallbacks("NotoSans, NotoSansSC")).toEqual(["NotoSans", "NotoSansSC"]);
  });

  it("缺省和空串都是空链，不硬编码任何字体名", () => {
    // 硬编码一个 CAS 里可能不存在的名字，回退链只会静默失效 ——
    // resolveFaceChain 对没装载的候选是直接跳过，不报错。
    expect(parseFontFallbacks(undefined)).toEqual([]);
    expect(parseFontFallbacks("")).toEqual([]);
    expect(parseFontFallbacks(" , ")).toEqual([]);
  });
});
