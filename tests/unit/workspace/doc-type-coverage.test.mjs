/**
 * 穷尽性守卫:doc type 表里的每个成员，都必须有它全部的配套物。
 *
 * 为什么需要这条:一个 doc type 的"存在"分散在多个地方——包入口、服务声明、
 * tsconfig 引用、冒烟 flow。表是唯一事实来源(stacks/azure/doc-types.mjs)，
 * 但表增长不会自动带出这些配套物，而缺失时的表现往往是**静默的**:Task 4
 * 的审查里就抓到过一次——smoke.mjs 的 `--only psd` 通过合法性校验、两个硬编码
 * 分发分支都不命中、`failures` 保持 0，于是一次零检查的冒烟打印
 * "all smoke assertions passed" 并 exit 0。
 *
 * 这条测试把那类静默变成红色，而且是在**部署之前**变红。
 *
 * 它刻意只查"配套物在不在"，不查"行为对不对"。后者是契约行为参数化的事
 * (behavior-suite 目前写死 markdown)，属于另一轮。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { readAzureDocTypes } from "../../../stacks/azure/doc-types.mjs";
import { DOC_TYPES } from "../../../stacks/cloudflare/local/doc-types.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const azureDocTypes = Object.keys(readAzureDocTypes(ROOT));
const cfDocTypes = Object.keys(DOC_TYPES);

describe("Azure doc type 的配套物", () => {
  test.each(azureDocTypes)("%s 有 packages/azure-<name>/src/main.ts 入口", (docType) => {
    expect(existsSync(join(ROOT, `packages/azure-${docType}/src/main.ts`))).toBe(true);
  });

  test.each(azureDocTypes)("%s 有 scripts/bundle.mjs（镜像构建依赖它）", (docType) => {
    expect(existsSync(join(ROOT, `packages/azure-${docType}/scripts/bundle.mjs`))).toBe(true);
  });

  // 漏了 reference，`pnpm typecheck` 不会把这个包纳入 composite 构建，
  // 类型错误要到真正 build 镜像时才暴露。
  test.each(azureDocTypes)("%s 在根 tsconfig.json 的 references 里", (docType) => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
    const paths = tsconfig.references.map((r) => r.path);
    expect(paths).toContain(`packages/azure-${docType}`);
  });

  // 这一条守的正是 Task 4 抓到的那个静默假阳性:表里有、smoke.mjs 里没有
  // 对应 flow，全量冒烟会安静地跳过它。
  test.each(azureDocTypes)("%s 在 smoke.mjs 里有对应的 flow", (docType) => {
    const smoke = readFileSync(join(ROOT, "stacks/azure/deploy/smoke.mjs"), "utf8");
    expect(smoke).toMatch(new RegExp(`function\\s+${docType}\\w*Flow\\s*\\(`));
  });
});

describe("Cloudflare doc type 的配套物", () => {
  test.each(cfDocTypes)("%s 有 packages/cloudflare-<name>/src/worker.ts 入口", (docType) => {
    expect(existsSync(join(ROOT, `packages/cloudflare-${docType}/src/worker.ts`))).toBe(true);
  });

  test.each(cfDocTypes)("%s 有 wrangler.toml（部署配置）", (docType) => {
    expect(existsSync(join(ROOT, `packages/cloudflare-${docType}/wrangler.toml`))).toBe(true);
  });
});

// 两朵云支持的集合可以不同（Azure 落后是允许的，psd 就是这种情况），但这个
// 差集必须是**有意识的**。这条测试把它打印出来，让"Azure 少一个 doc type"
// 成为一件看得见的事，而不是某次改动里悄悄发生的。
test("两朵云的 doc type 差集被显式记录", () => {
  const onlyCf = cfDocTypes.filter((t) => !azureDocTypes.includes(t)).sort();
  const onlyAzure = azureDocTypes.filter((t) => !cfDocTypes.includes(t)).sort();
  // Azure 侧不应该有 Cloudflare 没有的 doc type——doctype-* 包是云中立的，
  // Cloudflare 一侧总是先有。
  expect(onlyAzure).toEqual([]);
  // 这个断言会在 Task 5 加进 azure-psd 之后自动变成 []。它变红的那一刻，
  // 就是有人加了 Cloudflare doc type 却没同步 Azure 的那一刻。
  expect(onlyCf).toEqual([]);
});
