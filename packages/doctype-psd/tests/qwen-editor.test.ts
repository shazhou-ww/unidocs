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
      generation: () => Response.json({ code: "DataInspectionFailed", message: "input data may contain inappropriate content" }, { status: 400 }),
    });
    const r = await editorWith(f).edit({ source, instruction: "x" }, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ ok: false, reason: "refused" });
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
