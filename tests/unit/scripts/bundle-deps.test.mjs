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
 *
 * `SERVICE_PACKAGES`/`BUNDLERS` 曾经是手写的三元素数组,`azure-psd` 加进来
 * 之后出现次数为 0 —— 这条外部依赖声明校验对新 doc type 完全失效,是
 * `tests/unit/workspace/doc-type-coverage.test.mjs` 那类穷尽性缝隙的同类:
 * 表(`readAzureDocTypes()`)增长了,消费方不知道。两个列表现在从那张表
 * 展开(网关不是 doc type,单独并进去,与 `deploy.mjs` 的 `azureImages()`
 * 同一个思路),新增一个 `packages/azure-<name>/` 就自动被本文件覆盖,不用
 * 再手改这里。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EXTERNAL_NPM_PACKAGES } from "../../../scripts/workspace-aliases.mjs";
import { readAzureDocTypes } from "../../../stacks/azure/doc-types.mjs";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const AZURE_DOC_TYPES = Object.keys(readAzureDocTypes(REPO_ROOT));

const SERVICE_PACKAGES = ["azure-gateway", ...AZURE_DOC_TYPES.map((docType) => `azure-${docType}`)];

const BUNDLERS = [
  "packages/azure-gateway/scripts/bundle.mjs",
  ...AZURE_DOC_TYPES.map((docType) => `packages/azure-${docType}/scripts/bundle.mjs`),
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

  // 守卫自身的守卫:这条列表必须真的展开出了 doc type 包,而不是意外空表——
  // 空 SERVICE_PACKAGES/BUNDLERS 会让上面所有 test.each 生成零个测试,
  // 静默地"全绿"而实际什么都没检查。
  test("SERVICE_PACKAGES 与 BUNDLERS 覆盖了当前的每个 azure doc type 包", () => {
    for (const docType of AZURE_DOC_TYPES) {
      expect(SERVICE_PACKAGES).toContain(`azure-${docType}`);
      expect(BUNDLERS).toContain(`packages/azure-${docType}/scripts/bundle.mjs`);
    }
    expect(AZURE_DOC_TYPES.length).toBeGreaterThan(0);
  });
});
