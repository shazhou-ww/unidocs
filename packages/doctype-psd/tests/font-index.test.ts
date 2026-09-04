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
import { createFontIndex } from "../src/text/font-index.js";
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
