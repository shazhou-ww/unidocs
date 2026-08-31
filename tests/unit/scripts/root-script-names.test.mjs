import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const rootScripts = () =>
  Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {});

/**
 * pnpm 内置命令中,被同名根脚本顶掉会真正弄坏东西的那些。
 *
 * pnpm 11 的规则:工作区**根目录**的脚本优先于同名内置命令,而且内置命令
 * 连从子目录都跑不了(ERR_PNPM_SCRIPT_OVERRIDE_IN_WORKSPACE_ROOT),没有
 * 任何开关可以绕开。pnpm 10 的优先级是反的,所以这类重名在 10 上无害、
 * 升到 11 才发作 —— `deploy` 就是这么进来的:2026-08-27 加了根脚本,注释
 * 里还写着"内置命令会赢",三天后第一次构建 Azure 镜像才炸。
 *
 * `test` / `start` 不在此列:pnpm 对它们的定义本来就是"运行同名脚本"。
 */
const RESERVED = [
  "deploy", "pack", "publish", "install", "add", "remove", "exec", "dlx",
  "store", "link", "patch", "prune", "import", "rebuild", "update", "fetch",
];

describe("root package.json script names", () => {
  it("does not shadow a pnpm built-in the repo depends on", () => {
    expect(rootScripts().filter((name) => RESERVED.includes(name))).toEqual([]);
  });

  // stacks/unidocs-azure/deploy/Dockerfile 用内置的 `pnpm deploy` 把单个
  // 工作区包裁剪进 /out。栈的部署入口因此必须叫别的名字。
  it("keeps the stack deploy entry off the reserved name", () => {
    const scripts = rootScripts();
    expect(scripts).toContain("stack:deploy");
    expect(scripts).not.toContain("deploy");
  });
});
