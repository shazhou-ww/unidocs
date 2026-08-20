# Agent 工具重构 — 实施计划

> **给执行者:** 按任务顺序实现。每个任务是最小可测交付单元,步骤用 `- [ ]`
> 勾选;每步先写失败测试、再实现、再验证、再提交。

**目标:** 让 PSD 领域 agent(Operator)真正*理解*各 operation、并能*看到*文档,
使多步空间编辑(如"3 张图变 2 张")从"靠运气"变成"可靠做对"。

**架构:** Operator 的 ReAct 循环把 doctype 的 `tools` 暴露给 Claude;工具分
`query`(读)/`apply`(写)两类,经 Editor DO 执行。本计划:①路由改元数据驱动、
名字变干净;②补齐 schema/instructions;③加 `getDoc` 读完整 IR;④加 `getPreview`
三态并把渲染图作为 image 反馈给 agent。

**技术栈:** TypeScript、Cloudflare Workers/DO、ag-psd、fast-png、纯 TS 软件合成器;
LLM 走 Anthropic Messages(经 `cloudflare-psd/src/anthropic.ts` 转换)。

**Spec:** 本仓库 `packages/doctype-psd/docs/design.md` 与本次讨论结论。

## 全局约束

- 语义对齐 Adobe PSD,不造新概念;沿用 PSD 字段名与 4 字符键(brit/blwh/hue2…)。
- `bounds` 一律 `[top,left,bottom,right]`,单位像素,原点左上,y 向下。
- 只支持 8-bit RGB。
- 改动共享包(`packages/core`、`cloudflare-sdk`)必须对 markdown/docx 向后兼容。
- 每个任务结束跑 `pnpm --filter @unidocs/doctype-psd test`(及所动包的 test)保持全绿。

---

## 文件结构

- `packages/core/src/index.ts` — `AgentToolDefinition` 加 `op` 元数据。
- `packages/cloudflare-sdk/src/operator-do.ts` — 路由改元数据驱动(带前缀兜底);
  提取纯函数 `resolveToolRoute` 便于测试。
- `packages/cloudflare-sdk/src/tool-route.ts` — 新增,纯路由解析 + 单测目标。
- `packages/cloudflare-psd/src/anthropic.ts` — `$image` tool 结果 → Anthropic image block。
- `packages/doctype-psd/src/tools.ts` — 干净名字 + `op` 元数据 + 写实 schema + instructions。
- `packages/doctype-psd/src/queries.ts` — 新增 `getDoc`、扩展 `getPreview`。
- `packages/doctype-psd/src/render/composite.ts` — `renderRegion` / `renderLayer` / 缩放。
- `packages/doctype-psd/src/render/index.ts` — 导出新渲染辅助。
- 对应 `packages/doctype-psd/tests/*` 与 `packages/cloudflare-sdk/tests/*`。

---

## 任务 1:`AgentToolDefinition` 增加 `op` 元数据 + 纯路由解析

**Files:**
- 改:`packages/core/src/index.ts`(`AgentToolDefinition`)
- 建:`packages/cloudflare-sdk/src/tool-route.ts`
- 测:`packages/cloudflare-sdk/tests/tool-route.test.ts`

**Interfaces:**
- 产出:`AgentToolDefinition.op?: { mode: "query" | "apply"; kind: string }`
- 产出:`resolveToolRoute(name: string, def?: AgentToolDefinition): { mode: "query"|"apply"; kind: string } | null`

- [ ] **步骤 1:写失败测试** `tests/tool-route.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { resolveToolRoute } from "../src/tool-route.js";

describe("resolveToolRoute", () => {
  it("uses op metadata when present", () => {
    expect(resolveToolRoute("setLayerProps", { name: "setLayerProps", description: "", inputSchema: {}, op: { mode: "apply", kind: "set_props" } }))
      .toEqual({ mode: "apply", kind: "set_props" });
  });
  it("falls back to query_/apply_ prefix when op is absent", () => {
    expect(resolveToolRoute("query_getLayers")).toEqual({ mode: "query", kind: "getLayers" });
    expect(resolveToolRoute("apply_set_props")).toEqual({ mode: "apply", kind: "set_props" });
  });
  it("returns null for an unrecognized name", () => {
    expect(resolveToolRoute("frobnicate")).toBeNull();
  });
});
```

- [ ] **步骤 2:运行,确认失败**
`pnpm --filter @unidocs/cloudflare-sdk exec vitest run tests/tool-route.test.ts` → 期望 FAIL(模块不存在)。

- [ ] **步骤 3:在 core 加 `op` 字段**
`packages/core/src/index.ts` 的 `AgentToolDefinition` 增加可选字段:
```ts
op?: { mode: "query" | "apply"; kind: string };
```

- [ ] **步骤 4:实现 `tool-route.ts`**
```ts
import type { AgentToolDefinition } from "@unidocs/core";

export function resolveToolRoute(
  name: string,
  def?: AgentToolDefinition,
): { mode: "query" | "apply"; kind: string } | null {
  if (def?.op) return { mode: def.op.mode, kind: def.op.kind };
  if (name.startsWith("query_")) return { mode: "query", kind: name.slice(6) };
  if (name.startsWith("apply_")) return { mode: "apply", kind: name.slice(6) };
  return null;
}
```

- [ ] **步骤 5:运行测试,确认通过**;`pnpm --filter @unidocs/core exec tsc --noEmit` 同过。

- [ ] **步骤 6:提交** `feat(sdk): tool op metadata + resolveToolRoute`

---

## 任务 2:Operator 按元数据路由

**Files:**
- 改:`packages/cloudflare-sdk/src/operator-do.ts`
- 测:沿用任务 1 的 `resolveToolRoute` 单测(此任务改为集成到 DO)

**Interfaces:**
- 消费:`resolveToolRoute`
- 产出:Operator 循环中 `toolName` → `{mode,kind}` 的路由不再内联 `startsWith/slice`

- [ ] **步骤 1:建 name→def 映射**
在 `/_internal/run` 处理里,tools 构建处旁边:
```ts
const defByName = new Map(Object.values(config.tools).map((t) => [t.name, t]));
```

- [ ] **步骤 2:替换分发逻辑**
把原 `if (toolName.startsWith("query_")) {...} else if (toolName.startsWith("apply_"))` 改为:
```ts
const route = resolveToolRoute(toolName, defByName.get(toolName));
if (!route) { result = { error: `Unknown tool: ${toolName}` }; }
else if (route.mode === "query") {
  const resp = await editorStub.fetch("http://editor/_internal/query", {
    method: "POST", body: JSON.stringify({ kind: route.kind, payload: args }),
  });
  /* …原查询处理,queryKind 换成 route.kind… */
} else { /* apply:opKind 换成 route.kind,其余乐观锁逻辑不变 */ }
```
顶部 `import { resolveToolRoute } from "./tool-route.js";`。

- [ ] **步骤 3:类型检查 + SDK 构建**
`pnpm --filter @unidocs/cloudflare-sdk exec tsc --noEmit` 通过;`… run build` 刷新 dist。

- [ ] **步骤 4:回归**——用现有 psd 冒烟(创建→run 改透明度)确认仍成功(前缀兜底期)。

- [ ] **步骤 5:提交** `refactor(sdk): operator routes by tool metadata`

---

## 任务 3:psd 工具改干净名字 + `op` 元数据 + 写实 schema

**Files:**
- 改:`packages/doctype-psd/src/tools.ts`
- 测:`packages/doctype-psd/tests/tools.test.ts`(新建)

**Interfaces:**
- 产出:工具集(干净名 + op + 严格 schema),供 Operator 与 doctype 使用。
- 命名映射(name → op.kind):`getLayers→query getLayers`、`getDoc→query getDoc`、
  `getPreview→query getPreview`、`addLayer→apply add_layer`、`removeLayer→apply remove_layer`、
  `reorderLayer→apply reorder`、`setLayerProps→apply set_props`、`cropCanvas→apply crop`、
  `transformLayer→apply transform`、`setAdjustment→apply adjust`、`editMask→apply mask_edit`、
  `generativeFill→apply generative_fill`。

- [ ] **步骤 1:写失败测试** `tests/tools.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { tools } from "../src/tools.js";

describe("tools", () => {
  it("every tool has clean name + op metadata", () => {
    for (const t of Object.values(tools)) {
      expect(t.name).not.toMatch(/^(query_|apply_)/);
      expect(["query", "apply"]).toContain(t.op!.mode);
      expect(typeof t.op!.kind).toBe("string");
    }
  });
  it("blendMode / adjustType schemas are enumerated", () => {
    const setProps = tools.set_props.inputSchema as any;
    expect(setProps.properties.props.properties.blendMode.enum).toContain("multiply");
  });
});
```

- [ ] **步骤 2:运行确认失败。**

- [ ] **步骤 3:重写 `tools.ts`**——为每个工具写:干净 `name`、`op:{mode,kind}`、严格
`inputSchema`。共享枚举:
```ts
const BLEND_MODES = ["normal","dissolve","darken","multiply","color-burn","linear-burn","lighten","screen","color-dodge","linear-dodge","overlay","soft-light","hard-light","vivid-light","linear-light","difference","exclusion","subtract","divide","hue","saturation","color","luminosity","pass-through"];
const ADJUST_TYPES = ["brit","blwh","hue2","levl","curv"];
const LAYER_SCHEMA = { type: "object", properties: {
  id: { type: "string" }, type: { enum: ["raster","adjustment","fill","text","smartObject","group"] },
  name: { type: "string" }, bounds: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
  opacity: { type: "number", minimum: 0, maximum: 1 }, blendMode: { enum: BLEND_MODES },
  visible: { type: "boolean" }, clipping: { type: "boolean" },
  adjustType: { enum: ADJUST_TYPES }, params: { type: "object" },
}, required: ["id","type","bounds"] };
```
`set_props.inputSchema.props` 用受限属性(name/opacity/blendMode(enum)/visible/locked/clipping);
`transform` 描述写明"仅 translate/flip"。

- [ ] **步骤 4:运行 tools.test 通过。**

- [ ] **步骤 5:回归** 全套 `pnpm --filter @unidocs/doctype-psd test`(doctype.test 若断言旧名字需同步)。

- [ ] **步骤 6:提交** `feat(psd): clean tool names + strict schemas`

---

## 任务 4:重写 `instructions`(讲清模型)

**Files:**
- 改:`packages/doctype-psd/src/tools.ts`(`instructions` 常量)
- 测:`packages/doctype-psd/tests/instructions.test.ts`(新建,轻断言)

- [ ] **步骤 1:写失败测试**
```ts
import { describe, it, expect } from "vitest";
import { instructions } from "../src/tools.js";
describe("instructions", () => {
  it("teaches the coordinate + clipping model", () => {
    expect(instructions).toMatch(/\[top, ?left, ?bottom, ?right\]/);
    expect(instructions.toLowerCase()).toContain("clipping");
    expect(instructions.toLowerCase()).toContain("getpreview");
  });
});
```

- [ ] **步骤 2:运行确认失败。**

- [ ] **步骤 3:重写 `instructions`**,至少覆盖:坐标系(`[top,left,bottom,right]`、px、y 向下)、
canvas 尺寸从 `getDoc` 取、clipping(裁到正下方基底,移动需连基底)、mask(灰度覆盖)、
`transform` 仅 translate/flip、id 由调用方分配、raster 需 pixels、调整键(brit/blwh/hue2)与参数、
以及"编辑前后用 getPreview(可带 rect/layerId)看图复核"的工作流示例。

- [ ] **步骤 4:测试通过 + 提交** `docs(psd): rewrite operator instructions`

---

## 任务 5:`getDoc` — 读取完整 IR(剥离像素)

**Files:**
- 改:`packages/doctype-psd/src/queries.ts`、`src/tools.ts`
- 测:`packages/doctype-psd/tests/query-getdoc.test.ts`(新建)

**Interfaces:**
- 产出:`PsdQuery` 增 `{ kind: "getDoc"; payload?: { layerId?: string } }`
- 产出:返回 `PsdDoc` 结构,`pixels.data`/`mask.pixels.data` 替换为 `{ width, height, omitted: true }`

- [ ] **步骤 1:写失败测试**——构造含 1 个 raster 层的 doc,`getDoc` 返回结构里
`layers[0].pixels` 为 `{width,height,omitted:true}` 且**不含** `data` 数组;`{layerId}` 只返回该层。

- [ ] **步骤 2:运行确认失败。**

- [ ] **步骤 3:实现**——`runQuery` 加 `getDoc` 分支:深拷贝 doc,递归把每个
`pixels`/`mask.pixels` 的 `data` 换成 `{width,height,omitted:true}`;有 `layerId` 则
`findLayer` 后只返回该子树。`tools.ts` 暴露 `getDoc`(op.mode query)。

- [ ] **步骤 4:测试通过 + 提交** `feat(psd): getDoc query (IR without pixels)`

---

## 任务 6:渲染辅助 `renderRegion` / `renderLayer` + 缩放

**Files:**
- 改:`packages/doctype-psd/src/render/composite.ts`、`src/render/index.ts`
- 测:`packages/doctype-psd/tests/render-region.test.ts`(新建)

**Interfaces:**
- 产出:`renderRegion(doc, rect: [number,number,number,number]): Pixels`
- 产出:`renderLayer(doc, layerId: string, opts?: { context?: boolean }): Pixels`
- 产出:`downscale(px: Pixels, maxSize: number): Pixels`

- [ ] **步骤 1:写失败测试**——2×1 画布,左红右蓝;`renderRegion(doc,[0,1,1,2])` 返回
1×1 蓝;`renderLayer(doc, blueLayerId)` 返回该层裁到 bounds;`downscale` 把 4×4 缩到 2×2 尺寸正确。

- [ ] **步骤 2:运行确认失败。**

- [ ] **步骤 3:实现**——`renderRegion`:`render(doc)` 后按 rect copy 子矩形;`renderLayer`:
raster/group 构造只含该层的临时 doc 渲染后裁到 bounds(调整/clip 层且 `context` 时改为
整图裁 bounds);`downscale`:最近邻按 `maxSize` 等比缩。`index.ts` 导出三者。

- [ ] **步骤 4:测试通过 + 提交** `feat(psd): region/layer render helpers`

---

## 任务 7:`getPreview` 三态查询 + 工具(返回 `$image`)

**Files:**
- 改:`packages/doctype-psd/src/queries.ts`、`src/tools.ts`
- 测:`packages/doctype-psd/tests/query-getpreview.test.ts`(新建)

**Interfaces:**
- 产出:`getPreview` 入参 `{ rect?, layerId?, maxSize? }`
- 产出:返回 `{ $image: { base64: string; mediaType: "image/png" }, width, height, region }`

- [ ] **步骤 1:写失败测试**——`{}` 返回整画布尺寸(≤maxSize)的 PNG(base64 非空);
`{rect}` 返回该区域尺寸;`{layerId}` 返回该层区域;`maxSize` 生效。校验 `region` 字段。

- [ ] **步骤 2:运行确认失败。**

- [ ] **步骤 3:实现**——按入参选 `render`/`renderRegion`/`renderLayer` → `downscale(maxSize默认768,
rect 允许到 1536)` → `encode` PNG → base64。`tools.ts` 暴露 `getPreview`(op.mode query),
schema `{ rect?, layerId?, maxSize? }`,描述引导"编辑前后看图"。

- [ ] **步骤 4:测试通过 + 提交** `feat(psd): getPreview (whole/region/layer) as $image`

---

## 任务 8:Anthropic 转换层把 `$image` tool 结果变 image block

**Files:**
- 改:`packages/cloudflare-psd/src/anthropic.ts`
- 测:`packages/cloudflare-psd/tests/anthropic-image.test.ts`(新建,导出 `toAnthropic` 供测)

**Interfaces:**
- 消费:tool 结果 JSON 里的 `$image:{base64,mediaType}`
- 产出:`role:"tool"` 且内容含 `$image` → Anthropic `tool_result` 内嵌 image block

- [ ] **步骤 1:导出并测**——把 `toAnthropic` 导出;测试:一条
`{role:"tool", tool_call_id:"t1", content: JSON.stringify({$image:{base64:"AAAA",mediaType:"image/png"}, region:[0,0,10,10]})}`
经 `toAnthropic` 后,对应 user 消息里含 `{type:"tool_result", tool_use_id:"t1", content:[{type:"image", source:{type:"base64", media_type:"image/png", data:"AAAA"}}, {type:"text", ...}]}`。

- [ ] **步骤 2:运行确认失败。**

- [ ] **步骤 3:实现**——`toAnthropic` 处理 `role:"tool"` 时,先 `JSON.parse` content,
若含 `$image` 则输出 image block(+ 一行文字元信息 region/尺寸),否则维持纯文本 tool_result。
保持多个 tool_result 合并进同一 user 消息的既有逻辑。

- [ ] **步骤 4:端到端验证**——用 fashion PSD 跑一条"看一下中间区域"指令,确认 agent 能
调用 `getPreview` 且不报错(需 `.dev.vars` key);`maxSize` 缩放使 token 可控。

- [ ] **步骤 5:提交** `feat(psd): feed getPreview image back to the agent`

---

## 自查

- **Spec 覆盖:** 路由(任务1-2)、讲解(3-4)、读 IR(5)、看图(6-8)——四条工作流全覆盖。
- **类型一致:** `op:{mode,kind}` 在 core/sdk/tools 三处一致;工具 name↔op.kind 映射见任务 3。
- **向后兼容:** 任务 2 保留前缀兜底,markdown/docx 未加 `op` 也照常路由。
- **无占位:** 每步含具体代码/命令/断言。

## 执行顺序与交接

按 1→2→3→4→5→6→7→8 顺序执行(1-2 先落最终路由,3-4 落最终命名与讲解,5 文本读,
6-8 看图闭环)。已完成:`maxIterations` 10→25。

**暂不做:** 其它图层效果(渐变/描边/投影/发光)、`transform` 缩放旋转、
brit/blwh/hue2 以外的调整类型、智能对象再编辑。
