/**
 * FontRegistry 的 Cloudflare 实现 —— 薄适配层，把 list/put 映到现有字体 DO 的
 * GET/POST。
 *
 * DO 内部与它的 sqlite 表**刻意不动**：线上已有登记数据，而这次要解决的是
 * "Azure 没有实现"，不是"CF 的实现不好"。表的五个具名列与 FontEntry 一比一
 * 对上，所以这里不需要任何打包/拆包。
 */
import { FONTS_INTERNAL_PATH } from "./fonts-do.js";
import type { FontEntry, FontRegistry } from "@unidocs/doctype-server-common";

export function createDoFontRegistry(opts: {
  readonly namespace: DurableObjectNamespace;
  readonly objectName: string;
}): FontRegistry {
  const stub = () => opts.namespace.get(opts.namespace.idFromName(opts.objectName));
  return {
    async list() {
      const response = await stub().fetch(`http://psd-fonts${FONTS_INTERNAL_PATH}`, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Font index request failed ${response.status}: ${await response.text()}`);
      }
      const body = await response.json() as { fonts?: unknown };
      if (!Array.isArray(body.fonts)) throw new Error("Font index response has no fonts array");
      return body.fonts as FontEntry[];
    },
    async put(entry) {
      const response = await stub().fetch(`http://psd-fonts${FONTS_INTERNAL_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (!response.ok) {
        throw new Error(`Font registration failed ${response.status}: ${await response.text()}`);
      }
    },
  };
}
