/**
 * 部署守卫:网关镜像里必须真的带着 UI。
 *
 * `build-web-assets.mjs` 在 web-psd 没构建时会写一个空 map 而不是失败 ——
 * 那是为了让 `pnpm --filter @unidocs/azure-gateway build` 单独可跑。代价是
 * 空 map 也能一路构建、部署、启动成功,只是访问网关根路径返回 404,而 404
 * 看起来像路由配错,不像"UI 根本没打进去"。
 *
 * 这个测试跑真实构建后断言产物非空,把那个静默失败变成红灯。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GENERATED = join(ROOT, "packages/azure-gateway/src/web-assets.generated.ts");
const DECLARATION = join(ROOT, "packages/azure-gateway/src/web-assets.generated.d.ts");

/** 只在构建产物存在时断言内容;裸 checkout 上跳过而不是失败。 */
const built = existsSync(GENERATED)
  && !readFileSync(GENERATED, "utf8").includes("Stub:");

describe("网关内联的 web-psd 资源", () => {
  test.runIf(built)("构建后资源 map 非空", () => {
    const source = readFileSync(GENERATED, "utf8");
    const paths = [...source.matchAll(/^\s+"(\/[^"]*)":/gm)].map(m => m[1]);
    expect(paths.length).toBeGreaterThan(0);
  });

  test.runIf(built)("包含 SPA 入口与至少一个哈希资源", () => {
    const source = readFileSync(GENERATED, "utf8");
    const paths = [...source.matchAll(/^\s+"(\/[^"]*)":/gm)].map(m => m[1]);
    // index.html 是回退目标,没有它整个 UI 路由失效。
    expect(paths).toContain("/index.html");
    expect(paths.some(p => p.startsWith("/assets/"))).toBe(true);
  });

  test.runIf(built)("没有把私钥之类的东西一起打进去", () => {
    const source = readFileSync(GENERATED, "utf8");
    expect(source).not.toContain("BEGIN PRIVATE KEY");
  });

  test("声明生成模块导出的 WEB_ASSETS", () => {
    // 裸 checkout 没有生成内容时，typecheck 依靠这个稳定声明解析具名导出。
    expect(readFileSync(DECLARATION, "utf8")).toContain("export declare const WEB_ASSETS");
  });
});
