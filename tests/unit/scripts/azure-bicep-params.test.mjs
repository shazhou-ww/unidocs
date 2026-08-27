/**
 * 穷尽性守卫:`deploy.mjs` 传给某个模板的每个参数,那个模板都必须声明。
 *
 * 对不上时的失败发生在 `az deployment group what-if`
 * (`unrecognized template parameter 'cpu'`)—— `az bicep build` 编译得过、
 * 单测也全绿,要等真的部署到那一步才报错,而那时镜像已经在 ACR 里构建完
 * (两分半),部署链路跑了大半。这条边界类型系统看不见:一头是 JS 模板字符串
 * 拼出的 `name=value`,另一头是 bicep 的 `param` 声明。
 *
 * 反向不检查(bicep 声明了但没人传):那是合法的,大量参数靠默认值生效。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEPLOY_DIR = join(ROOT, "stacks/azure/deploy");
const DEPLOY_SOURCE = readFileSync(join(DEPLOY_DIR, "deploy.mjs"), "utf8");

/** `param foo string` / `param foo int = 0` 的声明名。 */
function declaredParams(template) {
  const source = readFileSync(join(DEPLOY_DIR, template), "utf8");
  return new Set(
    [...source.matchAll(/^param\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map(m => m[1]),
  );
}

/**
 * 从 `deployX()` 函数体里取出它拼进 `--parameters` 的名字。
 *
 * 抓的是 `` `name=${...}` `` 这一种形式 —— 全部调用点都这么写,包括
 * `...(cond ? [`name=${v}`] : [])` 这种条件加入的。
 */
function passedParams(functionName) {
  const start = DEPLOY_SOURCE.indexOf(`function ${functionName}(`);
  expect(start, `deploy.mjs 里找不到 ${functionName}()`).toBeGreaterThan(-1);
  // 到下一个顶层 `\nfunction ` 或 `\nexport function ` 为止。
  const rest = DEPLOY_SOURCE.slice(start + 1);
  const nextIndex = rest.search(/\n(?:export )?(?:async )?function /);
  const body = nextIndex === -1 ? rest : rest.slice(0, nextIndex);
  return new Set(
    [...body.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)=\$\{/g)].map(m => m[1]),
  );
}

const TARGETS = [
  ["deployGateway", "gateway.bicep"],
  ["deployService", "service.bicep"],
  ["deployPlatform", "platform.bicep"],
];

describe("deploy.mjs 传的参数都被 bicep 声明", () => {
  test.each(TARGETS)("%s → %s", (fn, template) => {
    const passed = passedParams(fn);
    expect(passed.size, `${fn}() 里没抓到任何参数,正则可能失配了`).toBeGreaterThan(0);
    const declared = declaredParams(template);
    const undeclaredNames = [...passed].filter(name => !declared.has(name)).sort();
    expect(
      undeclaredNames,
      `${template} 没有声明:${undeclaredNames.join(", ")}`,
    ).toEqual([]);
  });
});
