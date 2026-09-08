import type { FontEntry } from "@unidocs/doctype-server-common";

export interface BuiltinFontRecord {
  readonly entry: FontEntry;
  /** `fonts/` 下的文件名，不含目录。字节怎么从包里拿出来由平台适配器决定。 */
  readonly file: string;
}
