import { describe, expect, it, vi } from "vitest";
import { isSBlob } from "@unidocs/cloudflare-sdk";
import { createPsdAgent } from "@unidocs/doctype-psd";
import type { FontEntry } from "@unidocs/doctype-psd";
import { FONTS_INTERNAL_PATH, fontsObjectName } from "../src/fonts-do.js";
import { createFontIndexSource, parseFontFallbacks } from "../src/fonts-source.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const latin: FontEntry = {
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: HASH_A,
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
};
const cjk: FontEntry = {
  postScriptName: "NotoSansSC-Regular",
  family: "Noto Sans SC",
  hash: HASH_B,
  unitsPerEm: 2048,
  coverage: [[0x4e00, 0x9fff]],
};

/** 记下每次取 stub 的对象名与每次请求的 URL。 */
function fakeNamespace(respond: () => Response) {
  const names: string[] = [];
  const urls: string[] = [];
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return name;
    },
    get: () => ({
      fetch: async (input: string) => {
        urls.push(input);
        return respond();
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, names, urls };
}

const okIndex = (fonts: FontEntry[]) => (): Response => Response.json({ fonts });

describe("createFontIndexSource", () => {
  it("把 DO 的返回装成按 postScriptName 索引的 FontIndex", async () => {
    const { namespace, names, urls } = fakeNamespace(okIndex([latin, cjk]));
    const source = createFontIndexSource({
      namespace,
      stackId: "cas_1",
      tenantId: "tenant-1",
      fallbacks: [],
    });

    const index = await source.load();
    expect([...index.keys()]).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
    expect(index.get("NotoSansSC-Regular")).toEqual(cjk);
    expect(names).toEqual([fontsObjectName({ stackId: "cas_1", tenantId: "tenant-1" })]);
    expect(new URL(urls[0]).pathname).toBe(FONTS_INTERNAL_PATH);
  });

  it("blobFor 产出的 SBlob 能被 isSBlob 认出来，哈希就是索引里那个", async () => {
    const { namespace } = fakeNamespace(okIndex([latin]));
    const source = createFontIndexSource({
      namespace,
      stackId: "cas_1",
      tenantId: "tenant-1",
      fallbacks: [],
    });
    const blob = source.blobFor(latin);
    expect(isSBlob(blob)).toBe(true);
    expect(blob.hash).toBe(HASH_A);
  });

  it("fallbacks 原样透出，顺序不变", () => {
    const { namespace } = fakeNamespace(okIndex([]));
    const source = createFontIndexSource({
      namespace,
      stackId: "cas_1",
      tenantId: "tenant-1",
      fallbacks: ["NotoSans", "NotoSansSC"],
    });
    expect(source.fallbacks).toEqual(["NotoSans", "NotoSansSC"]);
  });

  it("TTL 之内第二次 load 不再打 DO", async () => {
    const respond = vi.fn(okIndex([latin]));
    const { namespace } = fakeNamespace(respond);
    let clock = 0;
    const source = createFontIndexSource({
      namespace,
      stackId: "cas_1",
      tenantId: "tenant-1",
      fallbacks: [],
      now: () => clock,
    });

    await source.load();
    clock = 59_999;
    await source.load();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("TTL 过了重新打一次 —— 新登记的字体不该等到 DO 被回收才可见", async () => {
    const respond = vi.fn(okIndex([latin]));
    const { namespace } = fakeNamespace(respond);
    let clock = 0;
    const source = createFontIndexSource({
      namespace,
      stackId: "cas_1",
      tenantId: "tenant-1",
      fallbacks: [],
      now: () => clock,
    });

    await source.load();
    clock = 60_000;
    await source.load();
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("并发的两次 load 只打一次 DO（缓存的是 Promise）", async () => {
    const respond = vi.fn(okIndex([latin]));
    const { namespace } = fakeNamespace(respond);
    const source = createFontIndexSource({
      namespace,
      stackId: "cas_1",
      tenantId: "tenant-1",
      fallbacks: [],
      now: () => 0,
    });

    await Promise.all([source.load(), source.load()]);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("失败不进缓存 —— 一次抖动不该被记住一整个 TTL", async () => {
    let failing = true;
    const respond = vi.fn((): Response => failing
      ? Response.json({ error: "boom" }, { status: 500 })
      : Response.json({ fonts: [latin] }));
    const { namespace } = fakeNamespace(respond);
    const source = createFontIndexSource({
      namespace,
      stackId: "cas_1",
      tenantId: "tenant-1",
      fallbacks: [],
      now: () => 0,
    });

    await expect(source.load()).rejects.toThrow(/500/);
    failing = false;
    await expect(source.load()).resolves.toBeInstanceOf(Map);
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("返回体没有 fonts 数组时抛错，不静默当成空索引", async () => {
    const { namespace } = fakeNamespace(() => Response.json({ ok: true }));
    const source = createFontIndexSource({
      namespace,
      stackId: "cas_1",
      tenantId: "tenant-1",
      fallbacks: [],
    });
    await expect(source.load()).rejects.toThrow(/fonts array/);
  });
});

describe("接上 agent", () => {
  // 本任务的落点：agent 的工具表里从此有 setText。`createPsdAgent` 把工具表和
  // 提示词一起条件化，所以两边一起断言 —— 只有一边出现就是幽灵工具。
  it("注入这个来源之后，setText 进工具表，说明块也跟着进提示词", () => {
    const { namespace } = fakeNamespace(okIndex([latin]));
    const agent = createPsdAgent({
      fontIndex: createFontIndexSource({
        namespace,
        stackId: "cas_1",
        tenantId: "tenant-1",
        fallbacks: [],
      }),
    });
    expect(agent.tools.map(tool => tool.name)).toContain("setText");
    expect(agent.instructions).toMatch(/setText/);
  });

  it("不注入就都没有 —— 与 PSD_FONTS 绑定缺失时的分支对应", () => {
    const agent = createPsdAgent({});
    expect(agent.tools.map(tool => tool.name)).not.toContain("setText");
    expect(agent.instructions).not.toMatch(/setText/);
  });
});

describe("parseFontFallbacks", () => {
  it("逗号分隔，去空白，顺序即优先级", () => {
    expect(parseFontFallbacks("NotoSans, NotoSansSC")).toEqual(["NotoSans", "NotoSansSC"]);
  });

  it("缺省和空串都是空链，不硬编码任何字体名", () => {
    expect(parseFontFallbacks(undefined)).toEqual([]);
    expect(parseFontFallbacks("")).toEqual([]);
    expect(parseFontFallbacks(" , ")).toEqual([]);
  });
});
