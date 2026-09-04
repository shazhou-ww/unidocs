import { describe, expect, it } from "vitest";
import { writePsd } from "ag-psd";
import { load, textUneditable } from "../src/psd/load.js";
import { save } from "../src/psd/save.js";
import { installCanvasShim } from "../src/psd/canvas-shim.js";
import type { Layer, PsdDoc } from "../src/model/types.js";

const px = (w: number, h: number) =>
  ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200) });

/** 两段样式:第一段黑、第二段红且字距很大 —— 就是那张烘焙图的实际结构。 */
const twoRunText = (): PsdDoc => ({
  canvas: { width: 200, height: 80, depth: 8, colorMode: "RGB", resolution: 72 } as PsdDoc["canvas"],
  layers: [{
    id: "l0_Web", type: "text", name: "Web", bounds: [0, 0, 60, 200],
    opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
    pixels: px(200, 60),
    text: {
      content: "More info\nwww.yoursite.com",
      style: { font: "JosefinSans-Bold", size: 58, leading: 79, caps: "all" },
      runs: [
        { length: 10, style: { color: { r: 20, g: 20, b: 20 } } },
        { length: 16, style: { color: { r: 200, g: 30, b: 50 }, tracking: 200 } },
      ],
      paragraphStyle: { justification: "center" },
      paragraphRuns: [{ length: 26, style: { justification: "center" } }],
      shapeType: "point",
      transform: [1, 0, 0, 1, 12, 40],
    },
  } as Layer],
});

const findText = (doc: PsdDoc) => doc.layers.find(l => l.type === "text")!.text!;

describe("文字层导入：分段样式与段落属性", () => {
  it("往返不丢逐段样式 —— 只写顶层 style 会把「第二行是红的」抹掉", async () => {
    const back = findText(await load(await save(twoRunText())));
    expect(back.content).toBe("More info\nwww.yoursite.com");
    expect(back.runs).toHaveLength(2);
    expect(back.runs![0].style.color).toEqual({ r: 20, g: 20, b: 20 });
    expect(back.runs![1].style.color).toEqual({ r: 200, g: 30, b: 50 });
    expect(back.runs![1].style.tracking).toBe(200);
    // length 是字符数,顺次覆盖 content;两段加起来要盖满。
    expect(back.runs!.reduce((n, r) => n + r.length, 0)).toBe("More info\nwww.yoursite.com".length);
  });

  // 用 center 而不是 left:left 是 PSD 的默认值,写出去和"根本没写"在文件里
  // 无法区分,拿它做断言测不出通路是否接通。
  it("往返不丢对齐方式 —— 没有它就不知道文字改短之后往哪边收", async () => {
    const back = findText(await load(await save(twoRunText())));
    expect(back.paragraphStyle?.justification).toBe("center");
  });

  it("往返不丢 caps —— content 是小写而烘焙图全大写,差别就在这里", async () => {
    const back = findText(await load(await save(twoRunText())));
    expect(back.style?.caps).toBe("all");
  });

  it("结构上可重排的文字层标成 editable", async () => {
    const back = findText(await load(await save(twoRunText())));
    expect(back.uneditable).toBeUndefined();
  });
});

describe("文字层导入：识别我们复刻不了的排版特性", () => {
  /** 直接用 ag-psd 写,因为 warp / textPath 这些字段我们的 save 不写。 */
  const psdWith = async (text: Record<string, unknown>): Promise<PsdDoc> => {
    installCanvasShim();
    const bytes = writePsd({
      width: 200, height: 80,
      children: [{
        name: "T", top: 0, left: 0, bottom: 60, right: 200,
        imageData: { width: 200, height: 60, data: new Uint8ClampedArray(200 * 60 * 4).fill(200) } as never,
        text: { text: "hi", ...text } as never,
      }],
    } as never);
    return load(new Uint8Array(bytes));
  };

  it("文字变形（warp）→ 不可重排", async () => {
    expect(findText(await psdWith({ warp: { style: "arc", value: 30 } })).uneditable).toContain("warp");
  });

  it("warp.style 为 none 不算变形 —— 每个文字层都带这个字段", async () => {
    expect(findText(await psdWith({ warp: { style: "none" } })).uneditable).toBeUndefined();
  });

  // 用 gridding 而不是 gridInfo:ag-psd 把 gridInfo 写进 EngineData 却从不
  // 解回来(见 load.ts 里 textUneditable 的注释),所以那个状态在测试里根本
  // 造不出来。两个字段我们都认,能测的只有这一个。
  it("CJK 排版网格 → 不可重排", async () => {
    expect(findText(await psdWith({ gridding: "round" })).uneditable).toContain("grid");
  });

  // 下面两条直接打 `textUneditable`,不走 load:ag-psd 的 writer 不写
  // TextFrameSet,回读也就没有 `textPath`,合成 PSD 造不出这个状态。正是这个
  // 盲区让 `if (t.textPath)` 一路过了测试,而真实 Photoshop 文件里每个文字层
  // 都带这条空帧描述,于是整个 setText 在真实文件上全线失效。
  it("点文字的空帧描述不算路径文字 —— Photoshop 给每个文字层都写一条", () => {
    // 逐字段抄自真实文件(landing-page 的 Web 层):只有 data,没有 bezierCurve,
    // type 缺省。
    const pointFrame = { data: { textRange: [-1, -1], pathData: { spacing: -1 } } };
    expect(textUneditable({ text: "hi", textPath: pointFrame } as never)).toEqual([]);
  });

  it("框文字的帧矩形不算路径文字 —— 那条曲线就是文本框自己", () => {
    // 抄自真实文件(fashion-banner 的 Website 层):控制点是矩形四角,type=1。
    const boxFrame = {
      bezierCurve: { controlPoints: [0, 0, 0, 0, 815, 0, 815, 0, 815, 90, 815, 90, 0, 90, 0, 90] },
      data: { type: 1, textRange: [-2, -2], pathData: { spacing: -1 } },
    };
    expect(textUneditable({ text: "hi", textPath: boxFrame } as never)).toEqual([]);
  });

  it("帧类型不是点/框的才是路径文字 → 不可重排", () => {
    const onPath = {
      bezierCurve: { controlPoints: [0, 0, 10, 0, 20, 10, 30, 10] },
      data: { type: 2, textRange: [0, 5], pathData: { spacing: 0 } },
    };
    expect(textUneditable({ text: "hi", textPath: onPath } as never)).toContain("text-path");
  });

  it("不可重排时 degraded 说明原因,而不是笼统一句「已栅格化」", async () => {
    const doc = await psdWith({ warp: { style: "arc", value: 30 } });
    const d = doc.layers.find(l => l.type === "text")!.degraded!;
    expect(d[0].detail).toContain("不可重排");
    expect(d[0].detail).toContain("warp");
  });
});
