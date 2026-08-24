/**
 * 防漂移:凡是被 esbuild 留在 bundle 外面的 npm 包,都必须出现在使用
 * 该 bundle 的服务包的 `dependencies` 里,否则产物在生产安装(只装本包
 * 声明的生产依赖)时会 `ERR_MODULE_NOT_FOUND`。
 *
 * 这不是假设性风险:`azure-docx` 曾经正是这样漏了 `pg` 与
 * `@azure/storage-blob` —— monorepo 里靠根 node_modules 提升掩盖了,
 * 只有真正做镜像时才会暴露。
 *
 * 第二条断言同样重要:所有 azure 打包脚本必须用同一种外部化策略。
 * 两派并存正是上面那个 bug 的根因。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EXTERNAL_NPM_PACKAGES } from "../../../scripts/workspace-aliases.mjs";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const SERVICE_PACKAGES = ["azure-gateway", "azure-markdown", "azure-docx"];

const BUNDLERS = [
  "packages/azure-gateway/scripts/bundle.mjs",
  "packages/azure-markdown/scripts/bundle.mjs",
  "packages/azure-docx/scripts/bundle.mjs",
  "packages/azure-sdk/scripts/bundle-migrate-cli.mjs",
];

describe("bundle 外部化与依赖声明", () => {
  test.each(SERVICE_PACKAGES)("%s 声明了全部外部化的 npm 包", (pkg) => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"),
    );
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const external of EXTERNAL_NPM_PACKAGES) {
      expect(declared).toContain(external);
    }
  });

  // azure-sdk 自己也是迁移镜像的来源,同样要声明。
  test("azure-sdk 声明了全部外部化的 npm 包", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/azure-sdk/package.json"), "utf8"),
    );
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const external of EXTERNAL_NPM_PACKAGES) {
      expect(declared).toContain(external);
    }
  });

  test.each(BUNDLERS)("%s 用显式外部化列表,不用 packages: \"external\"", (rel) => {
    const source = readFileSync(join(REPO_ROOT, rel), "utf8");
    // 去掉块注释,避免命中文档里对该写法的讨论
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("external: EXTERNAL_NPM_PACKAGES");
    expect(code).not.toContain('packages: "external"');
  });
});
