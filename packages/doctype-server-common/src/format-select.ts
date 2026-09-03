import type { DocumentFormat } from "@unidocs/protocol";

/** 调用方能提供的线索。三个都可选:导出路径通常只有 `name`,导入路径通常
 *  只有 `mediaType` + `filename`。 */
export interface FormatHint {
  readonly name?: string;
  readonly mediaType?: string;
  readonly filename?: string;
}

/** 选中的格式**连同它的名字**。名字是必需的:导入路径要把它传给
 *  `Session.create({ format })`,光有对象传不过去。 */
export interface SelectedFormat<TDoc> {
  readonly name: string;
  readonly format: DocumentFormat<TDoc>;
}

/**
 * 按线索挑一个导入/导出格式。
 *
 * 这份实现是从 `cloudflare-sdk/src/editor-do-svalue.ts` 搬过来的——那边跑了
 * 很久,Azure 那条却一直写死 `defaultFormat`,两条运行时对同一个上传给出不同
 * 判断。搬到这里两边共用,**语义一个字节不改**,只把入参改成 hint 对象、返回
 * 值补上格式名(两条运行时的调用点需要的东西不一样)。
 *
 * 控制流是一条**落空链**,不是三条并列规则:
 *   1. mediaType 唯一命中就直接用它。
 *   2. 否则看扩展名:唯一命中就直接用它——**哪怕上一步 mediaType 命中了不止
 *      一个**,扩展名的唯一裁决优先于 mediaType 的歧义。
 *   3. 只有两次唯一命中都落空,才检查是不是任一维度命中了多个,是则抛
 *      `Ambiguous document format`。
 *   4. 都没命中,回落 `defaultFormat`。
 *
 * 原函数的 mediaType/filename 是必填 string,调用方没有时传的是 `""`;
 * `""` 匹配不到任何 mediaType,也 endsWith 不了任何扩展名,等价于空命中。
 * 这里用 `undefined` 表达"没提供",落到同一个空数组上,行为一致。
 *
 * **全不命中是回落,不是抛错。** 认不出来的输入按 `defaultFormat` 处理,保持
 * 今天的行为:一个不带文件名、或者带着奇怪文件名的 PSD 上传必须继续能用。
 * 真正不是 PSD 的字节会在 `load()` 里报错,那才是正确的报错位置。
 */
export function selectFormat<TDoc>(
  config: {
    readonly formats: Readonly<Record<string, DocumentFormat<TDoc>>>;
    readonly defaultFormat: string;
  },
  hint: FormatHint,
): SelectedFormat<TDoc> {
  if (hint.name) {
    const explicit = config.formats[hint.name];
    if (!explicit) throw new Error(`Unknown format: ${hint.name}`);
    return { name: hint.name, format: explicit };
  }

  const entries = Object.entries(config.formats);

  const lowerMedia = hint.mediaType?.toLowerCase();
  const byMediaType = lowerMedia === undefined ? [] : entries.filter(([, format]) =>
    format.mediaTypes.some(candidate => candidate.toLowerCase() === lowerMedia));
  if (byMediaType.length === 1) return { name: byMediaType[0]![0], format: byMediaType[0]![1] };

  const lowerName = hint.filename?.toLowerCase();
  const byExtension = lowerName === undefined ? [] : entries.filter(([, format]) =>
    format.extensions.some(extension => lowerName.endsWith(extension.toLowerCase())));
  if (byExtension.length === 1) return { name: byExtension[0]![0], format: byExtension[0]![1] };

  // 歧义判断刻意放在两次唯一命中之后——这是落空链不是并列规则,
  // 扩展名能唯一裁决时不该因为 mediaType 撞了就报错。照抄现有行为。
  if (byMediaType.length > 1 || byExtension.length > 1) {
    throw new Error("Ambiguous document format");
  }

  const fallback = config.formats[config.defaultFormat];
  if (!fallback) throw new Error(`Default format ${config.defaultFormat} is not configured`);
  return { name: config.defaultFormat, format: fallback };
}
