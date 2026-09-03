# PSD 文档类型的 PNG 进出口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 psd 文档类型能直接打开 `.png`，并且导出时可以选 PSD 或 PNG。

**Architecture:** PNG 是 psd doctype 的一种**入口格式**，不是新的 doctype——打开之后文档仍然是 psd，图层工具照常可用。三步：先给 `doctype-psd` 注册 `formats.png`（Cloudflare 那条运行时的格式分发已经通了，注册完立刻生效）；再把 `selectFormat` 从 `cloudflare-sdk` 搬进 `doctype-server-common` 两边共用，并给 Azure 那条接上导入导出的格式入口；最后前端放开 `accept` 并把导出按钮改成菜单。

**Tech Stack:** TypeScript / vitest / `fast-png@8`（已是 `doctype-psd` 依赖）/ React 19（web-psd）。

## Global Constraints

以下逐条抄自 spec `docs/superpowers/specs/2026-08-31-psd-image-formats-design.md`，每个任务的要求都隐含包含本节：

- **`defaultFormat` 保持 `"psd"`**，顶层 `DocumentType.contentType` 不变，文档目录里的 `docType` 不变。
- **打开 PNG 之后文档仍然是 psd doctype**。PNG 是入口格式，不是另一种文档类型。
- **PNG 导出是展平**，图层结构会丢。这不记为 `Degradation`——`Degradation` 描述的是导入时丢失的保真度，不是导出时的格式限制。
- **JPEG 本期不做。** 不要引入任何新依赖。
- **不做「把图片作为新图层置入当前文档」。** 本期只有「当成新文档打开」。
- **`selectFormat` 的语义原封不动照抄 `cloudflare-sdk/src/editor-do-svalue.ts:954-975` 今天的行为**，不得自行改判定规则。七条规则见 Task 3 的表。
- **不改 `packages/protocol`**（`DocumentFormat` / `formats` / `defaultFormat` 已经够用，`src/types.ts:158-162`）。
- **不改 `packages/gateway-common`**（`?format=` 随 `originalUrl.search` 原样转发，`gateway-handler.ts:335`）。
- **任务顺序是硬约束**：Task 6（前端放开 `accept`）必须排在 Task 5（Azure 接上机制）之后。生产的 psd 服务跑在 Azure，先放开会让用户选到服务端还打不开的文件。
- 提交信息用中文，与仓库现有风格一致；每个提交结尾加 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`。
- 全程**一个分支 `feat/psd-image-formats`**，不拆子分支。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `packages/doctype-psd/src/psd/png.ts` | 新增。PNG 字节 ↔ `PsdDoc` 的纯转换：`toRgba8`（归一化解码结果）、`pngToDoc`（造单图层文档）、`docToPng`（展平编码） | 1, 2 |
| `packages/doctype-psd/tests/png.test.ts` | 新增。`toRgba8` 的通道/位深归一化 | 1 |
| `packages/doctype-psd/tests/png-format.test.ts` | 新增。`formats.png` 的 load/save/往返/与 PSD 合成图一致 | 2 |
| `packages/doctype-psd/src/doctype.ts` | 修改。`formats` 里加 `png` 一项 | 2 |
| `packages/doctype-server-common/src/format-select.ts` | 新增。从 `editor-do-svalue.ts:954-975` 搬来的 `selectFormat` | 3 |
| `packages/doctype-server-common/src/index.ts` | 修改。barrel 加一行导出 | 3 |
| `packages/doctype-server-common/tests/format-select.test.ts` | 新增。七条规则的行为规格 | 3 |
| `packages/cloudflare-sdk/src/editor-do-svalue.ts` | 修改。删掉私有 `selectFormat`，改用共用的那份 | 4 |
| `packages/doctype-server-common/src/session.ts` | 修改。`create` 收 `format`，`exportBytes` 收 `formatName` | 5 |
| `packages/doctype-server-common/src/session-handler.ts` | 修改。`/create` 喂文件名与 MIME；`/export` 读 `?format=`；`Content-Disposition` 带扩展名 | 5 |
| `packages/web-psd/src/ui/controller.ts` | 修改。`exportDoc(format)`、`exportFileName(docName, format)`、启动文案 | 6 |
| `packages/web-psd/src/ui/panels/top-bar.tsx` | 修改。`accept`；导出按钮改菜单 | 6 |
| `packages/web-psd/src/ui/styles.css` | 修改。导出菜单样式 | 6 |

**为什么 `png.ts` 一个文件装三个函数**：三者是同一件事的两个方向（解码归一化 → 造文档 / 展平 → 编码），一起改、一起读。拆成三个文件只会让 import 变多。

**Task 1 与 Task 2 为什么分开**：`toRgba8` 是纯像素归一化，六种通道/位深组合各有独立的判定；`pngToDoc`/`docToPng` 是文档构造与合成，依赖前者。reviewer 可以在批准归一化的同时否掉文档构造，反之亦然。

---

### Task 1: `toRgba8` —— PNG 解码结果归一化成 RGBA8

**Files:**
- Create: `packages/doctype-psd/src/psd/png.ts`
- Test: `packages/doctype-psd/tests/png.test.ts`

**Interfaces:**
- Consumes: `Pixels`（`packages/doctype-psd/src/model/types.ts:14`）= `{ width: number; height: number; data: Uint8ClampedArray }`；`fast-png` 的 `DecodedPng` = `{ width, height, data: Uint8Array|Uint8ClampedArray|Uint16Array, depth: 1|2|4|8|16, channels: number, palette?: number[][], transparency?: Uint16Array, ... }`
- Produces: `export function toRgba8(decoded: DecodedPng): Pixels`

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-psd/tests/png.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { encode, decode } from "fast-png";
import { toRgba8 } from "../src/psd/png.js";

/** 一张 2x1 的图，用给定通道数和位深编码后再解回来——走真正的 PNG 往返，
 *  而不是手搓一个 DecodedPng 结构，这样断言的是 fast-png 实际吐出来的形状。 */
function roundTrip(
  data: Uint8Array | Uint16Array,
  channels: number,
  depth: 8 | 16,
) {
  return decode(encode({ width: 2, height: 1, data, channels, depth }));
}

describe("toRgba8", () => {
  it("RGBA8 原样通过", () => {
    const px = toRgba8(roundTrip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 4, 8));
    expect(px.width).toBe(2);
    expect(px.height).toBe(1);
    expect(Array.from(px.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("RGB 补上不透明的 alpha", () => {
    const px = toRgba8(roundTrip(new Uint8Array([10, 20, 30, 40, 50, 60]), 3, 8));
    expect(Array.from(px.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it("灰度铺到 R/G/B", () => {
    const px = toRgba8(roundTrip(new Uint8Array([90, 200]), 1, 8));
    expect(Array.from(px.data)).toEqual([90, 90, 90, 255, 200, 200, 200, 255]);
  });

  it("灰度+alpha:第二个分量是 alpha,不是颜色", () => {
    const px = toRgba8(roundTrip(new Uint8Array([90, 128, 200, 0]), 2, 8));
    expect(Array.from(px.data)).toEqual([90, 90, 90, 128, 200, 200, 200, 0]);
  });

  // 16 位每分量右移 8 位。0xFFFF -> 255,0x0100 -> 1,0x00FF -> 0。
  // 最后一条是关键:低位被丢弃是有损的,但这是 RGBA8 模型的固有限制,
  // 不是 bug——写成断言免得将来有人"修"成四舍五入。
  it("16 位缩到 8 位:取高字节", () => {
    const px = toRgba8(roundTrip(new Uint16Array([0xffff, 0x0100, 0x00ff, 0x8000]), 4, 16));
    expect(Array.from(px.data)).toEqual([255, 1, 0, 128]);
  });

  it("调色板图查表得到 RGB", () => {
    // 手构 DecodedPng:fast-png 的 encode 不支持写 indexed PNG,
    // 所以这一条只能直接喂解码结果的形状。
    const px = toRgba8({
      width: 2, height: 1,
      data: new Uint8Array([0, 1]),
      depth: 8, channels: 1,
      palette: [[255, 0, 0], [0, 0, 255]],
      text: {},
    });
    expect(Array.from(px.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it("零尺寸的图直接抛错,不产出一个 0 宽高的 Pixels", () => {
    expect(() => toRgba8({
      width: 0, height: 4, data: new Uint8Array(0), depth: 8, channels: 4, text: {},
    })).toThrow(/zero/i);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/png.test.ts`
Expected: FAIL，`Failed to resolve import "../src/psd/png.js"`

- [ ] **Step 3: 写实现**

新建 `packages/doctype-psd/src/psd/png.ts`：

```ts
import { convertIndexedToRgb, type DecodedPng } from "fast-png";
import type { Pixels } from "../model/types.js";

/**
 * 把 `fast-png` 的解码结果归一化成本模型唯一认的像素形状:RGBA、每分量 8 位。
 *
 * PNG 的通道数(1/2/3/4)、位深(1/2/4/8/16)、调色板是正交的几个维度,组合起来
 * 有十几种;`Pixels` 只有一种。归一化必须在**进入模型之前**做完,否则每个读
 * `pixels.data` 的地方都要重新判断一遍通道语义。
 *
 * 位深 1/2/4 不用单独处理:`fast-png` 在 `decode` 里已经展开成每分量一字节
 * (调色板图除外,那条走 `convertIndexedToRgb`)。
 */
export function toRgba8(decoded: DecodedPng): Pixels {
  const { width, height } = decoded;
  // 0 宽或 0 高的 PNG 是合法字节但不是能编辑的文档。在这里拦住,而不是让它
  // 一路走到 `save()` 里被 ag-psd 以 `Invalid document size` 拒绝——那时错误
  // 已经离现场很远了。
  if (width === 0 || height === 0) {
    throw new Error(`PNG has zero extent (${width}x${height})`);
  }

  const out = new Uint8ClampedArray(width * height * 4);

  // 调色板图:下标 -> 调色板项。`convertIndexedToRgb` 负责按位深拆下标,
  // 返回每像素 palette[0].length 个分量(通常 3)。
  if (decoded.palette) {
    const rgb = convertIndexedToRgb(decoded);
    const stride = decoded.palette[0]?.length ?? 3;
    for (let i = 0, o = 0; o < out.length; i += stride, o += 4) {
      out[o] = rgb[i]!;
      out[o + 1] = rgb[i + 1]!;
      out[o + 2] = rgb[i + 2]!;
      // tRNS(透明调色板)本期不处理,alpha 一律不透明——见 spec 的非目标。
      out[o + 3] = stride >= 4 ? rgb[i + 3]! : 255;
    }
    return { width, height, data: out };
  }

  const { data, channels } = decoded;
  // 16 位右移 8 位取高字节。这是有损的,但 `Pixels` 就是 8 位模型;
  // 四舍五入并不会更"对",只会让往返测试更难写。
  const shift = decoded.depth === 16 ? 8 : 0;
  const at = (i: number): number => (data[i]! as number) >> shift;

  for (let p = 0, o = 0; o < out.length; p += channels, o += 4) {
    switch (channels) {
      case 1: // 灰度
        out[o] = out[o + 1] = out[o + 2] = at(p);
        out[o + 3] = 255;
        break;
      case 2: // 灰度 + alpha
        out[o] = out[o + 1] = out[o + 2] = at(p);
        out[o + 3] = at(p + 1);
        break;
      case 3: // RGB
        out[o] = at(p); out[o + 1] = at(p + 1); out[o + 2] = at(p + 2);
        out[o + 3] = 255;
        break;
      case 4: // RGBA
        out[o] = at(p); out[o + 1] = at(p + 1);
        out[o + 2] = at(p + 2); out[o + 3] = at(p + 3);
        break;
      default:
        throw new Error(`unsupported PNG channel count: ${channels}`);
    }
  }
  return { width, height, data: out };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/png.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @unidocs/doctype-psd typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add packages/doctype-psd/src/psd/png.ts packages/doctype-psd/tests/png.test.ts
git commit -m "$(cat <<'EOF'
feat(psd): toRgba8 —— 把 PNG 的各种通道/位深归一化成 RGBA8

PNG 的通道数(1/2/3/4)、位深(1/2/4/8/16)、调色板是正交的几个维度,组合起来
十几种;Pixels 只有一种。归一化放在进模型之前做完,否则每个读 pixels.data 的
地方都要重新判断一遍通道语义。

位深 1/2/4 不用单独处理——fast-png 在 decode 里已经展开成每分量一字节。
16 位取高字节,有损但那是 8 位模型的固有限制;测试把它写成断言,免得将来被
"修"成四舍五入。零尺寸的图当场抛错,而不是让它一路走到 save() 里被 ag-psd
以 Invalid document size 拒绝——那时错误已经离现场很远了。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `formats.png` —— 打开 PNG、导出 PNG

**Files:**
- Modify: `packages/doctype-psd/src/psd/png.ts`（追加 `pngToDoc` / `docToPng`）
- Modify: `packages/doctype-psd/src/doctype.ts:80-89`（`formats` 块）
- Test: `packages/doctype-psd/tests/png-format.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `toRgba8(decoded: DecodedPng): Pixels`；`PsdDoc`（`model/types.ts:117`）= `{ canvas: Canvas; layers: Layer[] }`；`render(doc: PsdDoc, ctx?): Promise<Pixels>`（`render/composite.ts:83`）；`resolveDoc(doc: PsdDoc, store: BlobStore): Promise<PsdDoc>`（`resolve.ts:103`）；`casBlobStore(ctx)`（`psd/cas-blobstore.ts`）
- Produces: `export function pngToDoc(bytes: Uint8Array): PsdDoc`；`export async function docToPng(doc: PsdDoc): Promise<Uint8Array>`；`createPsdDocumentType(ctx).formats.png`

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-psd/tests/png-format.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { decode, encode } from "fast-png";
import { createPsdDocumentType } from "../src/doctype.js";
import { pngToDoc, docToPng } from "../src/psd/png.js";
import type { PsdDoc } from "../src/model/types.js";
import { makeSBlobTestContext } from "./sblob-test-context.js";

/** 一张 3x2 的纯色 RGBA PNG。 */
function solidPng(r: number, g: number, b: number, a = 255): Uint8Array {
  const data = new Uint8Array(3 * 2 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return encode({ width: 3, height: 2, data, channels: 4, depth: 8 });
}

describe("pngToDoc", () => {
  it("画布等于图片尺寸,恰好一个铺满画布的图层", () => {
    const doc = pngToDoc(solidPng(200, 100, 50));

    expect(doc.canvas.width).toBe(3);
    expect(doc.canvas.height).toBe(2);
    expect(doc.canvas.colorMode).toBe("RGB");
    expect(doc.layers).toHaveLength(1);
    // bounds 是 [top, left, bottom, right]
    expect(doc.layers[0]!.bounds).toEqual([0, 0, 2, 3]);
    expect(doc.layers[0]!.type).toBe("raster");
    expect(doc.layers[0]!.visible).toBe(true);
    expect(doc.layers[0]!.opacity).toBe(1);
  });

  // 图层 id 沿用 psd/load.ts:298 的 `l${i}_${name}` 形式。这不是美观问题:
  // 前端的选中、ops 的 layerId 都按这个约定走。
  it("图层 id 与 PSD 载入路径同一套命名", () => {
    expect(pngToDoc(solidPng(1, 2, 3)).layers[0]!.id).toBe("l0_背景");
  });

  it("零尺寸的 PNG 抛错", () => {
    const empty = encode({ width: 0, height: 0, data: new Uint8Array(0), channels: 4, depth: 8 });
    expect(() => pngToDoc(empty)).toThrow(/zero/i);
  });
});

describe("docToPng", () => {
  it("PNG -> 文档 -> PNG 往返:像素不变", async () => {
    const original = solidPng(11, 22, 33, 44);
    const back = decode(await docToPng(pngToDoc(original)));

    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect(Array.from(back.data).slice(0, 4)).toEqual([11, 22, 33, 44]);
  });

  it("多图层被展平成一张合成图", async () => {
    // 下层不透明红,上层不透明蓝盖住左上角一格 -> 该格是蓝的,其余是红的。
    const doc: PsdDoc = {
      canvas: { width: 2, height: 1, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
      layers: [
        {
          id: "l0_bg", type: "raster", name: "bg", bounds: [0, 0, 1, 2],
          opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
          pixels: { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]) },
        },
        {
          id: "l1_dot", type: "raster", name: "dot", bounds: [0, 0, 1, 1],
          opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
          pixels: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]) },
        },
      ],
    };

    const back = decode(await docToPng(doc));
    expect(Array.from(back.data)).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });
});

describe("formats.png", () => {
  it("load 一张 PNG 得到可用文档,save 回来仍是 PNG", async () => {
    const ctx = makeSBlobTestContext();
    const dt = createPsdDocumentType(ctx);

    const state = await dt.formats.png!.load(solidPng(7, 8, 9));
    const bytes = await dt.formats.png!.save(state);
    const back = decode(bytes);

    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect(Array.from(back.data).slice(0, 4)).toEqual([7, 8, 9, 255]);
  });

  it("注册的 mediaType 与扩展名正是选格式要匹配的那两个", () => {
    const dt = createPsdDocumentType(makeSBlobTestContext());
    expect(dt.formats.png!.mediaTypes).toEqual(["image/png"]);
    expect(dt.formats.png!.extensions).toEqual([".png"]);
    // defaultFormat 不动:打开 PNG 之后文档仍然是 psd,默认导出仍是 PSD。
    expect(dt.defaultFormat).toBe("psd");
  });

  // 两条导出路径同源已经是既成事实:psd/save.ts:108 就是用同一个 render()
  // 生成 PSD 内嵌的展平合成图的。这条锁住它——将来谁改了其中一条会立刻红。
  it("PNG 导出与 PSD 内嵌的合成图逐像素一致", async () => {
    const ctx = makeSBlobTestContext();
    const dt = createPsdDocumentType(ctx);
    const state = await dt.formats.png!.load(solidPng(60, 120, 180));

    const asPng = decode(await dt.formats.png!.save(state));
    const asPsd = await dt.formats.psd!.save(state);

    // ag-psd 写出的 PSD 里,合成图在 image data section;这里用本仓库既有的
    // 载入路径读回来再合成,等价于比对同一个 render() 的两次输出。
    const reloaded = await dt.formats.psd!.load(asPsd);
    const psdComposite = decode(await dt.formats.png!.save(reloaded));

    expect(Array.from(asPng.data)).toEqual(Array.from(psdComposite.data));
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/png-format.test.ts`
Expected: FAIL，`pngToDoc is not a function` / `dt.formats.png is undefined`

- [ ] **Step 3: 给 `png.ts` 追加两个函数**

在 `packages/doctype-psd/src/psd/png.ts` 顶部把 import 改成：

```ts
import { convertIndexedToRgb, decode, encode, type DecodedPng } from "fast-png";
import type { Pixels, PsdDoc } from "../model/types.js";
import { render } from "../render/composite.js";
```

在文件末尾追加：

```ts
/**
 * 一张 PNG 变成一个单图层文档。
 *
 * 画布取图片尺寸,唯一那个图层铺满画布。图层 id 沿用 `psd/load.ts:298` 的
 * `l${i}_${name}` 形式——前端的选中和 ops 的 layerId 都按这个约定走,这里
 * 另起一套会让 PNG 打开的文档在图层操作上表现得跟 PSD 打开的不一样。
 */
export function pngToDoc(bytes: Uint8Array): PsdDoc {
  const pixels = toRgba8(decode(bytes));
  return {
    canvas: {
      width: pixels.width,
      height: pixels.height,
      colorMode: "RGB",
      depth: 8,
      // PNG 的 pHYs 是"每单位像素数",PSD 要的是 DPI,两者换算还要看单位
      // 是不是米。绝大多数 PNG 根本没有 pHYs,为一个基本读不到的值引入
      // 一套换算不值当——统一用 PSD 载入路径的同一个默认值(load.ts:340)。
      resolution: 72,
      profile: "sRGB",
    },
    layers: [{
      id: "l0_背景",
      type: "raster",
      name: "背景",
      bounds: [0, 0, pixels.height, pixels.width],
      opacity: 1,
      blendMode: "normal",
      visible: true,
      locked: false,
      clipping: false,
      pixels,
    }],
  };
}

/**
 * 文档展平成一张 PNG。
 *
 * 走的是 `render()` —— 和 PSD 导出内嵌的那张合成图**同一个函数**
 * (`psd/save.ts:108`)。这不是本期新建的约定,是既成事实;测试里有一条逐像素
 * 断言钉着它。
 *
 * 传进来的 doc 必须已经 `resolveDoc` 过(懒加载的 CAS 像素拉实),否则
 * `render` 读到的是 PixelRef 而不是字节。调用方负责——`doctype.ts` 里那行
 * 与 psd 的 save 完全对称。
 */
export async function docToPng(doc: PsdDoc): Promise<Uint8Array> {
  const composite = await render(doc);
  return encode({
    width: composite.width,
    height: composite.height,
    data: composite.data,
    channels: 4,
    depth: 8,
  });
}
```

- [ ] **Step 4: 注册 `formats.png`**

`packages/doctype-psd/src/doctype.ts`：import 那一段加上

```ts
import { docToPng, pngToDoc } from "./psd/png.js";
```

`formats` 块（当前 `:80-89`）改成：

```ts
    formats: {
      psd: {
        mediaTypes: ["image/vnd.adobe.photoshop"],
        extensions: [".psd"],
        load: async (data: Uint8Array): Promise<PsdStoredDoc> => store(await load(data)),
        save: async (state: PsdStoredDoc): Promise<Uint8Array> =>
          save(await resolveDoc(await materialize(state), casBlobStore(ctx))),
      },
      // PNG 是**入口格式**,不是另一种文档类型:load 进来之后文档仍然是 psd,
      // defaultFormat 也仍然是 psd,所以默认导出、目录里的 docType 都不变。
      png: {
        mediaTypes: ["image/png"],
        extensions: [".png"],
        load: async (data: Uint8Array): Promise<PsdStoredDoc> => store(pngToDoc(data)),
        // 与上面 psd 的 save 结构完全对称:先 materialize 再 resolveDoc 把
        // 懒加载的 CAS 像素拉实,然后才展平。少了 resolveDoc 就会渲染到
        // PixelRef 上。
        save: async (state: PsdStoredDoc): Promise<Uint8Array> =>
          docToPng(await resolveDoc(await materialize(state), casBlobStore(ctx))),
      },
    },
    defaultFormat: "psd",
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-psd exec vitest run tests/png-format.test.ts tests/png.test.ts`
Expected: PASS

- [ ] **Step 6: 跑整包回归**

Run: `pnpm --filter @unidocs/doctype-psd test`
Expected: 全绿。`doctype.test.ts` 若断言了 `formats` 的键集合，按新增的 `png` 更新它。

- [ ] **Step 7: 类型检查**

Run: `pnpm --filter @unidocs/doctype-psd typecheck`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add packages/doctype-psd/src/psd/png.ts packages/doctype-psd/src/doctype.ts packages/doctype-psd/tests/png-format.test.ts
git commit -m "$(cat <<'EOF'
feat(psd): 注册 formats.png —— 能打开 PNG,也能导出 PNG

PNG 是入口格式不是新 doctype:load 进来之后文档仍然是 psd,defaultFormat 也
仍然是 psd,所以默认导出和目录里的 docType 都不变,图层/调整/蒙版工具照常
可用。

导出走 render(),和 PSD 内嵌的那张展平合成图是同一个函数(psd/save.ts:108)
——这不是本次新建的约定,是既成事实;测试里有一条逐像素断言钉着它,将来谁改
了其中一条路径会立刻红。

save 的结构与 psd 那条完全对称:materialize 之后必须 resolveDoc 把懒加载的
CAS 像素拉实,否则 render 读到的是 PixelRef 不是字节。

图层 id 沿用 psd/load.ts:298 的 `l${i}_${name}` 形式。前端的选中和 ops 的
layerId 都按这个约定走,另起一套会让 PNG 打开的文档在图层操作上表现得跟 PSD
打开的不一样。

至此 Cloudflare 那条运行时已经全通(它的格式分发本来就是好的);Azure 那条
还要等下一步。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `selectFormat` 搬进 `doctype-server-common`

**Files:**
- Create: `packages/doctype-server-common/src/format-select.ts`
- Modify: `packages/doctype-server-common/src/index.ts`
- Test: `packages/doctype-server-common/tests/format-select.test.ts`

**Interfaces:**
- Consumes: `DocumentFormat<TDoc>`（`@unidocs/protocol`）
- Produces:
  ```ts
  export interface FormatHint { name?: string; mediaType?: string; filename?: string }
  export interface SelectedFormat<TDoc> { name: string; format: DocumentFormat<TDoc> }
  export function selectFormat<TDoc>(
    config: { formats: Readonly<Record<string, DocumentFormat<TDoc>>>; defaultFormat: string },
    hint: FormatHint,
  ): SelectedFormat<TDoc>
  ```

**语义必须与 `cloudflare-sdk/src/editor-do-svalue.ts:954-975` 今天的行为逐条一致：**

| 情形 | 行为 |
|---|---|
| `hint.name` 给定且已注册 | 用它 |
| `hint.name` 给定但未注册 | 抛 `Unknown format: ${name}` |
| `hint.mediaType` **恰好命中一个**格式的 `mediaTypes` | 用它 |
| `hint.filename` 的扩展名**恰好命中一个**格式的 `extensions` | 用它 |
| mediaType 或扩展名命中**多于一个** | 抛 `Ambiguous document format` |
| 全不命中 | 回落 `defaultFormat` |
| `defaultFormat` 未注册 | 抛 `Default format ${defaultFormat} is not configured` |

- [ ] **Step 1: 写失败的测试**

新建 `packages/doctype-server-common/tests/format-select.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { DocumentFormat } from "@unidocs/protocol";
import { selectFormat } from "../src/format-select.js";

const fmt = (mediaTypes: string[], extensions: string[]): DocumentFormat<string> => ({
  mediaTypes,
  extensions,
  load: async () => "",
  save: async () => new Uint8Array(),
});

const CONFIG = {
  formats: {
    psd: fmt(["image/vnd.adobe.photoshop"], [".psd"]),
    png: fmt(["image/png"], [".png"]),
  },
  defaultFormat: "psd",
};

describe("selectFormat", () => {
  it("显式 name 命中就用它,不看 mediaType 和文件名", () => {
    // 三个提示互相矛盾:name 说 png,另外两个说 psd。name 优先。
    const chosen = selectFormat(CONFIG, {
      name: "png", mediaType: "image/vnd.adobe.photoshop", filename: "a.psd",
    });
    expect(chosen.name).toBe("png");
    expect(chosen.format).toBe(CONFIG.formats.png);
  });

  it("显式 name 没注册过就抛错,不悄悄回落", () => {
    // 回落会让"我明确要 jpeg"变成"给你一个 psd",而调用方以为成功了。
    expect(() => selectFormat(CONFIG, { name: "jpeg" })).toThrow("Unknown format: jpeg");
  });

  it("mediaType 唯一命中", () => {
    expect(selectFormat(CONFIG, { mediaType: "image/png" }).name).toBe("png");
  });

  it("扩展名唯一命中", () => {
    expect(selectFormat(CONFIG, { filename: "holiday.png" }).name).toBe("png");
  });

  it("mediaType 与扩展名的比较都不分大小写", () => {
    expect(selectFormat(CONFIG, { mediaType: "IMAGE/PNG" }).name).toBe("png");
    expect(selectFormat(CONFIG, { filename: "HOLIDAY.PNG" }).name).toBe("png");
  });

  it("命中多于一个就抛歧义,而不是取第一个", () => {
    const overlapping = {
      formats: { a: fmt(["image/png"], [".png"]), b: fmt(["image/png"], [".png"]) },
      defaultFormat: "a",
    };
    expect(() => selectFormat(overlapping, { mediaType: "image/png" }))
      .toThrow("Ambiguous document format");
    expect(() => selectFormat(overlapping, { filename: "x.png" }))
      .toThrow("Ambiguous document format");
  });

  it("全不命中就回落 defaultFormat", () => {
    // 这是**回归护栏**:不带文件名、或者带着奇怪文件名的 PSD 上传今天就是
    // 这样的,必须继续能用。真正不是 PSD 的字节会在 load() 里报错,
    // 那才是正确的报错位置。
    expect(selectFormat(CONFIG, {}).name).toBe("psd");
    expect(selectFormat(CONFIG, { mediaType: "application/octet-stream" }).name).toBe("psd");
    expect(selectFormat(CONFIG, { filename: "blob" }).name).toBe("psd");
  });

  it("defaultFormat 没注册过就抛错", () => {
    expect(() => selectFormat({ formats: {}, defaultFormat: "psd" }, {}))
      .toThrow("Default format psd is not configured");
  });
});
```


- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/format-select.test.ts`
Expected: FAIL，`Failed to resolve import "../src/format-select.js"`

- [ ] **Step 3: 写实现**

新建 `packages/doctype-server-common/src/format-select.ts`：

```ts
import type { DocumentFormat } from "@unidocs/protocol";

/** 调用方能提供的线索。三个都可选:导出路径通常只有 `name`,导入路径通常
 *  只有 `mediaType` + `filename`。 */
export interface FormatHint {
  readonly name?: string;
  readonly mediaType?: string;
  readonly filename?: string;
}

/** 选中的格式**连同它的名字**。名字是必需的:导入路径要把它传给
 *  `Session.create({ format })`,光有对象传不过去。 */
export interface SelectedFormat<TDoc> {
  readonly name: string;
  readonly format: DocumentFormat<TDoc>;
}

/**
 * 按线索挑一个导入/导出格式。
 *
 * 这份实现是从 `cloudflare-sdk/src/editor-do-svalue.ts` 搬过来的——那边跑了
 * 很久,Azure 那条却一直写死 `defaultFormat`,两条运行时对同一个上传给出不同
 * 判断。搬到这里两边共用,**语义一个字节不改**,只把入参改成 hint 对象、返回
 * 值补上格式名(两条运行时的调用点需要的东西不一样)。
 *
 * 优先级 name → mediaType → 扩展名 → `defaultFormat`。
 *
 * **命中多于一个是抛错,不是取第一个。** 那意味着注册表里有两个格式声明了
 * 重叠的 mediaTypes 或 extensions,是配置错误;悄悄挑一个只会让它更晚被发现。
 *
 * **全不命中是回落,不是抛错。** 认不出来的输入按 `defaultFormat` 处理,保持
 * 今天的行为:一个不带文件名、或者带着奇怪文件名的 PSD 上传必须继续能用。
 * 真正不是 PSD 的字节会在 `load()` 里报错,那才是正确的报错位置。
 */
export function selectFormat<TDoc>(
  config: {
    readonly formats: Readonly<Record<string, DocumentFormat<TDoc>>>;
    readonly defaultFormat: string;
  },
  hint: FormatHint,
): SelectedFormat<TDoc> {
  const entries = Object.entries(config.formats);

  if (hint.name) {
    const explicit = config.formats[hint.name];
    if (!explicit) throw new Error(`Unknown format: ${hint.name}`);
    return { name: hint.name, format: explicit };
  }

  if (hint.mediaType !== undefined) {
    const lower = hint.mediaType.toLowerCase();
    const matched = entries.filter(([, format]) =>
      format.mediaTypes.some(candidate => candidate.toLowerCase() === lower));
    if (matched.length === 1) return { name: matched[0]![0], format: matched[0]![1] };
    if (matched.length > 1) throw new Error("Ambiguous document format");
  }

  if (hint.filename !== undefined) {
    const lower = hint.filename.toLowerCase();
    const matched = entries.filter(([, format]) =>
      format.extensions.some(extension => lower.endsWith(extension.toLowerCase())));
    if (matched.length === 1) return { name: matched[0]![0], format: matched[0]![1] };
    if (matched.length > 1) throw new Error("Ambiguous document format");
  }

  const fallback = config.formats[config.defaultFormat];
  if (!fallback) throw new Error(`Default format ${config.defaultFormat} is not configured`);
  return { name: config.defaultFormat, format: fallback };
}
```

- [ ] **Step 4: barrel 导出**

`packages/doctype-server-common/src/index.ts` 追加一行（放在 `export * from "./doc-auth-config.js";` 之后，保持文件既有的顺序风格）：

```ts
export * from "./format-select.js";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/format-select.test.ts`
Expected: PASS，8 个用例全绿

- [ ] **Step 6: 类型检查**

Run: `pnpm --filter @unidocs/doctype-server-common typecheck`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/doctype-server-common/src/format-select.ts packages/doctype-server-common/src/index.ts packages/doctype-server-common/tests/format-select.test.ts
git commit -m "$(cat <<'EOF'
feat(doctype-server-common): selectFormat 提为两条运行时共用的一份

从 cloudflare-sdk/src/editor-do-svalue.ts 搬过来。那边跑了很久,Azure 那条
却一直写死 formats[defaultFormat],两条运行时对同一个上传给出不同判断——PNG
支持要补的正是这个缺口,顺手把它收敛成一份。

语义一个字节不改,只改两处不影响判定的形状:入参从四个位置参数改成 hint 对象
(导出路径只有 name,没有另外两个);返回值从 DocumentFormat 改成 {name, format}
(导入路径要把格式名传给 Session.create,光有对象传不过去)。

顺带补上七条分支的测试——搬家之前那份就有这些分支,但从来没被测过。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Cloudflare 侧改用共用的那份

**Files:**
- Modify: `packages/cloudflare-sdk/src/editor-do-svalue.ts:7-11`（import）、`:783`（调用点）、`:954-975`（删除）

**Interfaces:**
- Consumes: Task 3 的 `selectFormat(config, hint) => { name, format }`

**这一步是纯重构：行为必须一个字节不变。** 护栏是现成的两条集成测试，它们都带文件名和 MIME 走 `:783` 这条路：
- `tests/integration/cloudflare/psd-ir-e2e.test.mjs:44` —— 上传 `sample.psd`，`type: "image/vnd.adobe.photoshop"`
- `tests/integration/shared/behavior-suite.mjs:239` —— 上传 `exported.md`，`type: "text/markdown"`

- [ ] **Step 1: 先跑一遍护栏,确认改之前是绿的**

Run: `npx vitest run --fileParallelism=false tests/integration/cloudflare/psd-ir-e2e.test.mjs`
Expected: PASS。**若因端口占用失败**（`Port 87xx is already in use`），先停掉本机在跑的 `pnpm dev` 再跑；端口冲突不算通过。

- [ ] **Step 2: 改 import**

`packages/cloudflare-sdk/src/editor-do-svalue.ts` 的 `:7-11` 那段 import 加上 `selectFormat`：

```ts
import {
  DELTA_THRESHOLD,
  readableStreamFromByteStream,
  readableStreamFromSBlobSource,
  selectFormat,
} from "@unidocs/doctype-server-common";
```

`DocumentFormat` 若因下一步删函数而变成未使用的 type import，一并从 `:3` 的 type import 里去掉。

- [ ] **Step 3: 改调用点**

`:783` 附近原本是：

```ts
        const file = formData.get("file") as unknown;
        if (isUploadedFile(file)) {
          const requested = formData.get("format");
          const format = selectFormat(
            config,
            typeof requested === "string" ? requested : null,
            file.type,
            file.name,
          );
          doc = await format.load(new Uint8Array(await file.arrayBuffer()));
        } else {
```

改成：

```ts
        const file = formData.get("file") as unknown;
        if (isUploadedFile(file)) {
          const requested = formData.get("format");
          const { format } = selectFormat(config, {
            // 只有真的给了字符串才传 name。传 undefined 与传 null 在旧签名
            // 里是同一件事(都表示"没指定"),新签名靠键的存在与否区分。
            ...(typeof requested === "string" ? { name: requested } : {}),
            mediaType: file.type,
            filename: file.name,
          });
          doc = await format.load(new Uint8Array(await file.arrayBuffer()));
        } else {
```

- [ ] **Step 4: 删掉私有实现**

删除 `:954-975` 的整个 `function selectFormat<TDoc, TQuery, TOp>(...) { ... }`。**不要动 `:553` 的导出分支**——它是自己 inline 查表的（`config.formats[formatName]`），本来就不走 `selectFormat`。

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @unidocs/cloudflare-sdk typecheck`
Expected: 无错误。若报 `selectFormat` 未使用的 import 或 `DocumentFormat` 未使用，按提示清掉。

- [ ] **Step 6: 跑护栏,确认行为没变**

Run: `npx vitest run --fileParallelism=false tests/integration/cloudflare/psd-ir-e2e.test.mjs`
Expected: PASS，与 Step 1 相同

- [ ] **Step 7: 跑 cloudflare-sdk 自己的测试**

Run: `pnpm --filter @unidocs/cloudflare-sdk test`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add packages/cloudflare-sdk/src/editor-do-svalue.ts
git commit -m "$(cat <<'EOF'
refactor(cloudflare-sdk): 改用共用的 selectFormat,删掉私有那份

净删除 22 行。判定逻辑一个字节没改,只是调用点跟着新签名换了取值方式:
四个位置参数 -> hint 对象,返回值解构出 .format。旧签名里传 null 表示
"没指定 name",新签名靠键的存在与否区分,所以只有真给了字符串才传 name。

:553 的导出分支不动——它是自己 inline 查表的,本来就不走 selectFormat。

护栏用的是现成的集成测试:tests/integration/cloudflare/psd-ir-e2e.test.mjs:44
和 tests/integration/shared/behavior-suite.mjs:239 都带文件名和 MIME 走这条路。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Azure 那条接上格式入口

**Files:**
- Modify: `packages/doctype-server-common/src/session.ts:343`（`create` 签名）、`:355`（写死的 load）、`:521-526`（`exportBytes`）
- Modify: `packages/doctype-server-common/src/session-handler.ts:127-168`（`/create`）、`:194-207`（`/export`）
- Test: `packages/doctype-server-common/tests/session.test.ts`（扩充）

**Interfaces:**
- Consumes: Task 3 的 `selectFormat(config, hint) => { name, format }`
- Produces:
  ```ts
  async create(input?: { bytes?: Uint8Array; format?: string }): Promise<{ sessionId: string; version: number }>
  async exportBytes(formatName?: string): Promise<{ bytes: Uint8Array; contentType: string }>
  ```

- [ ] **Step 1: 写失败的测试**

在 `packages/doctype-server-common/tests/session.test.ts` 末尾追加。用的是这个文件既有的现场：`makeHarness(startTime?, deltaLog?, docType?)`（`:163`，返回 `{ ports, cas, deps, session }`）和 `makeTextDocType()`（`:46`，它的格式键叫 **`text`**，`defaultFormat: "text"`，`contentType: "text/plain"`）。

```ts
// --------------------------------------------------------------------------
// 格式选择:导入与导出
// --------------------------------------------------------------------------

/** 在文本 doctype 上再挂一个 "upper" 格式,用来观察到底选中了哪一个。
 *  两个格式的 mediaTypes / extensions 不重叠,所以不会触发歧义。
 *  基础那一项沿用 makeTextDocType 的 `text`,连 defaultFormat 一起不动——
 *  这几条断言要证的正是"默认路径没变"。 */
function makeTwoFormatDocType(): DocumentType<string, TextQuery, TextOp> {
  const inner = makeTextDocType();
  return {
    ...inner,
    formats: {
      ...inner.formats,
      upper: {
        mediaTypes: ["text/x-upper"],
        extensions: [".upper"],
        async load(bytes: Uint8Array) { return decoder.decode(bytes).toUpperCase(); },
        async save(doc: string) { return encoder.encode(doc.toUpperCase()); },
      },
    },
  };
}

describe("DocumentSession.create — 格式选择", () => {
  it("给了 format 就用那个格式 load", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi"), format: "upper" });
    expect(await session.query({ kind: "text" })).toMatchObject({ data: "HI" });
  });

  // 回归护栏:不传 format 必须与今天逐字节一致。这条比上面那条更重要——
  // 今天所有的上传走的都是这条路。
  it("不传 format 就用 defaultFormat,与今天一致", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });
    expect(await session.query({ kind: "text" })).toMatchObject({ data: "hi" });
  });

  it("给了没注册过的 format 就抛错", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await expect(session.create({ bytes: encoder.encode("hi"), format: "jpeg" }))
      .rejects.toThrow("Unknown format: jpeg");
  });
});

describe("DocumentSession.exportBytes — 格式选择", () => {
  it("给了格式名就用那个格式 save,contentType 取该格式的 mediaTypes[0]", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });

    const exported = await session.exportBytes("upper");
    expect(decoder.decode(exported.bytes)).toBe("HI");
    expect(exported.contentType).toBe("text/x-upper");
  });

  // 回归护栏:不带参数必须与今天完全一致——defaultFormat 的 save,
  // 加上**顶层的 config.contentType**(不是格式自己的 mediaTypes[0])。
  it("不带参数时用 defaultFormat 与顶层 contentType", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });

    const exported = await session.exportBytes();
    expect(decoder.decode(exported.bytes)).toBe("hi");
    expect(exported.contentType).toBe("text/plain");
  });

  it("给了没注册过的格式名就抛错", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });
    await expect(session.exportBytes("jpeg")).rejects.toThrow("Unknown format: jpeg");
  });
});
```

> `session.query()` 的返回形状按该文件既有用例的写法核对一遍再落笔——上面写的是 `toMatchObject({ data: … })`，若现有测试是直接比较字符串就跟着改。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/session.test.ts`
Expected: FAIL（`create` 不认 `format`、`exportBytes` 不收参数）

- [ ] **Step 3: 改 `session.ts`**

顶部 import 加上：

```ts
import { selectFormat } from "./format-select.js";
```

`:343` 的签名改成：

```ts
  async create(input?: { bytes?: Uint8Array; format?: string }): Promise<{ sessionId: string; version: number }> {
```

`:355` 那个三元里的写死项改成：

```ts
    const doc = input?.bytes
      // `format` 为空时 selectFormat 回落 defaultFormat,与改动前逐字节等价。
      ? await selectFormat(this.#config, { ...(input.format ? { name: input.format } : {}) })
          .format.load(input.bytes)
      : await this.#config.init();
```

`:521-526` 的 `exportBytes` 整个改成：

```ts
  async exportBytes(formatName?: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    await this.load();
    const doc = this.#requireDoc();
    // 不传格式名时保持**顶层** contentType,不是所选格式的 mediaTypes[0]:
    // 那是今天的行为,而顶层 contentType 与 defaultFormat 的 mediaTypes[0]
    // 未必相等(doctype 可以给同一个格式声明多个 mediaType)。只有显式指定
    // 格式时才改用格式自己的。
    if (formatName === undefined) {
      const bytes = await this.#config.formats[this.#config.defaultFormat]!.save(doc as SValueType<TDoc>);
      return { bytes, contentType: this.#config.contentType };
    }
    const { format } = selectFormat(this.#config, { name: formatName });
    const bytes = await format.save(doc as SValueType<TDoc>);
    return { bytes, contentType: format.mediaTypes[0] ?? "application/octet-stream" };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/doctype-server-common exec vitest run tests/session.test.ts`
Expected: PASS

- [ ] **Step 5: 改 `session-handler.ts` 的 `/create`**

顶部 import 加上 `selectFormat`（从 `./format-select.js`）。`:164` 那一行改成：

```ts
        // 今天这里把 file.name / file.type 直接丢掉了,于是 Azure 这条路上
        // 上传什么都按 defaultFormat 解。喂给 selectFormat,让服务端能据此
        // 认出 .png。formData 里的显式 `format` 作为覆盖(与 Cloudflare 那条
        // 的 :783 对齐;前端本期不用它)。
        let formatName: string | undefined;
        if (file) {
          const requested = formData?.get("format");
          formatName = selectFormat(config, {
            ...(typeof requested === "string" ? { name: requested } : {}),
            mediaType: file.type,
            filename: file.name,
          }).name;
        }

        const created = await session.create({ bytes, ...(formatName ? { format: formatName } : {}) });
```

这要求 `formData` 在这一行还可见——它现在声明在 `if (contentType.includes("multipart/form-data"))` 块内。把它提到块外：

```ts
        let file: File | null = null;
        let sourceId: string | null = null;
        let formData: FormData | null = null;

        if (contentType.includes("multipart/form-data")) {
          formData = await request.formData();
          file = formData.get("file") as File | null;
          sourceId = formData.get("sourceId") as string | null;
        }
```

`config` 是这个 handler 拿得到的 `DocumentType`——**按该文件里已有的取法引用它**（`session` 所用的同一个配置），不要新增参数。

- [ ] **Step 6: 改 `session-handler.ts` 的 `/export`**

`:194-207` 那一段改成：

```ts
      // GET /_internal/export — download document
      if (method === "GET" && endpoint === "/_internal/export") {
        const requested = url.searchParams.get("format");
        const exported = await session.exportBytes(requested ?? undefined);
        // 扩展名跟着所选格式走。这不是新设计,是把 Azure 补齐到 Cloudflare
        // 已有的行为(editor-do-svalue.ts:563 早就是 `document${extension}`)。
        const extension = requested
          ? selectFormat(config, { name: requested }).format.extensions[0] ?? ""
          : config.formats[config.defaultFormat]?.extensions[0] ?? "";
        return new Response(exported.bytes as BodyInit, {
          headers: {
            "Content-Type": exported.contentType,
            "Content-Disposition": `attachment; filename="document${extension}"`,
          },
        });
      }
```

- [ ] **Step 7: 跑整包测试**

Run: `pnpm --filter @unidocs/doctype-server-common test`
Expected: 全绿

- [ ] **Step 8: 类型检查 + 跨后端回归**

Run: `pnpm --filter @unidocs/doctype-server-common typecheck && npx vitest run --fileParallelism=false tests/integration/shared`
Expected: 全绿。`behavior-suite.mjs:239` 上传 `exported.md` 那条现在会真的走扩展名匹配，必须仍然选中 markdown 格式。

- [ ] **Step 9: 提交**

```bash
git add packages/doctype-server-common/src/session.ts packages/doctype-server-common/src/session-handler.ts packages/doctype-server-common/tests/session.test.ts
git commit -m "$(cat <<'EOF'
feat(doctype-server-common): 导入导出接上格式入口,Azure 那条追平 Cloudflare

session-handler 的 /create 分支今天已经拿到了 File(甚至检查了 file.size),
却把 file.name / file.type 当场丢掉,于是 Azure 这条路上传什么都按
defaultFormat 解。喂给 selectFormat 之后服务端才认得出 .png。

/export 读 ?format=,Content-Disposition 跟着所选格式带扩展名——这不是新设计,
是把 Azure 补齐到 Cloudflare 已有的行为(editor-do-svalue.ts:563 早就是
`document${extension}`)。

两条回归护栏写成了断言,它们比新功能的用例更重要:create 不传 format 时
逐字节等价于今天;exportBytes 不带参数时用 defaultFormat 加**顶层**
config.contentType,而不是所选格式的 mediaTypes[0]——顶层 contentType 与
defaultFormat 的 mediaTypes[0] 未必相等,只有显式指定格式时才改用后者。

formData 从 multipart 分支里提到块外,因为选格式要在它之后读 file.name。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 前端 —— 打开 `.png`，导出菜单

**Files:**
- Modify: `packages/web-psd/src/ui/controller.ts:194-243`（`exportFileName` / `exportDoc`）、`:88`（启动文案）
- Modify: `packages/web-psd/src/ui/panels/top-bar.tsx:64`（`accept`）、导出按钮那一段
- Modify: `packages/web-psd/src/ui/styles.css`
- Test: `packages/web-psd/tests/export.test.ts`、`packages/web-psd/tests/top-bar.test.tsx`

**Interfaces:**
- Consumes: 服务端的 `GET …/export?format=png`（Task 5）
- Produces: `export async function exportDoc(format?: "psd" | "png"): Promise<void>`；`export function exportFileName(docName: string | null, format: "psd" | "png"): string`

> **顺序约束**：本任务必须在 Task 5 之后。生产的 psd 服务跑在 Azure，Task 5 之前放开 `accept` 会让用户选到服务端还打不开的文件。

- [ ] **Step 1: 写失败的测试(controller)**

在 `packages/web-psd/tests/export.test.ts` 的 `describe("exportDoc", …)` 里追加：

```ts
  it("导出 PNG 时请求带上 format=png,文件名换成 .png", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { exportDoc } = await openedEditor();
    await exportDoc("png");

    expect(fetchMock.mock.calls[0]![0]).toBe("/tenants/u1/docs/psd/doc-a/export?format=png");
    expect(clicks[0]!.download).toBe("summer-sale.png");
  });

  // 回归护栏:不带参数、以及显式传 "psd",都必须是今天那个 URL(不带查询串)。
  it("不指定格式时的请求与今天完全一致", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { exportDoc } = await openedEditor();
    await exportDoc();

    expect(fetchMock.mock.calls[0]![0]).toBe("/tenants/u1/docs/psd/doc-a/export");
    expect(clicks[0]!.download).toBe("summer-sale.psd");
  });
```

再追加一个 `exportFileName` 的 describe：

```ts
describe("exportFileName", () => {
  it("按目标格式换扩展名", async () => {
    const { exportFileName } = await import("../src/ui/controller.js");
    expect(exportFileName("a.psd", "psd")).toBe("a.psd");
    expect(exportFileName("a.psd", "png")).toBe("a.png");
    expect(exportFileName("a.png", "psd")).toBe("a.psd");
    // 没有扩展名的名字直接追加,而不是把最后一段当扩展名切掉。
    expect(exportFileName("summer sale", "png")).toBe("summer sale.png");
  });

  it("没有文档名时回落到按格式命名", async () => {
    const { exportFileName } = await import("../src/ui/controller.js");
    expect(exportFileName(null, "psd")).toBe("export.psd");
    expect(exportFileName(null, "png")).toBe("export.png");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/export.test.ts`
Expected: FAIL（URL 不带 `?format=png`；`exportFileName` 签名不收第二个参数）

- [ ] **Step 3: 改 `controller.ts`**

`exportFileName` 整个换成：

```ts
/** The download's filename. The server sends `Content-Disposition:
 *  attachment; filename="document.psd"`, which is the same for every
 *  document — name the file after the one on screen, with the extension
 *  swapped to whatever format was actually requested. */
export function exportFileName(docName: string | null, format: "psd" | "png"): string {
  if (!docName) return `export.${format}`;
  // `\.[^.]+$` 只在**确实有**扩展名时才替换。没有点的名字直接追加,否则
  // 「summer sale」这种名字会被当成扩展名切掉一半。
  return /\.[^.]+$/.test(docName)
    ? docName.replace(/\.[^.]+$/, `.${format}`)
    : `${docName}.${format}`;
}
```

`exportDoc` 的签名与两处用到格式的地方改成：

```ts
export async function exportDoc(format: "psd" | "png" = "psd"): Promise<void> {
  const c = controller;
  const id = c?.docId;
  if (!c || !id) return;
  setState({ exporting: true });
  try {
    await c.flush();
    // psd 走**不带查询串**的老 URL,与改动前逐字节一致——服务端不传 format
    // 时回落 defaultFormat,两条路等价,但保持 URL 不变让这次改动在网络层面
    // 对既有行为零影响。
    const query = format === "psd" ? "" : `?format=${format}`;
    const res = await fetch(`${GW}/tenants/${USER}/docs/${TYPE}/${id}/export${query}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName(getState().docName, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (e) {
    reportError("导出失败", e);
  } finally {
    setState({ exporting: false });
  }
}
```

`:88` 的启动文案去掉格式名（与 `1da1da8` 对空态提示的处理一致）：

```ts
  setState({ status: "打开一个文件开始" });
```

- [ ] **Step 4: 跑 controller 测试确认通过**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/export.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败的测试(top-bar)**

`packages/web-psd/tests/top-bar.test.tsx` 追加：

```ts
describe("导出菜单", () => {
  it("放开了 .png 的选择", () => {
    const { container } = render(<TopBar />);
    const input = container.querySelector('input[type="file"]')!;
    expect(input.getAttribute("accept")).toBe(".psd,.png");
  });

  it("点导出弹出两个格式,选 PNG 时按 png 调用", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    fireEvent.click(screen.getByRole("button", { name: "导出为 PNG" }));
    expect(exportDoc).toHaveBeenCalledWith("png");
  });

  it("选 PSD 时按 psd 调用", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    fireEvent.click(screen.getByRole("button", { name: "导出为 PSD" }));
    expect(exportDoc).toHaveBeenCalledWith("psd");
  });

  it("选完就收起菜单", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.click(screen.getByRole("button", { name: "导出为 PNG" }));

    expect(screen.queryByRole("button", { name: "导出为 PNG" })).toBeNull();
  });

  // 导出进行中整个菜单不可用:重复点会打出第二个请求,而 `exporting` 只有
  // 一个,第二次的 finally 会把第一次还在跑的状态清掉。
  it("导出中时按钮禁用且菜单打不开", () => {
    act(() => { setState({ exporting: true }); });
    render(<TopBar />);

    const button = screen.getByRole("button", { name: /导出中/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole("button", { name: "导出为 PNG" })).toBeNull();
  });
});
```

- [ ] **Step 6: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/top-bar.test.tsx`
Expected: FAIL（`accept` 还是 `.psd`；找不到「导出为 PNG」）

- [ ] **Step 7: 改 `top-bar.tsx`**

`accept` 改成 `.psd,.png`：

```tsx
      <input
        ref={fileRef} type="file" accept=".psd,.png" hidden
```

导出按钮那一段整个换成（菜单开合用组件本地 state，不进全局 store —— 它是纯粹的一次性 UI 状态，`degradeOpen` 进 store 是因为别处也要能关掉它，这里没有别处）：

```tsx
      {/* A button, not a link: the export has to flush the pending-op queue
          to the server before reading the document back from it, and a plain
          <a href> navigates without running any of our code. */}
      <div className="export">
        <button
          type="button" className="btn btn-primary"
          // `opening` 期间 docId 指向的可能正是那个正在被替换掉的旧文档。
          disabled={!s.docId || s.exporting || !!s.opening}
          onClick={() => setExportOpen(!exportOpen)}
        >
          {s.exporting ? "导出中…" : "导出"}
        </button>
        {exportOpen ? (
          <div className="export-pop">
            {(["psd", "png"] as const).map((format) => (
              <button
                key={format} type="button" className="export-row"
                onClick={() => { setExportOpen(false); void exportDoc(format); }}
              >
                {`导出为 ${format.toUpperCase()}`}
              </button>
            ))}
          </div>
        ) : null}
      </div>
```

组件顶部（`const fileRef = …` 旁边）加上：

```tsx
  // 菜单开合是纯粹的一次性 UI 状态,别处没有人要关它,所以留在组件里而不是
  // 进全局 store。`degradeOpen` 进 store 是因为图层树点一下也要把它收起来。
  const [exportOpen, setExportOpen] = useState(false);
```

并把首行 import 改成 `import { useRef, useState } from "react";`。

- [ ] **Step 8: 加样式**

`packages/web-psd/src/ui/styles.css` 在 `.degrade-pop` 那一组之后追加（结构和用色都照搬它，不新造一套）：

```css
/* 导出格式菜单。定位、投影、圆角都与 .degrade-pop 同一套,只是右对齐——
   导出按钮在最右边,左对齐会让菜单溢出窗口。 */
.export { position: relative; }
.export-pop {
  position: absolute; top: 34px; right: 0; z-index: 5; min-width: 140px;
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; box-shadow: 0 4px 14px var(--shadow-pop); padding: 4px;
}
.export-row {
  padding: 7px 8px; border: 0; border-radius: 6px; background: transparent;
  font: inherit; text-align: left; cursor: pointer;
}
.export-row:hover { background: var(--surface-hover); }
```

- [ ] **Step 9: 跑 web-psd 全套**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: 全绿。

**已知的既有失败**：`canvas-stage-pan.test.tsx` 有一个与本任务无关的 `hitTest` mock 缺失问题。若它失败，记录下来但**不要顺手修**——那是独立的一处，混进本 PR 会让 reviewer 分不清哪些改动属于 PNG 支持。

- [ ] **Step 10: 类型检查**

Run: `pnpm --filter @unidocs/web-psd typecheck`
Expected: 无错误

- [ ] **Step 11: 提交**

```bash
git add packages/web-psd/src/ui/controller.ts packages/web-psd/src/ui/panels/top-bar.tsx packages/web-psd/src/ui/styles.css packages/web-psd/tests/export.test.ts packages/web-psd/tests/top-bar.test.tsx
git commit -m "$(cat <<'EOF'
feat(web-psd): 能选 PNG 打开,导出按钮改成格式菜单

accept 放开到 .psd,.png;导出从"点击即下载"改成"点击弹菜单",两项:导出为
PSD / 导出为 PNG。

psd 走**不带查询串**的老 URL,与改动前逐字节一致。服务端不传 format 时回落
defaultFormat,两条路等价,但保持 URL 不变让这次改动在网络层面对既有行为零
影响——测试里有一条断言钉着它。

exportFileName 的扩展名替换只在确实有扩展名时才做,否则「summer sale」这种
带空格没有点的名字会被当成扩展名切掉一半。

菜单开合留在组件本地 state 而不是全局 store:它是纯粹的一次性 UI 状态,别处
没有人要关它。degradeOpen 进 store 是因为图层树点一下也要把它收起来,这里没有
这个需求。

样式照搬 .degrade-pop 那一套,只改成右对齐——导出按钮在最右边,左对齐会让菜单
溢出窗口。

启动文案去掉格式名,与 1da1da8 对空态提示的处理一致。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 全量回归与文档收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-08-31-psd-image-formats-design.md`（落地状态标注）

- [ ] **Step 1: 全量类型检查**

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 2: 本地全量测试**

Run: `npx vitest run --fileParallelism=false tests/unit tests/integration/cloudflare tests/integration/shared`
Expected: 全绿。**跑之前先停掉本机在跑的 `pnpm dev`** —— 它占着 8787/8794，集成测试会以 `Port 87xx is already in use` 假失败。

- [ ] **Step 3: 各包测试**

Run: `pnpm --filter @unidocs/doctype-psd test && pnpm --filter @unidocs/doctype-server-common test && pnpm --filter @unidocs/cloudflare-sdk test && pnpm --filter @unidocs/web-psd test`
Expected: 全绿（`canvas-stage-pan.test.tsx` 的既有失败除外，见 Task 6 Step 9）

- [ ] **Step 4: 在设计稿上标注落地状态**

在 `docs/superpowers/specs/2026-08-31-psd-image-formats-design.md` 的修订说明块之后加一行：

```markdown
> **2026-09-03 已落地。** 实现见 `docs/superpowers/plans/2026-09-03-psd-image-formats.md`。
```

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/specs/2026-08-31-psd-image-formats-design.md
git commit -m "$(cat <<'EOF'
docs(psd): 标注 PNG 进出口设计已落地

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| spec 章节 | 对应任务 |
|---|---|
| 目标 1（打开 `.png`） | Task 2（`formats.png.load`）+ Task 5（Azure 认出扩展名）+ Task 6（`accept`） |
| 目标 2（导出可选 PSD/PNG） | Task 2（`formats.png.save`）+ Task 5（`?format=`）+ Task 6（菜单） |
| 非目标（JPEG / 置入图层 / 不改 defaultFormat） | Global Constraints，Task 2 Step 4 显式保留 `defaultFormat: "psd"` |
| 认下来的语义（仍是 psd doctype、PNG 导出展平不算 Degradation） | Global Constraints + Task 2 的注释与测试 |
| 一、`selectFormat` 共用一份 | Task 3（新建）+ Task 4（CF 改用）+ Task 5（Azure 接上） |
| 一、导入（`create` 收 `format`） | Task 5 Step 3 / Step 5 |
| 一、导出（`exportBytes` 收 `formatName`、Content-Disposition 带扩展名） | Task 5 Step 3 / Step 6 |
| 一、网关不用改 | Global Constraints 明列 |
| 二、`png.ts` 的 `pngToDoc` / `toRgba8` | Task 1 + Task 2 |
| 二、解码归一化的六种情形 | Task 1 的七条测试 |
| 二、产出的文档形状与图层 id | Task 2 Step 1 的前两条测试 + Step 3 |
| 二、编码走 `render()`、与 PSD 合成图同源 | Task 2 Step 1 最后一条测试 |
| 三、前端 `accept` / 启动文案 / 导出菜单 / `exportFileName` | Task 6 |
| 四、测试清单 | Task 1/2/3/5/6 各自的测试步骤 |
| 落地顺序（一个 PR 三个提交，第 3 步最后） | Global Constraints + Task 6 的顺序约束提示 |

无缺口。注：spec 说「三个提交」，本计划拆成 6 个功能提交 + 1 个文档提交——按任务边界提交更便于 review 回退，仍是一个 PR、一个分支，不违反「不拆分支」。

**2. Placeholder scan**

无 TBD / TODO / "similar to Task N"。每个代码步骤都有可直接粘贴的代码块。Task 5 Step 1 依赖 `session.test.ts` 已有的 `makeSession` 辅助——那是实现者必须先读现场的地方，已在步骤里明写。

**3. Type consistency**

- `toRgba8(decoded: DecodedPng): Pixels` —— Task 1 定义，Task 2 Step 3 使用 ✓
- `pngToDoc(bytes: Uint8Array): PsdDoc` / `docToPng(doc: PsdDoc): Promise<Uint8Array>` —— Task 2 定义并在同任务的 `doctype.ts` 使用 ✓
- `selectFormat(config, hint) => { name, format }` —— Task 3 定义；Task 4（CF）、Task 5（session / handler）都按 `{ name, format }` 解构 ✓
- `create(input?: { bytes?; format? })` / `exportBytes(formatName?)` —— Task 5 定义，Task 5 的 handler 步骤按此调用 ✓
- `exportDoc(format?: "psd" | "png")` / `exportFileName(docName, format)` —— Task 6 定义，同任务的 top-bar 与测试按此调用 ✓
- `Pixels.data` 是 `Uint8ClampedArray`；`fast-png` 的 `encode` 接受 `PngDataArray`（含 `Uint8ClampedArray`）✓
