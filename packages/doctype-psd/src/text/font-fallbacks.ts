/**
 * 回退链配置：`PSD_FONT_FALLBACKS="NotoSans-Regular,NotoSansSC-Regular"`，
 * 逗号分隔，顺序即优先级。
 *
 * **未设**（`undefined`）时取 `fallback` 参数给的默认值 —— 内置字体那两套的名字。
 * **显式设成空串**时是空链，作为逃生口。这两者今天返回值相同（都是 `[]`），改动之后
 * 必须可区分：以前"缺省空、不硬编码字体名"的理由是「硬编码一个 CAS 里可能不存在的
 * 名字，回退链只会静默失效」，而内置之后名字与字节同源、不可能不存在，那个理由消失了。
 *
 * 住在这里而不是某个平台包里，是因为两个平台读的是同一个环境变量、要的是同一套语义。
 */
export function parseFontFallbacks(
  value: string | undefined,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined) return fallback;
  return value.split(",").map(name => name.trim()).filter(name => name.length > 0);
}
