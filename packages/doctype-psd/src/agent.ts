/**
 * PSD DocumentAgent 工厂。
 *
 * 从常量改成工厂，是因为 editPixels 需要一个 ImageEditor —— 一个带
 * API key、会打网络的东西。它按 env 构造，和 operator 里的 provider 同形。
 *
 * 不给 editor 就没有 editPixels：一个连手都没有的 agent 不该在工具表里
 * 宣称自己能画。
 */
import type { DocumentAgent } from "@unidocs/doctype-server-common/agent";
import { editPixelsInstructions, instructions, setTextInstructions, textRoutingInstructions, tools } from "./tools.js";
import { createEditPixelsTool } from "./image/edit-pixels.js";
import type { ImageEditor } from "./image/editor.js";
import { createSetTextTool, type FontIndexSource } from "./text/set-text.js";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

export interface PsdAgentDeps {
  /** 缺省时工具表里没有 editPixels。 */
  readonly editor?: ImageEditor;
  /**
   * 缺省时工具表里没有 setText。
   *
   * **但两个平台的接线都无条件注入它，不要照着 editor 把它也条件化。**
   * 内置字体随包发行（`@unidocs/fonts-builtin`），"有没有字体可用"永远为真，
   * 判据没了。以前 Cloudflare 那边的判据是 `PSD_FONTS` 这条**可能漏配**的
   * DO 绑定，漏配的表现是 setText 整个从工具表里消失 —— 平台能力差异变成
   * 模型的一次礼貌的拒绝，没有任何一步失败，日志、测试、告警全都看不见。
   * 那正是 setText 在 Azure 上缺席三周没被发现的一半原因。今天绑定缺失只是
   * 少了租户那一档，内置那一档仍在。两个栈的工具表相等由
   * `tests/unit/psd-agent-parity.test.mjs` 在**最小 env** 下盯着。
   *
   * 保留 `?` 只是为了让不需要文字能力的调用方（含大量只构造 `{}` 的单测）
   * 能不传，不是给接线用的开关。
   *
   * **fail-soft 的固有代价，排查时容易误判**：接线给
   * `createFontRegistry` 传了 `onProviderError`，于是某个来源打不通时那一档
   * 被跳过、其余照常合成。但"跳过"对门面而言是一次**成功**的合成 ——
   * `compose()` 不再 reject，那份"只有内置字体"的索引会被当成正常结果缓存
   * 满 60 秒（`font-registry.ts` 里"失败不入缓存"靠的是 `index.catch`，
   * 这条路走不到）。所以一次瞬时抖动会让租户字体隐身整整一个 TTL，而降级
   * 日志**只喊一次**：看到一条 `font_provider_error` 不等于"只失败了一次"。
   *
   * **这个 60 秒窗口两个栈不一样，排查时别照搬。** CF 的 operator DO 把
   * `AgentSession`（连同这份 registry）缓存在实例上（`cloudflare-sdk` 的
   * `operator-do-agent.ts` 里的 `#agentSession`），所以窗口跨请求，DO 不被回收
   * 就一直有效；Azure 每个 `/run` 都重新 `deps.agent(identity)`（`azure-sdk` 的
   * `local-operator.ts`，调用点就在 `/run` 处理器里），registry 跟着新建，那
   * 60 秒最多覆盖**本次 run 内**的多次 setText，跨请求形同虚设。
   */
  readonly fontIndex?: FontIndexSource;
}

export function createPsdAgent(deps: PsdAgentDeps): DocumentAgent<PsdQuery, PsdOp> {
  // 工具表和提示词必须一起条件化。只条件化其中一个，就会得到一个
  // "提示词里有、工具表里没有"的幽灵工具 —— 模型会去找它，找不到，然后
  // 向用户道歉。这是线上真实发生过的一次故障。所以每个条件工具的注册与
  // 它的说明块都写在**同一个 if 里**，不许拆开。
  const enabled = [...tools];
  let prompt = instructions;
  if (deps.editor) {
    enabled.push(createEditPixelsTool(deps.editor));
    prompt += editPixelsInstructions;
  }
  if (deps.fontIndex) {
    enabled.push(createSetTextTool(deps.fontIndex));
    prompt += setTextInstructions;
  }
  // 分流规则点名了两个工具，所以它的条件就是两个工具都在场 —— 同一条
  // "工具表与提示词一起条件化"的规矩，只是这一块的前提是两个 if 的交集。
  // 少了任何一个就没有可分的流，基础提示词里那条不点名工具的规则接管。
  if (deps.editor && deps.fontIndex) prompt += textRoutingInstructions;
  return { tools: enabled, instructions: prompt };
}
