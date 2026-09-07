# Azure 侧 setText —— 字体登记表下沉为跨平台契约

**日期：** 2026-09-04
**状态：** 待 review
**基线：** `main @ d1352ac`

## 现状

Azure 上没有 `setText`。用户让 agent 改一个文字层的网址，agent 回答"当前工具集中没有可以直接修改文本内容的工具"——这个回答是**正确的**，不是模型偷懒。

`createPsdAgent` 对 `setText` 条件注册（`doctype-psd/src/agent.ts`）：

```ts
if (deps.fontIndex) {
  enabled.push(createSetTextTool(deps.fontIndex));
  prompt += setTextInstructions;
}
```

判据是"有没有字体可用"：重新排版需要字形，没有字体索引连一个字形都拿不到。而两个入口的注入不对称：

| | `editor`（editPixels） | `fontIndex`（setText） |
|---|---|---|
| `cloudflare-psd/src/worker.ts:71` | `env.IMAGE_EDIT_API_KEY` ✅ | `env.PSD_FONTS` → `createFontIndexSource(...)` ✅ |
| `azure-psd/src/main.ts:40-51` | `process.env.IMAGE_EDIT_API_KEY` ✅ | **完全没有** ❌ |

这不是回归，是 PSD 文字编辑（PR #53）只接了 Cloudflare 一侧。

### 缺的是三层，不只是存储

1. **存储**：`cloudflare-psd/src/fonts-do.ts`（365 行）是一个自带 SQLite 表的 Durable Object。
2. **路由**：`POST/GET /tenants/{tid}/fonts` 由 `cloudflare-psd` 自己的 `matchFontsRoute` + `handleFontsRequest` 接住。中立的 `matchDocRoute`（`protocol-doc/src/routes.ts:88`）硬性要求 `parts[2] === "sessions"`，只认会话级路由，租户级路径在中立层没有落脚点。
3. **鉴权**：`listFonts` / `registerFont` 两个 operation 只存在于 `fonts-do.ts:265`，没有进中立的 `DocOperation`。

预置脚本 `scripts/seed-psd-fonts.mjs` 直接打 psd worker 的这个端点（`credentials.psdUrl`），不走网关；`scripts/dev.mjs:72` 的 `psdFontsEnabled = !useAzure && ...` 把本地自动预置也限定在 Miniflare 那一路。

### 为什么当初是这样，以及这个判断的修正

初稿里把它描述为"绕过了 port 集合"。更准确的说法是：**`ports.ts` 当时没有覆盖租户级这个作用域。** 该文件头写着

> Storage port contracts for the document session core.
> Every port in this module is scoped to one Doc session.

四个 port（`DeltaLog` / `SnapshotCache` / `BlobCas` / `UnitOfWork`）全部经 `SessionDeps` 喂给 `DocumentSession`，身份是含 `sessionId` 的 `SessionIdentity`。字体索引是租户级的——一个租户一套字体，被名下所有文档共用——没有任何现成的架子可挂。CF 自建一个存储不是图省事，是当时没有对称的位置。

这个修正不改变结论（Azure 侧确实没有实现），但它决定了本设计的形状：**要补的是那个缺失的租户级契约本身，不是再抄一份平台实现。**

### 让这个洞不可见的机制

工具表与提示词被刻意绑在同一个 `if` 里，避免"提示词里有、工具表里没有"的幽灵工具（线上真实发生过的故障）。副作用是：平台能力差异表现为**一次礼貌的拒绝**，而不是一个错误。没有任何一步失败，因此日志、测试、告警全都看不见。

CF 侧吃过一次相关的亏并且改了——`cloudflare-psd/src/worker.ts:51-56` 记着把接线拆成 `psdAgentDeps()` 的理由是"内联时把回退链换成 `[]` 整套单测照样全绿"——并配了 `tests/agent-deps.test.ts`。Azure 侧的接线仍内联在 `main.ts` 里，`packages/azure-psd/` 连 `tests/` 目录都没有。

## 设计决定

### D1：契约独立成模块，不进 `ports.ts`

新增 `packages/doctype-server-common/src/font-registry.ts`，与 `ports.ts` **平级且独立**。

被否决的方案是把它塞进 `ports.ts`。三条理由：

| | `ports.ts` 的四个 port | 字体登记表 |
| --- | --- | --- |
| 生命周期 | 一篇文档 | 跨该租户所有文档 |
| 身份 | `SessionIdentity`（含 `sessionId`） | 只有 `(stackId, tenantId)` |
| 消费者 | `DocumentSession` 经 `SessionDeps` | 路由处理器 + agent 依赖，**永远不进 `SessionDeps`** |

第三条是决定性的：`ports.ts` 存在的全部理由就是喂 `SessionDeps`，放进去它会是那个文件里唯一没有消费者的接口，并且当场作废文件头那句不变式。

同理，适配器也不塞进 `ports-pg.ts` / `ports-cf.ts`，各自独立成文件。

### D2：具体的 `FontRegistry`，不是泛型登记表

中途考虑过泛型的 `TenantRegistry { list(kind), put(kind, key, payload) }`，让"字体"这个领域概念不必下沉。**放弃它**，理由三条：

- `kind` 只有一个值，"将来别的租户级状态也能用"是想象出来的第二个用户。
- `fonts-do.ts` 的表本来就是五个具名列，具体契约与它一比一对上；泛型版反而要在适配器里把五列打包成不透明 JSON 再拆开。
- 泛型把编译期约束换成运行时校验，而这里没有换来任何东西。

代价是 `FontEntry` 必须住在中立层（见 D3）。

### D3：`FontEntry` 从 `doctype-psd` 下沉到 `doctype-server-common`

依赖方向是 `doctype-psd → doctype-server-common`，反过来不行。中立的路由处理器要引用这个类型，它就必须在下面。

这不是"不得不"，本身也是合理的：`FontEntry` 的字段（`postScriptName` / `family` / `hash` / `unitsPerEm` / `coverage`）全是**字体文件的存储元数据**，不是 PSD 的文档语义；而需要字体的不止 PSD，任何要排版文字的 doctype 都要。

`doctype-psd/src/text/registry.ts` 改为 re-export，现有 import 一行不用改。

**这是本设计里唯一真正的取舍。** 不接受这次下沉，就只能放弃路由下沉——两边各写各的路由与鉴权，预置脚本走两条路径。

### D4：预置沿用同一个脚本，人工跑

路由下沉之后，`seed-psd-fonts.mjs` 把 URL 指向哪个 service 就灌哪个，本地与线上同一条路径。

被否决的方案是加一个部署 job 自动灌：字体字节要么进镜像（违反裁定 R19「字节不进仓库」），要么构建时从公网下载，等于给部署加一条供应链依赖。代价是新环境要记得手工跑一次——写进运维文档。

## 组件与接口

### 契约（中立）

```ts
// packages/doctype-server-common/src/font-registry.ts

/** 覆盖的码位区间，合并后按起点升序排列，区间之间不重叠也不相邻。 */
export type FontCoverage = readonly (readonly [number, number])[];

export interface FontEntry {
  readonly postScriptName: string;
  readonly family: string;
  /** CAS 里字体文件的内容哈希。 */
  readonly hash: string;
  readonly unitsPerEm: number;
  readonly coverage: FontCoverage;
}

/** 租户级字体登记表。作用域是 (stackId, tenantId)，跨会话存活。
 *  与 ports.ts 刻意分开：那里每个 port 都绑一个 sessionId。 */
export interface FontRegistry {
  list(): Promise<readonly FontEntry[]>;
  /** 幂等：同一个 postScriptName 重登记覆盖旧的一条。 */
  put(entry: FontEntry): Promise<void>;
}
```

跟着一起下沉的还有 `FontCoverage`——它今天是 `doctype-psd/src/text/opentype-face.ts:22` 的一行类型别名，`FontEntry` 引用它。`opentype-face.ts` 其余部分（opentype.js 适配）留在原地并 re-export 这个别名。

`unitsPerEm` 字段上那段长注释（说明它**没有可观测后果**、排版读的是渲染时现解析的 `face.unitsPerEm`）逐字带过去：它记录的是一次被误导的测试补强，删掉等于把那个教训作废。

### 路由（中立）

`protocol-doc/src/routes.ts` 新增与 `matchDocRoute` 平行的 `matchTenantRoute`：

```
GET  /tenants/{tenantId}/fonts   → listFonts
POST /tenants/{tenantId}/fonts   → registerFont
```

operation 用**独立的 union** `TenantOperation = "listFonts" | "registerFont"`，**不并入 `DocOperation`**。后者喂给网关的 `docCapabilityPolicy`，是个无 `default` 的穷尽 switch，加成员会强迫为两个根本不走网关的操作编一套 deadline 策略。它们是另一个路由族：租户级、非会话级、预置脚本直连 doc service。

### 鉴权

沿用现有 capability 校验，权限为租户级。`fonts-do.ts` 现有的校验逻辑（含 `fontEntryProblem()` 的请求体校验）随路由一起搬进中立层——`fontEntryProblem` 仍然需要，它守的是 HTTP 边界上的不可信输入，与 D2 的编译期类型不重叠。

### 适配器

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Cloudflare | `cloudflare-psd/src/font-registry-do.ts` | 薄适配层，`list/put` 映到现有 `fonts-do.ts` 的 `GET`/`POST`。**DO 内部不重写、表结构不动**，线上已有数据不受影响。 |
| Azure | `azure-sdk/src/font-registry-pg.ts` | `PgFontRegistry`，新表 + 迁移。 |

### Azure 表结构

新增 `packages/azure-sdk/migrations/0005_font_registry.sql`：

```sql
CREATE TABLE IF NOT EXISTS font_registry (
  stack_id        text    NOT NULL,
  tenant_id       text    NOT NULL,
  post_script_name text   NOT NULL,
  family          text    NOT NULL,
  hash            text    NOT NULL,
  units_per_em    integer NOT NULL,
  coverage        jsonb   NOT NULL,
  PRIMARY KEY (stack_id, tenant_id, post_script_name)
);
```

`put` 用 `INSERT ... ON CONFLICT DO UPDATE`，与 CF 的 `INSERT OR REPLACE` 同语义（幂等，预置脚本每次跑都会把全套字体登记一遍）。落在每个 doc type 自己的库，迁移走 azure-sdk 现有的 `migrate-cli`。

### `FontIndexSource` 合并为一个中立实现

`doctype-psd/src/text/font-index.ts`（新）：拿一个 `FontRegistry`，`list()` → `FontIndex`，附 60 秒缓存。缓存逻辑从 `cloudflare-psd/src/fonts-source.ts` 搬过来，含它现有的两条不变式：

- 缓存的是 Promise 而不是结果，让同一实例内并发的两次 `setText` 只打一次后端；
- 失败不留在缓存里，否则一次抖动会被整整记住一个 TTL。

搬完之后 `cloudflare-psd/src/fonts-source.ts` 只剩构造参数，平台差异收敛到 `FontRegistry` 那一层。

## 数据流

预置（两个栈同形）：

```
seed-psd-fonts.mjs
  ├─ 字体字节 ──► CAS（内容寻址，得到 hash）
  └─ POST /tenants/{tid}/fonts ──► doc service ──► FontRegistry.put(entry)
```

排版：

```
setText effect
  └─ FontIndexSource.load() ──► FontRegistry.list() ──► FontIndex
     └─ blobFor(entry) ──► SBlob ──► ctx.readBlob ──► CAS 取字节 ──► 排版 + 栅格化
```

字节始终不经 `FontRegistry`：登记表只存 hash，字节在 CAS，由 effect 自己带会话身份去读（沿用裁定 R29）。保活仍由 `storePsdDoc` → `storeFont` 用 `context.makeSBlob` 重新建立。

## 接线与测试

### Azure 接线拆出来

`packages/azure-psd/src/agent-deps.ts` 导出 `psdAgentDeps(env)`，与 CF 的 `psdAgentDeps(env, identity)` 对称；`main.ts` 只负责调用。新建 `packages/azure-psd/tests/`。

### 测试策略

| 层 | 测什么 |
| --- | --- |
| 契约 | `FontRegistry` 的共享契约测试（沿用 `doctype-server-common/src/testing/port-contract.ts` 的既有做法），两个适配器都跑一遍：登记后能读回、同名覆盖、空表返回空 |
| Azure 适配器 | `PgFontRegistry` 对真 Postgres（azure-sdk 已有 compose 夹具） |
| CF 适配器 | 对现有 DO，断言与搬动前的行为逐字一致 |
| 路由 | 中立路由匹配 + 鉴权 + `fontEntryProblem` 拒绝畸形请求 |
| 接线 | `packages/azure-psd/tests/agent-deps.test.ts`，与 CF 的同名测试对称 |
| **parity** | `tests/unit/` 新增：同等注入下，两个栈的 psd agent **工具名集合必须相等** |

最后一条是这次真正缺的守卫。做了 parity 却没留下守住 parity 的测试，是这个洞能存在三周的原因。

## 错误处理

- 索引为空：`setText` 已经注册（`FontRegistry` 存在即注册），排版时找不到任何字体应当明确失败并说明如何预置，而不是静默回退到"没有字形"。
- 请求的字体缺席：沿用现有行为——走回退链让编辑成功，但**显式报告**替换（用户既定：字体缺就先用默认字体兜底，后面再优化）。
- 畸形登记请求：`fontEntryProblem()` 拒绝，400。
- 后端不可达：`load()` 抛出，`setText` 失败并带出原因；不缓存失败。

## 不做的

- 不给部署加自动灌字体的 job。
- 不重写 CF 的 Durable Object，不迁移它的表。
- `FontRegistry` 不加 `delete`、不加分页——等真有需求。
- 不动网关的 `DocOperation` / `docCapabilityPolicy`。
- 不碰 `setText` 的排版与栅格化逻辑本身。

## 风险与未决

1. **Azure 的 capability 签发形状是否与 CF 完全一致**，决定 `seed-psd-fonts.mjs` 能否零改动指向 Azure。实现第一步先验证这一点；若不一致，脚本需要一个 `--stack` 参数选择签发方式，仍是同一条代码路径。
2. **线上首次预置**是人工动作，新环境漏跑的表现是 `setText` 注册了但排不出字。需写进 `stacks/unidocs-azure/README.md` 的运维清单。
3. `FontEntry` 下沉后 `doctype-psd` 的 re-export 若被后续重构清理掉，会静默断开——搬动时在 re-export 处写明理由。
