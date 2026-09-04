/**
 * Azure 栈的本地密钥加载。
 *
 * 由来:Cloudflare 侧 runtime 自己会去读 `packages/cloudflare-psd/.dev.vars`,
 * Azure 侧却只把 `process.env` 原样铺给子进程(`spawnService` 的
 * `{ ...process.env }`),于是同一份 Operator 配置在两个栈上一个自动生效、
 * 一个必须先手动 `set -a; source`。忘一次的表现不是启动失败,而是栈起来了、
 * 聊天框一发消息才 500 "No API key set" —— 这就是它被写成测试的原因。
 *
 * 下面一律用临时文件,绝不读真实的 `.env.azure`:它的内容既不该被测试读到,
 * 更不该被打印。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AZURE_DEV_ENV_FILE, loadAzureDevEnv } from "../../../stacks/unidocs-azure/local/dev-env.mjs";

let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "unidocs-azure-dev-env-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeEnvFile(contents) {
  await writeFile(join(root, AZURE_DEV_ENV_FILE), contents, "utf8");
}

test("缺少 .env.azure 不是错误 —— 没配 Operator 的栈照样要能起来", () => {
  const env = {};
  const result = loadAzureDevEnv(root, env);

  expect(result.exists).toBe(false);
  expect(result.loaded).toEqual([]);
  expect(env).toEqual({});
});

test("文件里的键注入 env", async () => {
  await writeEnvFile("ANTHROPIC_API_KEY=k\nLLM_MODEL=m\n");
  const env = {};

  const result = loadAzureDevEnv(root, env);

  expect(result.exists).toBe(true);
  expect(env.ANTHROPIC_API_KEY).toBe("k");
  expect(env.LLM_MODEL).toBe("m");
});

test("shell 里已经有的值优先,文件不覆盖它", async () => {
  await writeEnvFile("LLM_MODEL=from-file\n");
  const env = { LLM_MODEL: "from-shell" };

  const result = loadAzureDevEnv(root, env);

  expect(env.LLM_MODEL).toBe("from-shell");
  // 没被采纳的键不该出现在 loaded 里 —— 调用方要拿它打印"这次加载了什么"。
  expect(result.loaded).not.toContain("LLM_MODEL");
});

test("`export KEY=value` 前缀被剥掉 —— 同一份文件既能 source 也能自动加载", async () => {
  await writeEnvFile("export LLM_MODEL=m\n");
  const env = {};

  loadAzureDevEnv(root, env);

  expect(env.LLM_MODEL).toBe("m");
  expect(env["export LLM_MODEL"]).toBeUndefined();
});

test("loaded 只报键名,值不出现在返回里 —— 它会被打进终端和 dev 日志", async () => {
  await writeEnvFile("ANTHROPIC_API_KEY=super-secret-value\n");

  const result = loadAzureDevEnv(root, {});

  expect(result.loaded).toEqual(["ANTHROPIC_API_KEY"]);
  expect(JSON.stringify(result)).not.toContain("super-secret-value");
});
