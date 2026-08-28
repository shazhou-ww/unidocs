import { describe, it, expect } from "vitest";
import type { Layer as AgLayer } from "ag-psd";
import { mapLayer } from "../src/psd/load.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "../src/psd/load.js";

const textFixture = fileURLToPath(new URL("./fixtures/text-shape.psd", import.meta.url));

const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const box = { top: 10, left: 20, bottom: 50, right: 120 };

describe("mapLayer — IR 保真", () => {
  it("识别文字层并保留内容与样式", () => {
    const ag = {
      name: "headline", ...box, imageData: px(100, 40),
      text: {
        text: "仲夏特惠",
        transform: [1, 0, 0, 1, 20, 46],
        shapeType: "point",
        style: {
          font: { name: "Barlow-Bold" }, fontSize: 32, tracking: 20, leading: 38,
          fillColor: { r: 28, g: 29, b: 26 },
        },
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 0, 256, 256);
    expect(l.type).toBe("text");
    expect(l.text).toEqual({
      content: "仲夏特惠",
      style: { font: "Barlow-Bold", size: 32, color: { r: 28, g: 29, b: 26 }, tracking: 20, leading: 38 },
      transform: [1, 0, 0, 1, 20, 46],
      shapeType: "point",
    });
    expect(l.pixels?.width).toBe(100); // 仍以烘焙像素渲染
    expect(l.degraded?.map((d) => d.reason)).toContain("文字层已栅格化");
  });

  it("识别形状层并汇总路径", () => {
    const ag = {
      name: "badge", ...box, imageData: px(100, 40),
      vectorFill: { type: "color", color: { r: 245, g: 239, b: 227 } },
      vectorMask: {
        paths: [{
          open: false, fillRule: "even-odd",
          knots: [
            { linked: false, points: [20, 10, 20, 10, 20, 10] },
            { linked: false, points: [120, 10, 120, 10, 120, 10] },
            { linked: false, points: [120, 50, 120, 50, 120, 50] },
            { linked: false, points: [20, 50, 20, 50, 20, 50] },
          ],
        }],
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 1, 256, 256);
    expect(l.type).toBe("fill");
    expect(l.vector?.pathSummary).toEqual({ subpaths: 1, knots: 4 });
    expect(l.vector?.fill).toEqual({ type: "color", color: { r: 245, g: 239, b: 227 } });
    expect(l.degraded?.map((d) => d.reason)).toContain("矢量形状已栅格化");
  });

  it("识别智能对象并保留放置信息", () => {
    const ag = {
      name: "hero", ...box, imageData: px(100, 40),
      placedLayer: {
        id: "uuid-1", placed: "hero-01.psb", type: "raster",
        transform: [20, 10, 120, 10, 120, 50, 20, 50],
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 2, 256, 256);
    expect(l.type).toBe("smartObject");
    expect(l.smartObject).toEqual({
      placedId: "uuid-1", sourceName: "hero-01.psb",
      transform: [20, 10, 120, 10, 120, 50, 20, 50],
    });
    expect(l.degraded).toEqual([{ reason: "智能对象已展平", detail: "源：hero-01.psb" }]);
  });

  // 顺序回归：带矢量蒙版的调整图层必须仍是 adjustment，不能变成 fill。
  it("带矢量蒙版的调整图层仍判为 adjustment，但路径元数据照常记录", () => {
    const ag = {
      name: "curve", ...box,
      adjustment: { type: "brightness/contrast", brightness: 10 },
      vectorMask: {
        paths: [{ open: false, fillRule: "non-zero", knots: [{ linked: false, points: [0, 0, 0, 0, 0, 0] }] }],
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 3, 256, 256);
    expect(l.type).toBe("adjustment");
    expect(l.vector?.pathSummary).toEqual({ subpaths: 1, knots: 1 });
  });

  it("普通栅格层不变、且不产生降级项", () => {
    const ag = { name: "bg", ...box, imageData: px(100, 40) } as unknown as AgLayer;
    const l = mapLayer(ag, 4, 256, 256);
    expect(l.type).toBe("raster");
    expect(l.text).toBeUndefined();
    expect(l.vector).toBeUndefined();
    expect(l.smartObject).toBeUndefined();
    expect(l.degraded).toBeUndefined();
  });

  // 降级台账的意义在于「有损失就一定有记录」。以下两条是原先静默丢失的路径。
  it("没有 id 的置入图层：保持 raster 判定，但必须记下降级", () => {
    const ag = {
      name: "hero", ...box, imageData: px(100, 40),
      // 真实文件里出现过：placedLayer 只带变换、不带 id（源文档未内嵌）。
      placedLayer: { placed: undefined, transform: [20, 10, 120, 10, 120, 50, 20, 50] },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 0, 256, 256);
    expect(l.type).toBe("raster");
    expect(l.smartObject).toBeUndefined();
    expect(l.degraded).toEqual([{ reason: "智能对象已展平", detail: "源文档未内嵌" }]);
  });

  it("不支持的图层效果逐项入账", () => {
    const ag = {
      name: "card", ...box, imageData: px(100, 40),
      effects: {
        innerShadow: [{ enabled: true, color: { r: 0, g: 0, b: 0 } }],
        outerGlow: { enabled: true, color: { r: 255, g: 255, b: 255 } },
        bevel: { enabled: true },
        satin: { enabled: true },
        gradientOverlay: [{ enabled: true }],
        patternOverlay: { enabled: true },
        innerGlow: { enabled: true },
        // 这两个键不是效果，不能入账。
        disabled: false,
        scale: 1,
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 1, 256, 256);
    expect(l.degraded?.map((d) => d.reason)).toEqual([
      "不支持的图层效果：内阴影",
      "不支持的图层效果：外发光",
      "不支持的图层效果：斜面和浮雕",
      "不支持的图层效果：光泽",
      "不支持的图层效果：渐变叠加",
      "不支持的图层效果：图案叠加",
      "不支持的图层效果：内发光",
    ]);
    expect(l.degraded?.[0].detail).toBe("导入时未保留，渲染与导出均不包含该效果");
  });

  it("被停用的效果也入账，但措辞区分开", () => {
    const ag = {
      name: "card", ...box, imageData: px(100, 40),
      effects: { stroke: [{ enabled: false, fillType: "color", color: { r: 1, g: 2, b: 3 }, size: { value: 4 } }] },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 2, 256, 256);
    expect(l.stroke).toBeUndefined(); // 停用的描边不参与渲染
    expect(l.degraded).toEqual([
      { reason: "不支持的图层效果：描边", detail: "源文件中已停用，导入时未保留，导出后无法恢复" },
    ]);
  });

  it("渐变/图案描边落不进模型，因此入账", () => {
    const ag = {
      name: "card", ...box, imageData: px(100, 40),
      effects: { stroke: [{ enabled: true, fillType: "gradient", size: { value: 4 } }] },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 3, 256, 256);
    expect(l.stroke).toBeUndefined();
    expect(l.degraded?.map((d) => d.reason)).toEqual(["不支持的图层效果：描边"]);
  });

  it("已支持并已映射的三种效果不产生降级项", () => {
    const ag = {
      name: "card", ...box, imageData: px(100, 40),
      effects: {
        solidFill: [{ enabled: true, color: { r: 10, g: 20, b: 30 }, opacity: 1 }],
        stroke: [{ enabled: true, fillType: "color", color: { r: 1, g: 2, b: 3 }, size: { value: 4 }, position: "outside" }],
        dropShadow: [{ enabled: true, color: { r: 0, g: 0, b: 0 }, distance: { value: 3 }, size: { value: 2 } }],
      },
    } as unknown as AgLayer;
    const l = mapLayer(ag, 4, 256, 256);
    expect(l.colorOverlay).toBeDefined();
    expect(l.stroke).toBeDefined();
    expect(l.dropShadow).toBeDefined();
    expect(l.degraded).toBeUndefined();
  });

  it("分组仍是分组", () => {
    const ag = {
      name: "grp", ...box,
      children: [{ name: "child", ...box, imageData: px(4, 4) }],
    } as unknown as AgLayer;
    const l = mapLayer(ag, 5, 256, 256);
    expect(l.type).toBe("group");
    expect(l.children).toHaveLength(1);
  });
});

describe("load() — 真实 PSD 往返", () => {
  it("从真实 PSD 字节中识别出文字层", async () => {
    const doc = await load(new Uint8Array(readFileSync(textFixture)));
    const headline = doc.layers.find((l) => l.name === "headline")!;
    expect(headline.type).toBe("text");
    expect(headline.text?.content).toBe("Midsummer Sale");
    expect(headline.degraded?.map((d) => d.reason)).toContain("文字层已栅格化");
    // 普通层不受影响
    expect(doc.layers.find((l) => l.name === "bg")!.type).toBe("raster");
  });
});
