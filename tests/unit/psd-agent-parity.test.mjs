/**
 * 两个栈的 psd agent 工具表必须一致。
 *
 * 这是本轮真正缺的守卫。setText 在 Azure 上缺席了三周，期间没有任何测试、
 * 日志或告警会说话 —— 工具表与提示词被刻意绑在同一个 `if` 里（避免"提示词里
 * 有、工具表里没有"的幽灵工具，那是线上真实发生过的故障），副作用是**平台
 * 能力差异表现为一次礼貌的拒绝，而不是一个错误**：没有任何一步失败，所以
 * 日志、测试、告警全都看不见。
 *
 * 断言的是**工具名集合**，不是实现：两边的 editor / fontIndex 后端本来就不同
 * （CF 是租户级 DO，Azure 是 Postgres 连接池），该一致的是"模型能看见哪些
 * 工具"。
 *
 * **必须指向 `agent-deps.ts` 本身，不能是包入口。** `azure-psd` 的包入口是
 * `src/main.ts`，而那个文件在模块顶层就 `runDocTypeService(...)` —— import 它
 * 会真的把服务跑起来（连 Postgres、绑端口）。`cloudflare-psd` 的 `src/worker.ts`
 * 同理（顶层 `createEditorDO` / `createOperatorDO` / `export default`）。两个
 * `agent-deps.ts` 都只导出纯函数，import 不产生任何副作用。
 *
 * 走相对路径而不是 `@unidocs/*` 裸规格：仓库根的 `node_modules` 里没有
 * `@unidocs/*` 链接（根 `package.json` 不依赖任何 workspace 包），`tests/` 下
 * 现有的测试也都是相对路径 import。vitest 会当场转译这两个 `.ts`。
 */
import { describe, expect, it } from "vitest";
import { createPsdAgent } from "../../packages/doctype-psd/src/index.ts";
import { psdAgentDeps as cfDeps } from "../../packages/cloudflare-psd/src/agent-deps.ts";
import { psdAgentDeps as azDeps } from "../../packages/azure-psd/src/agent-deps.ts";

const identity = { docType: "psd", sessionId: "s1", tenantId: "t1" };

/**
 * CF 的 `PSD_FONTS` 绑定。`createFontIndex` 是惰性的 —— 构造期不打后端，
 * 第一次 `list()` 才 `namespace.get(...).fetch(...)`，所以这个假件只需要在
 * 形状上过得去。**必须造出来**：造不出假件就跳过这一侧的 `fontIndex` 注入，
 * 会让下面的 parity 断言变成自欺。
 */
const fakeNamespace = () => ({
  idFromName: name => name,
  get: () => ({ fetch: async () => Response.json({ fonts: [] }) }),
});

/**
 * Azure 的 `pool`。接线只把它交给 `PgFontRegistry` 的构造函数存起来，
 * 构造期不发一条 SQL —— 同样只需要形状上过得去。
 */
const fakePool = () => ({ query: async () => ({ rows: [] }) });

const cfEnv = { CAS_STACK_ID: "s", IMAGE_EDIT_API_KEY: "k", PSD_FONTS: fakeNamespace() };
const azEnv = { CAS_STACK_ID: "s", IMAGE_EDIT_API_KEY: "k" };

const cfToolNames = () => createPsdAgent(cfDeps(cfEnv, identity)).tools.map(t => t.name);
const azToolNames = () => createPsdAgent(azDeps(azEnv, identity, fakePool())).tools.map(t => t.name);

describe("psd agent 跨栈 parity", () => {
  it("同等注入下，两个栈的工具名集合相等", () => {
    expect(new Set(azToolNames())).toEqual(new Set(cfToolNames()));
  });

  /**
   * 这条不是上一条的冗余，是刻意的。
   *
   * "两个集合相等"在**两边都退化成空表**时同样为真 —— 比如某天两侧的条件
   * 注入一起坏掉，或者 `createPsdAgent` 自己返回了空 `tools`。那正是这条
   * 守卫最该说话的时刻，而只比集合相等的话它会全绿。所以这里再钉两个具体
   * 的名字：`setText`（fontIndex 条件注册的那个，Azure 上缺席三周的那个）
   * 与 `editPixels`（editor 条件注册的那个）。
   */
  it("两个栈都含 setText 与 editPixels —— 集合相等但都是空，不算通过", () => {
    for (const [stack, names] of [["cloudflare", cfToolNames()], ["azure", azToolNames()]]) {
      expect(names, `${stack} 的工具表里应有 setText`).toContain("setText");
      expect(names, `${stack} 的工具表里应有 editPixels`).toContain("editPixels");
    }
  });
});
