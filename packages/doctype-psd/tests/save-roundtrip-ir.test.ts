import { describe, it, expect } from "vitest";
import type { PsdDoc } from "../src/model/types.js";
import { save } from "../src/psd/save.js";
import { load } from "../src/psd/load.js";

const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const base = {
  opacity: 1, blendMode: "normal" as const,
  visible: true, locked: false, clipping: false,
};

const doc = (): PsdDoc => ({
  canvas: { width: 256, height: 256, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [
    {
      id: "t", type: "text", name: "headline", bounds: [20, 20, 60, 220], ...base,
      pixels: px(200, 40),
      text: {
        content: "Midsummer Sale",
        style: { font: "Barlow-Bold", size: 32, color: { r: 28, g: 29, b: 26 } },
        transform: [1, 0, 0, 1, 20, 52],
        shapeType: "point",
      },
      degraded: [{ reason: "文字层已栅格化" }],
    },
  ],
});

describe("save → load 往返保留 IR 元数据", () => {
  it("文字层的内容与样式往返后不丢", async () => {
    const bytes = await save(doc());
    const back = await load(bytes);
    const headline = back.layers.find((l) => l.name === "headline")!;
    expect(headline.type).toBe("text");
    expect(headline.text?.content).toBe("Midsummer Sale");
    expect(headline.text?.style?.size).toBe(32);
    expect(headline.text?.style?.font).toBe("Barlow-Bold");
  });

  it("degraded 是导入期诊断，不写回 PSD，但重新导入会重新产生", async () => {
    const bytes = await save(doc());
    const back = await load(bytes);
    const headline = back.layers.find((l) => l.name === "headline")!;
    // 不是从上一份 doc 搬过来的那条，而是 load 重新判定出来的
    expect(headline.degraded).toEqual([
      { reason: "文字层已栅格化", detail: "渲染与导出使用 PSD 烘焙像素；本期不支持编辑文字内容与排版" },
    ]);
  });
});
