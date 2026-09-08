/**
 * CF 侧加载器的两条不变式。
 *
 * 这个包在此之前对生产 CF 路径**零测试覆盖**，而这条路径上最容易出的两类错都
 * 是「本地栈复现不了」的：
 *
 * 1. **类型分歧。** wrangler 的 `[[rules]] type = "Data"` 给的是 `ArrayBuffer`，
 *    本地栈 esbuild 的 `binary` loader 给的是 `Uint8Array`。不归一的话，
 *    `BuiltinFontLoader` 契约上返回 `Uint8Array`、生产上实际是 `ArrayBuffer`。
 * 2. **漏 import。** 将来加第三套字体、`fonts.generated.ts` 里有而
 *    `builtin-fonts.ts` 忘了加 import —— 现状下要到运行时才抛，而设计要的是
 *    构建期/CI 就红。
 *
 * 注意这里**不**比对字节内容：vitest 走 vite 的 asset 解析，`BYTES` 的值不是
 * 真实字节。真实字节的内联由 esbuild/wrangler 保证（见 task-7 报告里的
 * dry-run 与最小入口 bundle 验证），字节正确性由
 * `azure-psd/tests/builtin-fonts.test.ts` 的 sha256 比对守住 —— 两边读的是
 * `packages/fonts-builtin/fonts/` 下的同一份文件。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_FONTS } from "@unidocs/fonts-builtin";
import { BYTES, toBytes } from "../src/builtin-fonts.js";

describe("toBytes", () => {
  it("ArrayBuffer 归一成 Uint8Array（wrangler 的 Data 模块走这条）", () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const out = toBytes(buf);
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it("Uint8Array 原样通过（本地栈 esbuild 的 binary loader 走这条）", () => {
    const src = new Uint8Array([4, 5, 6]);
    const out = toBytes(src);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).toBe(src);
    expect([...out]).toEqual([4, 5, 6]);
  });
});

describe("BYTES", () => {
  it("键与 BUILTIN_FONTS 的文件名一一对应 —— 加了字体却忘了加 import 会在这里红", () => {
    expect(Object.keys(BYTES).sort()).toEqual(BUILTIN_FONTS.map(r => r.file).sort());
  });
});
