/**
 * `createPsdAgent` 的依赖接线 —— Cloudflare 侧。
 *
 * **单独一个模块、单独导出，是为了能测。** 这段原先内联在 `createOperatorDO`
 * 的 agent 工厂里，而那个工厂只有在一次带凭据的真实 `/run` 里才会被调到 ——
 * 也就是说把 `PSD_FONT_FALLBACKS` 换成 `[]`（回退链当场死掉）整套单测照样
 * 全绿。评审用注入法证实了这一点。拆出来之后接线本身可以直接断言。
 *
 * 它先从工厂里拆到了 `worker.ts`，现在从 `worker.ts` 再拆到这里：`worker.ts`
 * 顶层有 `createEditorDO` / `createOperatorDO` / `export default` 这些副作用，
 * 任何想要 import 这段接线的人（比如 `tests/unit/psd-agent-parity.test.mjs`
 * 那条跨栈 parity 断言）都得连带把它们一起执行。Azure 侧的对称文件
 * `azure-psd/src/agent-deps.ts` 同理 —— 那边的 `main.ts` 更狠，顶层直接
 * `runDocTypeService(...)`，import 一下就把服务跑起来了。这个模块只导出纯
 * 函数，import 不产生任何副作用 —— 那条 parity 断言直接按相对路径指向它。
 */
import { createQwenImageEditor, type PsdAgentDeps } from "@unidocs/doctype-psd";
import type { AgentIdentity } from "@unidocs/cloudflare-sdk";
import { consoleObserver } from "@unidocs/protocol-doc";
import { createFontIndexSource, parseFontFallbacks } from "./fonts-source.js";

/**
 * 接线只读这几个绑定/变量。收窄成一个显式的形状（而不是吃 `worker.ts` 那个
 * 大而全的 `Env`）与 Azure 侧的 `PsdAgentEnv` 对称，也让测试能直接构造。
 * `worker.ts` 的 `Env` extends 它，所以两边不会漂移。
 */
export interface PsdAgentEnv {
  /** 字体索引 DO 名字的作用域之一（另一半是租户）。 */
  readonly CAS_STACK_ID: string;
  /**
   * 租户级字体索引。可选**只是为了容错**：绑定漏配时 setText 从工具表里消失，
   * 而不是每次调用都在 `namespace.get` 上炸。正常部署两处都该配上
   * （wrangler.toml 与本地 doc-types.mjs）。
   */
  readonly PSD_FONTS?: DurableObjectNamespace;
  /**
   * setText 的回退链，逗号分隔、顺序即优先级（如 "NotoSans,NotoSansSC"）。
   * 缺省是空链，不硬编码字体名 —— 解析器住在 `@unidocs/doctype-psd`
   * （text/font-index.ts 的 `parseFontFallbacks`），两个平台共用一份。
   */
  readonly PSD_FONT_FALLBACKS?: string;
  /**
   * 图像编辑模型（editPixels）。缺省时 agent 的工具表里没有 editPixels，
   * 层内像素编辑不可用，其余功能不受影响。
   */
  readonly IMAGE_EDIT_API_KEY?: string;
  readonly IMAGE_EDIT_MODEL?: string;
  readonly IMAGE_EDIT_BASE_URL?: string;
}

/**
 * 从 env + 身份拼出 `createPsdAgent` 的依赖。
 *
 * 两个条件注入的判据都是"这个能力的后端在不在"：
 *
 * - **editor**：editPixels 需要一个带 API key 的图像模型，key 只在 env 里
 *   拿得到。没配 key 就不注入 —— 工具表里也就没有 editPixels，模型不会去调
 *   一个注定失败的工具。
 * - **fontIndex**：同一套判据（setText）。索引在租户级 DO 里，没有 `PSD_FONTS`
 *   绑定就一个字形都取不到。绑定缺失只可能是漏配，此时宁可工具表里没有
 *   setText，也好过注册一个每次调用都在 `namespace.get` 上炸的工具。
 *   tenantId 从身份来 —— 索引是租户级的。
 *
 * `doctype-psd/src/agent.ts` 记着"工具表与提示词必须一起条件化"的由来：只条件化
 * 其中一个会得到一个"提示词里有、工具表里没有"的幽灵工具，那是线上真实发生过
 * 的故障。副作用是**平台能力差异表现为一次礼貌的拒绝，而不是一个错误** ——
 * 所以两个栈的工具表一致与否，靠 `tests/unit/psd-agent-parity.test.mjs` 盯着。
 */
export function psdAgentDeps(env: PsdAgentEnv, identity: AgentIdentity): PsdAgentDeps {
  return {
    ...(env.IMAGE_EDIT_API_KEY
      ? {
        editor: createQwenImageEditor({
          apiKey: env.IMAGE_EDIT_API_KEY,
          // 系统里唯一的第三方调用。不接观测的话，它出问题时只留下一个
          // 不透明的 500 —— 排查只能靠猜。
          observe: consoleObserver,
          ...(env.IMAGE_EDIT_MODEL ? { model: env.IMAGE_EDIT_MODEL } : {}),
          ...(env.IMAGE_EDIT_BASE_URL ? { baseUrl: env.IMAGE_EDIT_BASE_URL } : {}),
        }),
      }
      : {}),
    ...(env.PSD_FONTS
      ? {
        fontIndex: createFontIndexSource({
          namespace: env.PSD_FONTS,
          stackId: env.CAS_STACK_ID,
          tenantId: identity.tenantId,
          fallbacks: parseFontFallbacks(env.PSD_FONT_FALLBACKS),
        }),
      }
      : {}),
  };
}
