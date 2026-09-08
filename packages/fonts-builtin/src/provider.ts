/**
 * 内置字体的 `FontProvider` 实现。
 *
 * 它是只读的：`blobFor` 恒为 null，因为字节随包走、不在 CAS 里，没有可回收的对象。
 * 这直接决定了排出来的字**不进 `doc.fonts`** —— 走那条路会撞上 state.ts 的
 * `"PSD font SBlob … was not stored during externalization"`。
 *
 * 字节怎么从包里拿出来由 `load` 决定，这是本包**唯一**必须分平台的东西：
 * Node 用 fs 读，Cloudflare 用 bundler 把字节内联进 worker。
 */
import type { FontEntry, FontIo, FontProvider } from "@unidocs/doctype-server-common";
import type { SBlob } from "@unidocs/protocol";
import { BUILTIN_FONTS } from "./fonts.generated.js";

/** 按 `fonts/` 下的文件名取字节。 */
export type BuiltinFontLoader = (fileName: string) => Promise<Uint8Array>;

export function createBuiltinFontProvider(options: { readonly load: BuiltinFontLoader }): FontProvider {
  const fileOf = new Map(BUILTIN_FONTS.map(r => [r.entry.postScriptName, r.file]));
  return {
    id: "builtin",
    list: async () => BUILTIN_FONTS.map(r => r.entry),
    read: async (entry: FontEntry, _io: FontIo): Promise<Uint8Array> => {
      const file = fileOf.get(entry.postScriptName);
      if (file === undefined) {
        // 门面按 source 分发，正常路径到不了这里。静默返回空字节会表现成
        // "这套字体解析失败"，查起来毫无线索。
        throw new Error(`${entry.postScriptName} is not a builtin font`);
      }
      return await options.load(file);
    },
    blobFor: (): SBlob | null => null,
  };
}
