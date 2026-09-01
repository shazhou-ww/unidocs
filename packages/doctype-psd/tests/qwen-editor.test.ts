import { describe, expect, it, vi } from "vitest";
import { encode } from "fast-png";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createQwenImageEditor } from "../src/image/qwen-editor.js";
import { runImageEditorContract } from "../src/testing/image-editor-contract.js";
import { SENTINEL } from "../src/image/guards.js";

const fixture = (name: string) => JSON.parse(
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
);

/** 模型返回的图：尺寸故意与输入不同，模拟实测的 613x457 → 1184x896。 */
function fakeEdited(width: number, height: number): Uint8Array {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // 左半边涂红（改动），右半边填哨兵色（应被判回透明）
    const x = i % width;
    data.set(x < width / 2 ? [255, 0, 0, 255] : [SENTINEL.r, SENTINEL.g, SENTINEL.b, 255], i * 4);
  }
  return encode({ width, height, data, channels: 4, depth: 8 });
}

/**
 * 和 fakeEdited 布局一样，但只编码 RGB 三通道 —— 这才是真实 provider 响应会
 * 走的分支（模型吃 RGB 吐 RGB）。之前所有 fakeEdited 用的都是 4 通道，
 * toPixels 里的三通道拓宽分支从未被真正测过。
 */
function fakeEditedRGB(width: number, height: number): Uint8Array {
  const data = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    data.set(x < width / 2 ? [255, 0, 0] : [SENTINEL.r, SENTINEL.g, SENTINEL.b], i * 3);
  }
  return encode({ width, height, data, channels: 3, depth: 8 });
}

function stubFetch(handlers: { generation: () => Response; image?: () => Response }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("multimodal-generation")) return handlers.generation();
    return (handlers.image ?? (() => new Response(fakeEdited(96, 72).buffer)))();
  }) as unknown as typeof fetch;
}

const source = {
  width: 64, height: 48,
  data: new Uint8ClampedArray(64 * 48 * 4).fill(200),
};

const editorWith = (f: typeof fetch) =>
  createQwenImageEditor({ apiKey: "test-key", fetch: f });

describe("qwen-image-edit-plus 适配器", () => {
  it("请求打在原生 AIGC 路由上，不是 OpenAI 兼容端点", async () => {
    const f = stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) });
    await editorWith(f).edit({ source, instruction: "删掉帽子" }, AbortSignal.timeout(5000));
    const url = String((f as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    expect(url).not.toContain("compatible-mode");
  });

  it("请求体带 image + text 两段 content，watermark 关掉", async () => {
    const f = stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) });
    await editorWith(f).edit({ source, instruction: "删掉帽子" }, AbortSignal.timeout(5000));
    const init = (f as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("qwen-image-edit-plus");
    expect(body.parameters.watermark).toBe(false);
    const content = body.input.messages[0].content;
    expect(content[0].image).toMatch(/^data:image\/png;base64,/);
    expect(content[1].text).toBe("删掉帽子");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("输出被缩回源尺寸 —— 坑 1，实测宽高比也不保证", async () => {
    const f = stubFetch({
      generation: () => Response.json(fixture("qwen-edit-response.json")),
      image: () => new Response(fakeEdited(137, 91).buffer),  // 与 64x48 既不同尺寸也不同比例
    });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    if (!r.ok) throw new Error(r.detail);
    expect([r.pixels.width, r.pixels.height]).toEqual([64, 48]);
  });

  it("哨兵色区域被还原成透明 —— 坑 3", async () => {
    const f = stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    if (!r.ok) throw new Error(r.detail);
    // 右半边（哨兵色）alpha 应为 0
    const right = (48 >> 1) * 64 + 60;
    expect(r.pixels.data[right * 4 + 3]).toBe(0);
  });

  it("provenance 记下真实模型名与 prompt", async () => {
    const f = stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) });
    const r = await editorWith(f).edit({ source, instruction: "删掉帽子", seed: 42 }, AbortSignal.timeout(5000));
    if (!r.ok) throw new Error(r.detail);
    expect(r.provenance).toEqual({ model: "qwen-image-edit-plus", seed: 42, prompt: "删掉帽子" });
  });

  it("内容审核拒绝 → reason refused，不抛异常", async () => {
    const f = stubFetch({
      // 这份 fixture 不是逐字捕获：信封形状 {code, message, request_id} + HTTP 400
      // 是实测的（用故意写错的 model 名换来的）；但 "DataInspectionFailed" 这个具体
      // code 值和它的 message 文案没有被真实触发过，是从文档里抄来嫁接上去的 ——
      // 没有人为了拿到这个 fixture 故意提交过违规内容。
      generation: () => Response.json(fixture("qwen-refused-response.json"), { status: 400 }),
    });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "refused" });
  });

  it("响应体在读取过程中才 abort → reason timeout，而不是被吞成 provider_error", async () => {
    // response.ok 为 true、状态码正常，但 .json() 读流时才抛 AbortError ——
    // 模拟 signal 在拿到响应头之后、读完体之前触发的场景。
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new DOMException("aborted", "AbortError")),
    })) as unknown as typeof fetch;
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("模型回 RGB 三通道 PNG（真实响应会走的分支）也能正确拓宽成 RGBA", async () => {
    const f = stubFetch({
      generation: () => Response.json(fixture("qwen-edit-response.json")),
      // 与 source 同尺寸（64x48），跳过重采样，让断言只测通道拓宽本身。
      image: () => new Response(fakeEditedRGB(64, 48).buffer),
    });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    if (!r.ok) throw new Error(r.detail);
    // 左半边（红色，非哨兵）：RGB 落在正确偏移上，alpha 默认拓宽成 255 且未被判透明。
    const left = 24 * 64 + 4;
    expect([r.pixels.data[left * 4], r.pixels.data[left * 4 + 1], r.pixels.data[left * 4 + 2]]).toEqual([255, 0, 0]);
    expect(r.pixels.data[left * 4 + 3]).toBe(255);
    // 右半边（哨兵色）：拓宽后 alpha 先是 255，recoverAlpha 再判回透明 → 0。
    const right = 24 * 64 + 60;
    expect(r.pixels.data[right * 4 + 3]).toBe(0);
  });

  it("限流 / 5xx → reason provider_error", async () => {
    const f = stubFetch({ generation: () => Response.json({ code: "Throttling" }, { status: 429 }) });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "provider_error" });
  });

  it("abort → reason timeout", async () => {
    const f = stubFetch({ generation: () => { throw new DOMException("aborted", "AbortError"); } });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("响应里没有图片 URL → provider_error，而不是崩在解构上", async () => {
    const f = stubFetch({ generation: () => Response.json({ output: { choices: [] }, request_id: "r1" }) });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "provider_error" });
  });

  it("半透明源 + 恒等编辑 ⇒ 改动比例约为 0（差异必须在同一个色彩空间里比）", async () => {
    // 这是曾经的 bug：diffMask(source, pixels) 拿调用方的 RGBA 去比
    // recoverAlpha(back)。source 的透明区 RGB 是 PSD 里的原值（通常 0,0,0），
    // 而 pixels 的透明区带着适配器自己刷上去的哨兵品红 —— diffMask 跨四个
    // 通道取最大值，于是每一个透明像素都差 255，全被判成"改过"。
    // 后果：透明比例高的抠图层，蒙版覆盖度逼近 1，超过 MAX_CHANGED_FRACTION
    // 就退化成整层无遮挡替换 —— 正是蒙版本该拦住的色偏失败。
    const width = 64, height = 48;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      // 左上 1/4 不透明，其余全透明（透明处 RGB 留 0,0,0，和真实 PSD 一样）。
      const opaque = (i % width) < width / 2 && Math.floor(i / width) < height / 2;
      data.set(opaque ? [180, 90, 40, 255] : [0, 0, 0, 0], i * 4);
    }
    const cutout = { width, height, data };

    // 恒等 provider：把请求里那张图原样还回来。模型什么都没改，
    // 所以正确的 changed 应该几乎全黑。
    const echo = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("multimodal-generation")) {
        const body = JSON.parse(String(init!.body));
        const dataUrl: string = body.input.messages[0].content[0].image;
        sentPng = Uint8Array.from(atob(dataUrl.split(",")[1]), c => c.charCodeAt(0));
        return Response.json(fixture("qwen-edit-response.json"));
      }
      return new Response(sentPng!.buffer as ArrayBuffer);
    }) as unknown as typeof fetch;
    let sentPng: Uint8Array | undefined;

    const r = await editorWith(echo).edit({ source: cutout, instruction: "保持原样" }, AbortSignal.timeout(5000));
    if (!r.ok) throw new Error(r.detail);
    if (r.changed === null) throw new Error("恒等编辑不该把蒙版判成不可信");
    let changed = 0;
    for (const v of r.changed.data) if (v > 0) changed++;
    expect(changed / (width * height)).toBeLessThan(0.01);
  });
});

// 录制回放下的契约：形状对不对，与真不真打网络无关。
runImageEditorContract(
  "qwen-image-edit-plus (recorded)",
  async () => createQwenImageEditor({
    apiKey: "test-key",
    fetch: stubFetch({ generation: () => Response.json(fixture("qwen-edit-response.json")) }),
  }),
  { live: false },
);
