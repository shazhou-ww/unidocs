# PSD 文字编辑实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 能改 PSD 文字层的内容，并把改后的文字真正画出来。

**Architecture:** `setText` 是 `effect` 工具（取字体是 IO，而 `apply` 必须纯），它编排四段纯函数 —— run 重切分 → 排版 → 栅格化 → 产出 op。字体全部存 CAS：租户级 DO 做 `postScriptName → hash` 的索引，文档里存 `FontRef` 负责保活。排版只对接口 `FontFace` 编程，opentype.js 是它的一个实现。

**Tech Stack:** TypeScript / vitest / opentype.js@2（零依赖，ESM）/ 自写扫描线栅格化（无 WASM、无 canvas）/ Cloudflare Durable Object（sqlite）

**Spec:** `docs/superpowers/specs/2026-09-03-psd-text-edit-design.md`
（前置事实：`docs/psd-text-layers.md`）

## Global Constraints

- **`apply` 必须纯**：不生成像素、不调模型、不读时钟/网络/随机数（`packages/doctype-psd/docs/design.md:184`）。IO 只允许出现在 `effect` 工具里。
- **渲染有两边**：`psd-client/render-worker.ts`（浏览器）与服务端都从 `@unidocs/doctype-psd/engine` 引同一份代码，`getPreview` 走服务端那份 —— agent 看的是它。任何新代码必须两边都能跑：**不用 DOM、不用 canvas、不用 Node 内置模块**。
- **不引入 WASM**。栅格化自己写。
- **只重画被编辑过的图层**：没动过的文字层继续贴 Photoshop 的烘焙 `pixels`，即使字体齐。
- **拒绝 ≠ 忽略**：框文字（`boxBounds` 存在）、竖排（`orientation: "vertical"`）、`uneditable` 非空 → `setText` **失败并说明原因**；`underline` / `strikethrough` / `strokeColor` / faux bold·italic / `ligatures` → **照常渲染但在结果里列出未还原的样式**。
- **测试不许空转**：断言必须能被证伪。随机/批量测试要统计有效样本数（见 Task 1 已有的 `spliceRuns` 不变量测试）。
- 注释与提交信息用中文，说清"为什么"而不是复述代码；行内引用 `file:line`。
- 每个任务结束时 `pnpm --filter @unidocs/doctype-psd test` 与 `pnpm -r typecheck` 必须干净。

---

## Task 1: run 重切分 —— 已完成（`79dafb3`）

`src/text/runs.ts` 的 `diffRange` / `spliceRuns`，21 条测试含 1000 组随机不变量。后续任务直接用。

---

## Task 2: 字体度量接口与排版引擎

**Files:**
- Create: `packages/doctype-psd/src/text/font.ts`
- Create: `packages/doctype-psd/src/text/layout.ts`
- Test: `packages/doctype-psd/tests/text-layout.test.ts`

**Interfaces:**
- Consumes: `LayerText` / `LayerTextRun` / `LayerTextStyle`（`src/model/types.ts`）
- Produces: `FontFace`、`FaceResolver`、`layoutText()`、`PlacedGlyph`、`LayoutResult` —— Task 3 消费 `PlacedGlyph`，Task 4 实现 `FontFace`，Task 6 调用 `layoutText`

- [ ] **Step 1: 写 `font.ts` 的接口**

排版**只依赖度量**，不依赖任何字体库。这样 Task 2/3 能用假字体完整单测，opentype.js 到 Task 4 才出现。

```ts
/** 字体坐标系里的轮廓命令，y 轴向上，单位是 font units。 */
export type PathCommand =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | { type: "Q"; x1: number; y1: number; x: number; y: number }
  | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: "Z" };

export interface FontFace {
  readonly postScriptName: string;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  /** 这个码位有没有字形。逐字符回退靠它。 */
  has(codePoint: number): boolean;
  /** 步进宽度，font units。 */
  advance(codePoint: number): number;
  /** 字偶距，font units；没有就是 0。 */
  kerning(left: number, right: number): number;
  outline(codePoint: number): readonly PathCommand[];
}

/**
 * 按码位挑字体。**逐字符**，不是逐 run —— 一个 run 里完全可能中英混排，
 * 选一套覆盖不了（设计文档 §3.4）。返回 null 表示整条回退链都没有这个字。
 */
export type FaceResolver = (codePoint: number, requestedFont: string | undefined) => FontFace | null;
```

- [ ] **Step 2: 写失败的排版测试**

```ts
import { describe, expect, it } from "vitest";
import { layoutText } from "../src/text/layout.js";
import { fakeFace } from "./text-fake-face.js";

describe("layoutText", () => {
  it("逐字形累加步进宽度", () => {
    // 每个字形宽 1000 font units，em=1000 → 字号即步进
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "ab", style: { size: 10 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.x)).toEqual([0, 10]);
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/text-layout.test.ts --root packages/doctype-psd`
Expected: FAIL — `layoutText is not a function`

- [ ] **Step 4: 实现 `layoutText`**

要点，按顺序：

1. **拒绝**：`text.uneditable?.length` 非空、`boxBounds` 存在、`orientation === "vertical"` → 返回 `{ ok: false, reason }`
2. **逐字符样式**：用 `runs[]` 的 `length` 把 `content` 切成"字符 → 样式"；没有 `runs` 就整串用 `text.style`
3. **`caps`**：`all` → `toUpperCase()`；`small` → 大写并把字号乘以一个小型大写系数（`SMALL_CAPS_RATIO = 0.7`，与 ag-psd 的 `smallCapSize` 默认值一致）。**大小写变换会改变字符数**（如 `ß` → `SS`），所以变换要在切好样式之后逐字符做，样式跟着字符走
4. **分行**：按 `\n`；行高取 `leading`，缺省 `size * 1.2`
5. **逐字形**：`resolveFace(codePoint, style.font)`；拿不到就记进 `missing` 并跳过
6. **推进**：`x += advance/unitsPerEm*size*horizontalScale + tracking/1000*size`；同一套字体的相邻字形之间加 `kerning`（`autoKerning !== false` 时），**跨字体不加**
7. **对齐**：一行排完得到宽度，按 `justification` 求 x 偏移 —— `left` 为 0，`right` 为 `-width`，`center` 为 `-width/2`
8. **`baselineShift`** 加到该字形的 y 上
9. **`ignored`**：命中 `underline` / `strikethrough` / `strokeColor` / `fauxBold` / `fauxItalic` / `ligatures` 的，把名字收进 `ignored`（去重）

```ts
export interface PlacedGlyph {
  readonly codePoint: number;
  readonly face: FontFace;
  /** 基线原点，像素，相对锚点；y 轴向下（文档坐标系）。 */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly horizontalScale: number;
  readonly verticalScale: number;
  readonly color: { r: number; g: number; b: number };
}

export type LayoutResult =
  | {
      ok: true;
      glyphs: readonly PlacedGlyph[];
      /** 墨迹范围，像素，相对锚点。空文本时四个数都是 0。 */
      inkBounds: { left: number; top: number; right: number; bottom: number };
      /** 这次没有还原的样式名，报给 agent。 */
      ignored: readonly string[];
      /** 整条回退链都没有的码位。 */
      missing: readonly number[];
    }
  | { ok: false; reason: string };
```

- [ ] **Step 5: 运行，确认通过**

- [ ] **Step 6: 补齐其余测试**

每条都要能被证伪：

- 字偶距生效（假字体给一对负 kerning，断言第二个字形被拉近了确切的像素数）
- **跨字体不加字偶距**（两个字形来自不同 face 时，间距等于纯 advance）
- `tracking` 200/1000 em 在 58px 下每个字形多推 11.6px
- `caps: "all"` 把 `"ab"` 排成 `A`/`B` 两个字形
- 三种 `justification` 的 x 偏移（同一串文本，`left`/`center`/`right` 的首字形 x 分别为 `0` / `-w/2` / `-w`）
- 多行按 `leading` 递增 y；缺省 `leading` 用 `size * 1.2`
- 逐字符回退：中英混排时英文字形来自 face A、中文来自 face B
- 缺字进 `missing` 且不产生字形
- `boxBounds` 存在 → `ok: false`；`orientation: "vertical"` → `ok: false`；`uneditable` 非空 → `ok: false`
- `underline: true` → `ignored` 含 `"underline"`，但字形照常产出

- [ ] **Step 7: 提交**

```bash
git add packages/doctype-psd/src/text/font.ts packages/doctype-psd/src/text/layout.ts packages/doctype-psd/tests/
git commit -m "feat(psd): 字体度量接口与排版引擎"
```

---

## Task 3: 栅格化

**Files:**
- Create: `packages/doctype-psd/src/text/raster.ts`
- Test: `packages/doctype-psd/tests/text-raster.test.ts`

**Interfaces:**
- Consumes: `PlacedGlyph`（Task 2）
- Produces: `rasterizeGlyphs(glyphs, width, height, origin): Pixels` —— Task 6 用它产出新的图层像素

- [ ] **Step 1: 写失败的测试**

用一个只有一个矩形字形的假字体，断言覆盖率：矩形内部 alpha 为 255，外部为 0，边缘介于两者之间。

```ts
it("整像素对齐的矩形字形：内部实心、外部全透明", () => {
  const glyph = rectGlyph({ x: 2, y: 2, w: 4, h: 4 }); // 见测试辅助
  const px = rasterizeGlyphs([glyph], 8, 8, { x: 0, y: 0 });
  expect(alphaAt(px, 4, 4)).toBe(255);
  expect(alphaAt(px, 0, 0)).toBe(0);
});
```

- [ ] **Step 2: 运行，确认失败**

- [ ] **Step 3: 实现**

三段，都在这个文件里：

```ts
/** 把轮廓命令拍平成折线。曲线按固定步数细分。 */
function flatten(commands: readonly PathCommand[], steps: number): number[][][]

/**
 * 扫描线填充，非零环绕。每像素行取 SUB 条子扫描线做垂直抗锯齿，水平方向用
 * 精确的分数覆盖（span 两端各算一次部分覆盖），不做超采样。
 */
const SUB = 5;
function fillCoverage(polys: number[][][], w: number, h: number): Float32Array

/** 逐字形算覆盖率并按各自颜色合成进 RGBA。 */
export function rasterizeGlyphs(
  glyphs: readonly PlacedGlyph[],
  width: number, height: number,
  origin: { x: number; y: number },
): Pixels
```

坐标换算：字体坐标 y 轴**向上**，文档坐标 y 轴**向下**，所以取轮廓点时 y 取负；缩放系数是 `size / face.unitsPerEm`，再分别乘 `horizontalScale` / `verticalScale`。

已验证的参考实现见提交说明里引用的 spike：922×126 两行文字，排版加栅格化合计 31ms。

- [ ] **Step 4: 运行，确认通过**

- [ ] **Step 5: 补齐测试**

- 半像素偏移的矩形：边缘那一列 alpha 约为 128（±8），证明抗锯齿真的在算而不是二值化
- 非零环绕：一个带反向内圈的字形（"O"）中心必须是透明的
- 两个字形重叠：后画的按 alpha 合成，不是直接覆盖
- 颜色来自 `PlacedGlyph.color`，同一次调用里不同字形可以不同色
- 完全在画布外的字形不影响结果、也不越界写
- 空字形列表 → 全透明画布

- [ ] **Step 6: 提交**

---

## Task 4: opentype.js 适配 —— `FontFace` 的真实实现

**Files:**
- Modify: `packages/doctype-psd/package.json`（加 `opentype.js`）
- Create: `packages/doctype-psd/src/text/opentype-face.ts`
- Test: `packages/doctype-psd/tests/text-opentype-face.test.ts`

**Interfaces:**
- Produces: `parseFontFace(bytes: Uint8Array): FontFace`、`fontCoverage(face): CoverageSummary` —— Task 5 预置时用来解析度量与覆盖范围

- [ ] **Step 1: 加依赖**

```bash
pnpm --filter @unidocs/doctype-psd add opentype.js@^2.0.0
```

零依赖、有 ESM 构建（压缩后 239 KB）。**必须从 ESM 入口引**（`opentype.js` 的默认导出是 CJS，具名导入 `parse` 会失败）。

- [ ] **Step 2: 造测试用的字体**

不提交第三方字体二进制，也不依赖系统字体（CI 上没有）。用 opentype.js 自己的构造 API **在测试里生成**一套字形已知的字体 —— 度量是我们指定的，断言才有意义。

```ts
// tests/text-test-font.ts
import { Font, Glyph, Path } from "opentype.js";
/** 一套只有 A/B 两个字形的字体：A 是 500x700 的实心矩形，advance 600。 */
export function buildTestFont(): Uint8Array
```

- [ ] **Step 3: 写失败的测试**

```ts
it("从字体文件解析出的度量与构造时指定的一致", () => {
  const face = parseFontFace(buildTestFont());
  expect(face.unitsPerEm).toBe(1000);
  expect(face.advance("A".codePointAt(0)!)).toBe(600);
  expect(face.has("A".codePointAt(0)!)).toBe(true);
  expect(face.has("中".codePointAt(0)!)).toBe(false);
});
```

- [ ] **Step 4: 运行，确认失败**

- [ ] **Step 5: 实现 `parseFontFace`**

把 opentype 的 `Font` 包成 `FontFace`：`unitsPerEm` / `ascender` / `descender` 直读；`has` 查 `charToGlyphIndex(...) > 0`；`advance` 用 `glyph.advanceWidth`；`kerning` 用 `font.getKerningValue`；`outline` 用 `glyph.getPath(0, 0, unitsPerEm)` 再把命令翻成我们的 `PathCommand`。

**缓存**：`has` / `advance` / `outline` 每次都查表很浪费，用 `Map` 按码位缓存。

- [ ] **Step 6: 运行，确认通过**

- [ ] **Step 7: 端到端验一次真实字体**

把 Task 2 + Task 3 + 本任务串起来，用生成的测试字体排一行字并栅格化，断言墨迹宽度等于 `字符数 × advance/unitsPerEm × size`（矩形字形，可精确预测）。这一条是三个任务之间接口对不对的唯一守门人。

- [ ] **Step 8: 提交**

---

## Task 5: 字体索引与预置

**Files:**
- Create: `packages/doctype-psd/src/text/registry.ts`（索引的形状与查找逻辑，纯）
- Create: `packages/cloudflare-psd/src/fonts-do.ts`（租户级 DO）
- Modify: `packages/cloudflare-psd/wrangler.toml`（第三个 DO namespace）
- Modify: `packages/cloudflare-psd/src/worker.ts`（绑定与路由）
- Modify: `packages/doctype-psd/src/model/types.ts`（`PsdDoc.fonts`）
- Modify: `packages/doctype-psd/src/psd/ir.ts` + `state.ts`（`fonts` 进 IR，SBlob 保活）
- Create: `stacks/unidocs-cloudflare/local/seed-fonts.mjs`（预置脚本）
- Test: `packages/doctype-psd/tests/text-registry.test.ts`

**Interfaces:**
- Consumes: `parseFontFace`（Task 4）
- Produces: `resolveFaceChain(index, requested, fallbacks): FaceResolver` —— Task 6 用它构造传给 `layoutText` 的解析器

- [ ] **Step 1: 定索引形状**

```ts
export interface FontEntry {
  readonly postScriptName: string;
  readonly family: string;
  readonly hash: string;
  /** 从字体文件解析出来的，不是登记时填的 —— 填错了字还是那些字，位置全错。 */
  readonly unitsPerEm: number;
  /** 覆盖的码位区间，合并后的有序列表。逐字符回退靠它。 */
  readonly coverage: readonly (readonly [number, number])[];
}
```

- [ ] **Step 2: 写失败的回退链测试**

```ts
it("逐字符回退：英文用请求的字体，中文掉到中文兜底", () => {
  const resolve = resolveFaceChain(index, "JosefinSans-Bold", ["NotoSans", "NotoSansSC"]);
  expect(resolve(0x41, "JosefinSans-Bold")?.postScriptName).toBe("JosefinSans-Bold");
  expect(resolve(0x4e2d, "JosefinSans-Bold")?.postScriptName).toBe("NotoSansSC");
});
```

- [ ] **Step 3: 实现查找与回退**

顺序：请求的字体 → 拉丁兜底 → 中文兜底 → `null`。判断依据是 `coverage` 里有没有这个码位（二分查找）。

- [ ] **Step 4: 文档侧的保活**

`PsdDoc.fonts?: FontRef[]`（`{ postScriptName, blob }`），进 IR 与 SValue。CAS 的 GC 靠文档里的 SBlob 引用钉住 blob，只被索引引用的字体会被回收（设计文档 §3.6）。

往返测试：`save()` → `load()` 之后 `fonts` 不丢。

- [ ] **Step 5: 租户级 DO**

`PsdFonts`，sqlite 存储，按 `tenantId` 取实例。两个内部端点：`GET /_internal/fonts` 列出索引，`POST /_internal/fonts` 登记一条。psd worker 加第三个 `durable_objects.bindings`，和既有两个同一套写法（`wrangler.toml` 已有 `PSD_EDITOR` / `PSD_OPERATOR` 可照抄）。

- [ ] **Step 6: 预置脚本**

读一份配置（字体名 → 文件路径），上传 blob 到 CAS，用 `parseFontFace` **解析出** `unitsPerEm` 与 `coverage`（不许配置文件填），登记进 DO。配置项而不是硬编码，加字体不用改代码。

预置至少两套：一套拉丁兜底、一套中文兜底（OFL 许可）。

- [ ] **Step 7: 提交**

---

## Task 6: `setText` effect 与 `set_text` op

**Files:**
- Create: `packages/doctype-psd/src/text/set-text.ts`（effect 工具）
- Modify: `packages/doctype-psd/src/ops/layer-ops.ts`（`setText` op handler）
- Modify: `packages/doctype-psd/src/ops/index.ts`（注册进 `HANDLERS`）
- Modify: `packages/doctype-psd/src/agent.ts`（工具表条件化）
- Test: `packages/doctype-psd/tests/set-text.test.ts`

**Interfaces:**
- Consumes: `diffRange` / `spliceRuns`（Task 1）、`layoutText`（Task 2）、`rasterizeGlyphs`（Task 3）、`resolveFaceChain`（Task 5）
- Produces: `createSetTextTool(deps)`；op `set_text`，payload `{ layerId, text, pixels, bounds }`

- [ ] **Step 1: 纯 op 先行**

`set_text` 只做落地与校验：写入 `layer.text` / `layer.pixels` / `layer.bounds`。**它不算任何东西** —— 值由 effect 算好。校验：图层存在、是 `text` 类型、`runs` 长度之和等于 `content` 长度。

工具表与提示词必须**一起**条件化（`agent.ts:24` 已有先例：只条件化其中一个会产生"提示词里有、工具表里没有"的幽灵工具，线上真实发生过）。

- [ ] **Step 2: 写失败的 effect 测试**

用假字体与内存 CAS，断言：`setText` 之后图层的 `content` 是新值、`runs` 被正确切分、`pixels` 换了新 blob、`bounds` 按 `justification` 变化。

- [ ] **Step 3: 实现 effect**

编排顺序：

1. `query getDoc{layerId}` 取当前 `text`
2. `diffRange(old, new)` → `spliceRuns` —— 拒绝就直接返回错误，把"分两次改"的建议写进去
3. `resolveFaceChain` 取字体；**缺字体不静默兜底**，返回三条出路（设计文档 §8）
4. `layoutText` —— `ok: false` 就把 `reason` 交出去
5. `rasterizeGlyphs` → `writeBlob`
6. `bounds`：按 `justification` 决定哪条边不动（`left` 左不动 / `right` 右不动 / `center` 中心不动）
7. 产出 `set_text` op，带 `provenance`（与 `generative_fill` 同一套），让 UI 与 agent 知道这层像素不再是 Photoshop 烘的
8. 结果里带上 `ignored` 与 `missing`，让 agent 有机会告诉用户

- [ ] **Step 4: 运行，确认通过**

- [ ] **Step 5: 往返测试**

`setText` → `save()` → `load()`：`content`、`runs`、`fonts` 都不丢。

- [ ] **Step 6: 提交**

---

## Task 7: 提示词分流与 composer chip

**Files:**
- Modify: `packages/doctype-psd/src/tools.ts`（分流规则）
- Modify: `packages/web-psd/src/ui/panels/composer.tsx`（图层选择的 chip）
- Test: `packages/web-psd/tests/composer.test.tsx`

- [ ] **Step 1: 提示词加硬规则**

`type: "text"` 且 `editable` → **必须**走 `setText`，不许 `editPixels`；其余走 `editPixels`。这次故障的直接原因就是没有第一条路，模型只能看图猜"这是真文字还是图片上的字"，而它猜错了，连试两次生图模型去画字。

- [ ] **Step 2: 写失败的 composer 测试**

选中图层时应渲染一个可点掉的 chip（"已附带图层 X"），与既有的选区 chip 同形。

- [ ] **Step 3: 实现**

`composer.tsx:88` 现在只为 `attached`（拖出来的选区）渲染 chip，图层选择没有 —— 数据**会**发给 agent（`withTarget` 拼 `<<selection layers=[…]>>`），是显示漏了。chip 上方那段注释已经写明了理由（"state leaving the browser silently, so it is shown"），照搬到图层分支。

- [ ] **Step 4: 运行，确认通过**

- [ ] **Step 5: 提交**

---

## Task 8: 实机验证

- [ ] **Step 1: 预置字体并重启**
- [ ] **Step 2: 打开那份真实文档，让 agent 把网址改成 `www.unidocs.com`**
- [ ] **Step 3: 检查四件事**
  - agent 走的是 `setText` 而不是 `editPixels`（查 `.dev-cloudflare.log` 的 `agent_step`）
  - 画布上文字真的变了
  - 红色与字距保住了（`runs` 没被塌平）
  - `bounds` 右边界左移（`left` 对齐，少一个字符）
- [ ] **Step 4: 导出 PSD，重新导入，确认 `content` 与 `runs` 不丢**

---

## Self-Review

**Spec 覆盖**：设计文档 §2（effect 形态）→ Task 6；§3（字体，含 §3.4 逐字符回退、§3.6 保活）→ Task 5；§4（排版栅格化）→ Task 2/3/4；§5（run 切分）→ Task 1 已完成；§6（只重画编辑过的）→ Task 6 Step 3.7 的 provenance；§7（bounds 锚点）→ Task 6 Step 3.6；§8（缺字体三条出路）→ Task 6 Step 3.3；§9（分流）与 §10（UI）→ Task 7。无遗漏。

**类型一致性**：`FontFace` 在 Task 2 定义、Task 4 实现、Task 5 由 `resolveFaceChain` 返回、Task 6 传给 `layoutText` —— 四处同一个名字。`PlacedGlyph` 由 Task 2 产出、Task 3 消费。`FontEntry.coverage` 在 Task 5 Step 1 定义、Step 3 消费。

**已知风险**：Task 5 是最大的一块（新 DO namespace + 预置管线 + IR 改动），如果实施中发现 DO 那部分阻塞，可以先用"文档级 `fonts`"跑通 Task 6/7，把租户级索引单独拆出来 —— 两者的差别只在查找从哪里来，`resolveFaceChain` 的签名不变。
