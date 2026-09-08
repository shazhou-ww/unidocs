/**
 * `PSD_FONT_FALLBACKS` 的默认值。
 *
 * 住在这里而不是两个栈的配置文件里：两个平台读的是同一个环境变量、要的是同一套
 * 语义，各写一份迟早分叉。名字从生成的索引里取，**不硬编码字符串** —— 硬编码一个
 * 索引里没有的名字，回退链只会静默失效（`resolveFaceChain` 对没装载的候选是直接
 * 跳过，不报错）。
 *
 * 顺序即优先级：拉丁在前、中文在后 —— 前者不覆盖 CJK，汉字自然落到后者。
 */
import { BUILTIN_FONTS } from "./fonts.generated.js";

export const BUILTIN_FALLBACKS: readonly string[] =
  Object.freeze(BUILTIN_FONTS.map(record => record.entry.postScriptName));
