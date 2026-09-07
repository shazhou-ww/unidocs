/**
 * FontRegistry 的共享契约测试。两个平台的适配器都跑同一份 —— 这是"两边行为
 * 一致"唯一能被机器验证的地方,与 testing/port-contract.ts 同一个思路。
 *
 * **前提,`make` 必须满足**:每次调用返回的实例互不共享底层作用域/存储 ——
 * 即两次 `make()` 拿到的 registry 各自独立,一个的 `put` 不能被另一个的
 * `list` 看见。下面"两次 make() 互不可见"那条用例就是专门检这一条前提的,
 * 见其注释里的理由。
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
    /**
     * 显式检测"`make()` 复用了同一个作用域/存储"这个失效模式,不依赖执行
     * 顺序或字体命名的巧合。
     *
     * 没有这一条时,一个复用了同一作用域的适配器能不能被抓到,纯看运气:
     * Task 6 审查时实测过,把 PgFontRegistry 契约测试的 `tenantId` 改成
     * 恒定值后,5 条用例里 4 条照样绿,唯一变红的"coverage 原样往返"也只是
     * 因为它读的 `list()[0]` 恰好被前一条用例("多条按 postScriptName 升序
     * 返回"留下的 `JosefinSans-Bold`,字母序 J < N)占掉了 —— 换一批用例
     * 顺序或换一套字体命名,同样的复用错误就会 5 条全绿,完全测不出来。
     * 这条用例直接对着"两次 make() 是否共享存储"发问,结果不依赖其它用例
     * 写了什么、按什么顺序跑。
     */
    it("两次 make() 互不可见 —— 适配器不能复用同一个作用域/存储", async () => {
      const a = await make();
      const b = await make();
      await a.put(noto);
      expect(await b.list()).not.toContainEqual(noto);
    });

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
