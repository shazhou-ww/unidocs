/**
 * `createPsdAgent` 的依赖接线 —— Azure 侧。
 *
 * **单独一个模块、单独导出，是为了能测。** CF 那边把同一段从 worker 里拆出来
 * 的理由记在对称文件 `cloudflare-psd/src/agent-deps.ts` 里：内联时
 * 它只在一次带凭据的真实 `/run` 里才被调到，于是"把 `PSD_FONT_FALLBACKS` 换成
 * `[]`（回退链当场死掉）整套单测照样全绿"。Azure 侧原来内联在 `main.ts` 里，
 * 而这个包连 tests 目录都没有 —— 同一课在这边没学到，那正是 setText 在 Azure
 * 上缺席三周没被发现的一半原因。
 *
 * 与 CF 的两处刻意差异：
 *
 * 1. **fontIndex 无条件注入,两个平台一致。** 以前 CF 那边它是条件的,判据是
 *    `PSD_FONTS` 这条可能漏配的 DO 绑定。内置字体随包走之后,"有没有字体可用"
 *    永远为真,条件化只会凭空造出一条 setText 静默消失的路。
 * 2. **必须每个租户一个实例。** `createFontRegistry` 自带的 60 秒缓存是**每实例**
 *    的，而字体索引是租户级的。这个函数因此收 `identity` 并在每次调用时新建
 *    ——绝不能把返回值缓存到任何跨租户的作用域里。Azure 的
 *    `LocalNamespace.get()` 完全忽略传入的 name（CF 的 DO 名字含 tenantId，
 *    情况不同），在那一层做缓存必然是跨租户的，会静默串数据、不报错。
 *    实际调用点是 `local-operator.ts` 里每请求一次的 `deps.agent(identity)`。
 *
 * 字节永不经过 `FontRegistry`（裁定 R29）：登记表只存元数据，字体文件在 CAS，
 * 由跑在编辑会话里的 setText effect 自己带着会话身份去读 —— 门面把这一步收进了
 * provider 的 `read(entry, io)`，`io` 就是那个 effect 的上下文。内置那一档不走
 * 这条路：字节随包走，由 `builtinFontLoader` 从磁盘读。
 */
import { PgFontProvider, type Queryable } from "@unidocs/azure-sdk";
import type { SessionIdentity } from "@unidocs/doctype-server-common";
import { createFontRegistry, logFontProviderError } from "@unidocs/doctype-server-common";
import { createQwenImageEditor, parseFontFallbacks, type PsdAgentDeps } from "@unidocs/doctype-psd";
import { BUILTIN_FALLBACKS, createBuiltinFontProvider } from "@unidocs/fonts-builtin";
import { consoleObserver } from "@unidocs/protocol-doc";
import { builtinFontLoader } from "./builtin-fonts.js";

/**
 * 接线只读这几个环境变量。收窄成一个显式的形状（而不是直接吃
 * `NodeJS.ProcessEnv`）纯粹是为了测试里能构造：`ProcessEnv` 的索引签名让
 * `{ CAS_STACK_ID: "s" }` 这样的字面量也合法，两者兼容。
 */
export interface PsdAgentEnv {
  /** 字体登记表的作用域之一（另一半是租户）。缺省时下面会响亮失败。 */
  readonly CAS_STACK_ID?: string | undefined;
  /**
   * setText 的回退链，逗号分隔、顺序即优先级（如 "NotoSans,NotoSansSC"）。
   * **未设**时取内置字体那两套的名字；**显式设成空串**是空链，作为逃生口。
   */
  readonly PSD_FONT_FALLBACKS?: string | undefined;
  /** 缺省时工具表里没有 editPixels —— 没有手的 agent 不该宣称自己能画。 */
  readonly IMAGE_EDIT_API_KEY?: string | undefined;
  readonly IMAGE_EDIT_MODEL?: string | undefined;
  readonly IMAGE_EDIT_BASE_URL?: string | undefined;
}

export function psdAgentDeps(
  env: PsdAgentEnv,
  identity: SessionIdentity,
  pool: Queryable,
): PsdAgentDeps {
  return {
    // 与 Cloudflare 的条件化同形（cloudflare-psd/src/agent-deps.ts 的
    // psdAgentDeps）：没有 key 就不注入 editor，于是工具表里没有 editPixels、
    // 提示词里也没有。doctype-psd/src/agent.ts 记着这条的由来 —— 只条件化其中
    // 一个会得到一个"提示词里有、工具表里没有"的幽灵工具，那是线上真实发生过
    // 的故障。
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
          new PgFontProvider(pool, {
            stackId: requireStackId(env.CAS_STACK_ID),
            tenantId: identity.tenantId,
          }),
        ],
        // 没有它就是 fail-hard：Postgres 抖一下，`index()` 整个拒绝，setText 连
        // 内置字体都排不出来。配上它才兑现"租户 provider 不可达只影响租户那一层"
        // 这条设计承诺。**降级必须往某处喊** —— 静默吞掉一档的表现是"我装的字体
        // 凭空消失、字换了个字形"，没有任何一步失败，日志、测试、告警全看不见，
        // 与 setText 在 Azure 上缺席三周同一种病。理由与落地形状见
        // `logFontProviderError` 的注释。
        onProviderError: logFontProviderError,
      }),
      fallbacks: parseFontFallbacks(env.PSD_FONT_FALLBACKS, BUILTIN_FALLBACKS),
    },
  };
}

/**
 * 缺了就抛，不静默用空串。空 stackId 会让 `PgFontProvider.list()` 每次都返回
 * 零条 —— 于是租户登记的字体一套都找不到，表现成"字体全都没登记"而不是一条
 * 配置错误。（内置那一档不受影响，所以这条错配今天更难被看见，更值得响亮。）
 */
function requireStackId(stackId: string | undefined): string {
  if (stackId === undefined || stackId.length === 0) {
    throw new Error("CAS_STACK_ID is required to scope the tenant font registry");
  }
  return stackId;
}
