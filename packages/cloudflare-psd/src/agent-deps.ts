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
 *
 * 这里也是原 `fonts-source.ts` 的去处：`createFontIndexSource` 曾经把
 * "打哪个 DO、字节怎么取、缓存多久"糊在一起，那些现在全部收进了中立层的
 * `createFontRegistry` 门面与两个 provider，剩下的只是构造参数 —— 一个只剩
 * 构造参数的模块不值得单独存在。
 */
import { createQwenImageEditor, parseFontFallbacks, type PsdAgentDeps } from "@unidocs/doctype-psd";
import { createFontRegistry, logFontProviderError } from "@unidocs/doctype-server-common";
import { BUILTIN_FALLBACKS, createBuiltinFontProvider } from "@unidocs/fonts-builtin";
import type { AgentIdentity } from "@unidocs/cloudflare-sdk";
import { consoleObserver } from "@unidocs/protocol-doc";
import { builtinFontLoader } from "./builtin-fonts.js";
import { createDoFontProvider } from "./font-provider-do.js";
import { fontsObjectName } from "./fonts-do.js";

/**
 * 接线只读这几个绑定/变量。收窄成一个显式的形状（而不是吃 `worker.ts` 那个
 * 大而全的 `Env`）与 Azure 侧的 `PsdAgentEnv` 对称，也让测试能直接构造。
 * `worker.ts` 的 `Env` extends 它，所以两边不会漂移。
 */
export interface PsdAgentEnv {
  /** 字体索引 DO 名字的作用域之一（另一半是租户）。 */
  readonly CAS_STACK_ID: string;
  /**
   * 租户级字体索引。可选**只是为了容错**：绑定漏配时少了租户那一档，其余照常
   * ——而不是每次调用都在 `namespace.get` 上炸。正常部署两处都该配上
   * （wrangler.toml 与本地 doc-types.mjs）；漏了就登记不了、也读不到租户字体。
   */
  readonly PSD_FONTS?: DurableObjectNamespace;
  /**
   * setText 的回退链，逗号分隔、顺序即优先级（如 "NotoSans,NotoSansSC"）。
   * **未设**时取内置字体那两套的名字；**显式设成空串**是空链，作为逃生口。
   * 解析器住在 `@unidocs/doctype-psd`，默认值住在 `@unidocs/fonts-builtin`
   * （从生成的索引里取，不硬编码字符串），两个平台共用同一份。
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
 * **只剩 editor 一个条件注入**，判据是"这个能力的后端在不在"：editPixels 需要一个
 * 带 API key 的图像模型，key 只在 env 里拿得到。没配 key 就不注入 —— 工具表里也就
 * 没有 editPixels，模型不会去调一个注定失败的工具。
 *
 * `fontIndex` **不再条件化**，两个平台一致。以前它的判据是 `PSD_FONTS` 这条可能漏配
 * 的 DO 绑定，漏配的表现是 setText 整个从工具表里消失。内置字体随包走之后，"有没有
 * 字体可用"永远为真，条件化只会凭空造出一条 setText 静默消失的路。
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
    fontIndex: {
      registry: createFontRegistry({
        // 顺序即优先级：租户登记的同名字体盖掉内置的。这就是"用户主动装
        // external 字体"的扩展点 —— 想要全量 NotoSansSC（含港台字形与扩展区），
        // 用 scripts/seed-psd-fonts.mjs 装上去即可，不需要任何开关。
        providers: [
          createBuiltinFontProvider({ load: builtinFontLoader }),
          // 绑定漏配时只是少了租户那一档 —— 内置那档仍在，setText 照常可用。
          // 以前这里漏配会让 setText 整个从工具表里消失。
          ...(env.PSD_FONTS
            ? [createDoFontProvider({
              namespace: env.PSD_FONTS,
              objectName: fontsObjectName({
                stackId: env.CAS_STACK_ID,
                tenantId: identity.tenantId,
              }),
            })]
            : []),
        ],
        // 没有它就是 fail-hard：字体 DO 打不通，`index()` 整个拒绝，setText 连
        // 内置字体都排不出来。配上它才兑现"租户 provider 不可达只影响租户那一层"
        // 这条设计承诺。**降级必须往某处喊** —— 静默吞掉一档的表现是"我装的字体
        // 凭空消失、字换了个字形"，没有任何一步失败，日志、测试、告警全看不见，
        // 与 setText 在 Azure 上缺席三周同一种病。理由与落地形状见
        // `logFontProviderError` 的注释；**降级之后那份"只有内置字体"的索引会被
        // 当成成功结果缓存满 60 秒、而日志只喊一次**，这条排查陷阱记在
        // `doctype-psd/src/agent.ts` 的 `fontIndex` 契约注释里。
        onProviderError: logFontProviderError,
      }),
      fallbacks: parseFontFallbacks(env.PSD_FONT_FALLBACKS, BUILTIN_FALLBACKS),
    },
  };
}

/**
 * `PSD_FONT_FALLBACKS` 的解析器。实现住在 `@unidocs/doctype-psd`
 * （`text/font-fallbacks.ts`）—— 两个平台读的是同一个环境变量、要的是同一套
 * 语义，各写一份迟早分叉。这里保留一个再导出，是因为它和上面的接线总是一起用；
 * 原先它挂在 `fonts-source.ts` 上，那个模块随本次接线一起删掉了。
 */
export { parseFontFallbacks } from "@unidocs/doctype-psd";
