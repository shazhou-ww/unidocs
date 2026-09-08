import { describe, expect, it } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import type { FontEntry, FontIo, FontProvider } from "../src/index.js";
import { createFontRegistry } from "../src/index.js";

const entry = (postScriptName: string, hash: string): FontEntry => ({
  postScriptName,
  family: postScriptName.split("-")[0]!,
  hash,
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
});

/** 只读来源：blobFor 返回 null，字节直接给。 */
function fakeBuiltin(entries: readonly FontEntry[], bytes = 1): FontProvider {
  return {
    id: "builtin",
    list: async () => entries,
    read: async e => new Uint8Array([bytes, e.postScriptName.length]),
    blobFor: () => null,
  };
}

/** CAS 来源：blobFor 返回 SBlob，read 必须经过 io.readBlob。 */
function fakeTenant(entries: readonly FontEntry[]): FontProvider {
  return {
    id: "tenant",
    list: async () => entries,
    read: async (e, io) => (await io.readBlob(createSBlob(e.hash))).data,
    blobFor: e => createSBlob(e.hash),
  };
}

const io: FontIo = { readBlob: async blob => ({ data: new Uint8Array([0xca, Number.parseInt(blob.hash.slice(0, 2), 16)]) }) };

describe("createFontRegistry", () => {
  it("按顺序合成，后者按 postScriptName 覆盖前者", async () => {
    const registry = createFontRegistry({
      providers: [
        fakeBuiltin([entry("NotoSans-Regular", "a".repeat(64)), entry("NotoSansSC-Regular", "b".repeat(64))]),
        fakeTenant([entry("NotoSansSC-Regular", "c".repeat(64))]),
      ],
    });
    const index = await registry.index();
    expect([...index.keys()].sort()).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
    expect(index.get("NotoSans-Regular")!.source).toBe("builtin");
    // 同名被后来的租户来源盖掉 —— 这就是"用户主动装 external 字体"的扩展点。
    expect(index.get("NotoSansSC-Regular")!.source).toBe("tenant");
    expect(index.get("NotoSansSC-Regular")!.entry.hash).toBe("c".repeat(64));
  });

  it("read 按来源分发：内置不碰 io，租户经 io.readBlob", async () => {
    const registry = createFontRegistry({
      providers: [fakeBuiltin([entry("A-Regular", "a".repeat(64))]), fakeTenant([entry("B-Regular", "b".repeat(64))])],
    });
    const index = await registry.index();
    expect(await registry.read(index.get("A-Regular")!, io)).toEqual(new Uint8Array([1, 9]));
    expect(await registry.read(index.get("B-Regular")!, io)).toEqual(new Uint8Array([0xca, 0xbb]));
  });

  it("blobFor：内置返回 null，租户返回 SBlob", async () => {
    const registry = createFontRegistry({
      providers: [fakeBuiltin([entry("A-Regular", "a".repeat(64))]), fakeTenant([entry("B-Regular", "b".repeat(64))])],
    });
    const index = await registry.index();
    expect(registry.blobFor(index.get("A-Regular")!)).toBeNull();
    expect(registry.blobFor(index.get("B-Regular")!)!.hash).toBe("b".repeat(64));
  });

  it("索引缓存 60 秒；到期后重新合成", async () => {
    let calls = 0;
    const counting: FontProvider = {
      id: "tenant",
      list: async () => { calls++; return [entry("A-Regular", "a".repeat(64))]; },
      read: async () => new Uint8Array(),
      blobFor: () => null,
    };
    let clock = 0;
    const registry = createFontRegistry({ providers: [counting], now: () => clock });
    await registry.index();
    await registry.index();
    expect(calls).toBe(1);
    clock = 60_000;
    await registry.index();
    expect(calls).toBe(2);
  });

  it("缓存的是 Promise：并发两次只打一次后端", async () => {
    let calls = 0;
    const slow: FontProvider = {
      id: "tenant",
      list: async () => { calls++; await Promise.resolve(); return []; },
      read: async () => new Uint8Array(),
      blobFor: () => null,
    };
    const registry = createFontRegistry({ providers: [slow], now: () => 0 });
    await Promise.all([registry.index(), registry.index()]);
    expect(calls).toBe(1);
  });

  it("失败不留在缓存里：一次抖动不会被记住一整个 TTL", async () => {
    let calls = 0;
    const flaky: FontProvider = {
      id: "tenant",
      list: async () => { calls++; if (calls === 1) throw new Error("boom"); return []; },
      read: async () => new Uint8Array(),
      blobFor: () => null,
    };
    const registry = createFontRegistry({ providers: [flaky], now: () => 0 });
    await expect(registry.index()).rejects.toThrow("boom");
    await expect(registry.index()).resolves.toBeInstanceOf(Map);
    expect(calls).toBe(2);
  });

  it("一个来源挂了不拖垮其它来源，但必须报出来", async () => {
    // 这条是设计文档「错误处理」里那句"租户 provider 不可达：只影响租户那一层，
    // 内置那一层仍然可用"的守卫。静默吞掉是不行的 —— 租户装的字体凭空消失、
    // 排出来的字换了个字形而没有任何信号，正是这条链一直在消灭的故障形态。
    const reported: Array<{ id: string; message: string }> = [];
    const registry = createFontRegistry({
      providers: [
        fakeBuiltin([entry("A-Regular", "a".repeat(64))]),
        { id: "tenant", list: async () => { throw new Error("DO unreachable"); },
          read: async () => new Uint8Array(), blobFor: () => null },
      ],
      onProviderError: (id, error) => reported.push({ id, message: (error as Error).message }),
    });
    const index = await registry.index();
    expect([...index.keys()]).toEqual(["A-Regular"]);
    expect(reported).toEqual([{ id: "tenant", message: "DO unreachable" }]);
  });

  it("没配 onProviderError 时，来源出错就整体失败 —— 不静默降级", async () => {
    const registry = createFontRegistry({
      providers: [{ id: "tenant", list: async () => { throw new Error("boom"); },
        read: async () => new Uint8Array(), blobFor: () => null }],
    });
    await expect(registry.index()).rejects.toThrow("boom");
  });

  it("install 本次不提供 —— 可选成员，不是会抛的空壳", () => {
    const registry = createFontRegistry({ providers: [] });
    expect(registry.install).toBeUndefined();
  });
});
