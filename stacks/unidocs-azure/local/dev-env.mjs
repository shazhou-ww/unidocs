/**
 * `pnpm dev unidocs-azure` 的本地密钥加载。
 *
 * 为什么需要这个模块:Cloudflare 侧的 runtime 会自己去读
 * `packages/cloudflare-psd/.dev.vars`(`DOC_TYPES[name].devVars` +
 * `readDevVars`),把 Operator 的 LLM 配置注入 worker binding;Azure 侧没有
 * binding 这层概念,`spawnService` 只是把 `process.env` 原样铺给每个 doc
 * service,所以同一份配置在这边**只能**先进到 shell 里。
 *
 * 差别本身不致命,致命的是它的失败形态:忘了 source,栈照常起来、健康检查
 * 照常绿,只有聊天框第一次发消息才 500 "No API key set"。把加载放进启动
 * 路径,是让两个栈在这件事上重新对齐 —— 各读各的本地文件,谁都不靠人记性。
 *
 * `node:util` 的 `parseEnv` 就是 `--env-file` / `process.loadEnvFile()` 用的
 * 那个解析器,所以这里不自己写 KEY=VALUE 解析:`export FOO=bar` 这种既能被
 * `set -a; source .env.azure` 读、也能被这里读,同一份文件两条路等价。
 * 不直接用 `process.loadEnvFile()` 的原因有两个 —— 它只能写 `process.env`
 * (于是不可测),而且不告诉调用方到底加载了哪些键(于是打不出那行"这次读到
 * 了什么"的日志,而这行日志正是本轮故障缺的东西)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** 仓库根下的文件名。`.gitignore` 的 `.env.*` 覆盖它,永不入库。 */
export const AZURE_DEV_ENV_FILE = ".env.azure";

/**
 * 把 `<repoRoot>/.env.azure` 读进 `env`,返回 `{ path, exists, loaded }`。
 *
 * - 文件不存在不是错误:没配 Operator 的栈也要能起来(CI、只跑 gateway 的
 *   场景),那时 `exists: false`、`loaded: []`。
 * - **已经在 `env` 里的键一律不覆盖**,shell 优先。这让
 *   `LLM_MODEL=xxx pnpm dev unidocs-azure` 这种一次性覆盖仍然成立,也和
 *   Node 自己 `--env-file` 的优先级一致。
 * - `loaded` 只有键名,没有值:调用方会把它打进终端和 `.dev-*.log`,
 *   而这些值是 API key。
 */
export function loadAzureDevEnv(repoRoot, env = process.env) {
  const path = join(repoRoot, AZURE_DEV_ENV_FILE);

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { path, exists: false, loaded: [] };
    throw err;
  }

  const loaded = [];
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
  }
  return { path, exists: true, loaded };
}
