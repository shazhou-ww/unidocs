import { describe, it, expect } from "vitest";
import type { PsdDoc } from "../src/model/types.js";
import { save, mapLayer } from "../src/psd/save.js";
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
  it("文字层的内容、样式（含颜色）往返后不丢", async () => {
    const bytes = await save(doc());
    const back = await load(bytes);
    const headline = back.layers.find((l) => l.name === "headline")!;
    expect(headline.type).toBe("text");
    expect(headline.text?.content).toBe("Midsummer Sale");
    expect(headline.text?.style?.size).toBe(32);
    expect(headline.text?.style?.font).toBe("Barlow-Bold");
    // ag-psd's text-engine colour encoding drifts to float (e.g. 28 ->
    // 27.999) across a save/load round trip; load.ts rounds it back to the
    // 0..255 integers model/types.ts promises.
    expect(headline.text?.style?.color).toEqual({ r: 28, g: 29, b: 26 });
  });

  it("degraded 是导入期诊断：mapLayer 不写它，重新导入时 load 会重新产生", async () => {
    // Direct, discriminating check on mapLayer's own output. A round-trip-only
    // assertion can't tell "save() never writes degraded" apart from "save()
    // writes it, but ag-psd's writer has no schema slot for it and silently
    // drops it, and load() unconditionally recomputes it anyway" — both look
    // identical from outside a full save()/load() cycle. Confirmed as a real
    // gap: patching save.ts to add `if (l.degraded) out.degraded = l.degraded`
    // still passed a round-trip-only version of this test.
    const headlineLayer = doc().layers.find((l) => l.name === "headline")!;
    const mapped = mapLayer(headlineLayer);
    expect(mapped).not.toHaveProperty("degraded");

    // End-to-end: after a real round trip, `degraded` on the loaded layer is
    // load()'s own freshly-produced diagnostic (with `detail`), not the one
    // carried on the input doc (which had no `detail`).
    const bytes = await save(doc());
    const back = await load(bytes);
    const headline = back.layers.find((l) => l.name === "headline")!;
    expect(headline.degraded).toEqual([
      { reason: "文字层已栅格化", detail: "渲染与导出使用 PSD 烘焙像素；本期不支持编辑文字内容与排版" },
    ]);
  });
});

describe("智能对象层：save() 经真实 ag-psd 写入器往返", () => {
  it("smartObject 层可以被真正写出为 PSD 字节而不抛错，且往返后关键字段不丢", async () => {
    const smartDoc: PsdDoc = {
      canvas: { width: 256, height: 256, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
      layers: [
        {
          id: "so", type: "smartObject", name: "logo", bounds: [10, 10, 110, 110], ...base,
          pixels: px(100, 100),
          smartObject: {
            placedId: "20953ddb-9391-11ec-b4f1-c15674f50bc4",
            transform: [10, 10, 110, 10, 110, 110, 10, 110],
            sourceName: "logo.png",
          },
        },
      ],
    };
    // ag-psd's writer throws ("You must provide width and height of the
    // linked image in placedLayer") unless placedLayer carries width/height
    // (or a warp) — this must go through the real binary writer, not just
    // mapLayer, or a regression here ships undetected again.
    const bytes = await save(smartDoc);
    const back = await load(bytes);
    const logo = back.layers.find((l) => l.name === "logo")!;
    expect(logo.type).toBe("smartObject");
    expect(logo.smartObject?.placedId).toBe("20953ddb-9391-11ec-b4f1-c15674f50bc4");
    expect(logo.smartObject?.sourceName).toBe("logo.png");
  });
});
