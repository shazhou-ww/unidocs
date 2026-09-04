/**
 * FontRegistry 的共享契约测试。两个平台的适配器都跑同一份 —— 这是"两边行为
 * 一致"唯一能被机器验证的地方,与 testing/port-contract.ts 同一个思路。
 */
import { describe, expect, it } from "vitest";
import type { FontEntry, FontRegistry } from "../font-registry.js";

const noto: FontEntry = {
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: "a".repeat(64),
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
};
const josefin: FontEntry = {
  postScriptName: "JosefinSans-Bold",
  family: "Josefin Sans",
  hash: "b".repeat(64),
  unitsPerEm: 2048,
  coverage: [[0x20, 0x7e]],
};

export function runFontRegistryContract(
  label: string,
  make: () => Promise<FontRegistry>,
): void {
  describe(label, () => {
    it("空登记表返回空数组,不是抛错", async () => {
      expect(await (await make()).list()).toEqual([]);
    });

    it("登记后能读回,字段逐一对上", async () => {
      const registry = await make();
      await registry.put(noto);
      expect(await registry.list()).toEqual([noto]);
    });

    it("同名登记两次只剩一条,且是后一条 —— 预置脚本每次跑都会全量登记一遍", async () => {
      const registry = await make();
      await registry.put(noto);
      await registry.put({ ...noto, hash: "c".repeat(64), family: "Noto Sans 2" });
      const rows = await registry.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.hash).toBe("c".repeat(64));
      expect(rows[0]?.family).toBe("Noto Sans 2");
    });

    it("多条按 postScriptName 升序返回 —— 顺序稳定,回退链的选择才可复现", async () => {
      const registry = await make();
      await registry.put(noto);
      await registry.put(josefin);
      expect((await registry.list()).map(e => e.postScriptName))
        .toEqual(["JosefinSans-Bold", "NotoSans-Regular"]);
    });

    it("coverage 原样往返,不被 JSON 序列化改形状", async () => {
      const registry = await make();
      const wide: FontEntry = { ...noto, coverage: [[0x20, 0x7e], [0x4e00, 0x9fff]] };
      await registry.put(wide);
      expect((await registry.list())[0]?.coverage).toEqual([[0x20, 0x7e], [0x4e00, 0x9fff]]);
    });
  });
}
