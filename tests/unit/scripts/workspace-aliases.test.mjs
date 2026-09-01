/**
 * 防漂移：esbuild 的 workspace alias 表必须覆盖 src 里真实出现的每一个
 * workspace import specifier —— **包括带子路径的那些**。
 *
 * 背景（2026-08 agent SDK 那一轮）：`@unidocs/doctype-server-common` 新开了
 * 一个 `./agent` 子路径导出，`packages/cloudflare-psd/src/worker.ts` 和
 * `packages/cloudflare-sdk/src/operator-do-agent.ts` 都 import 了它，但
 * `scripts/workspace-aliases.mjs` 的表没跟着加。
 *
 * 全仓库测试和 typecheck 全绿 —— 因为 vitest 和 tsc 都走 package.json 的
 * `exports` 解析。只有 esbuild 用这张表，而它的 alias 是**前缀匹配**：
 * 基础包 `@unidocs/doctype-server-common` 指向 `src/index.ts`（一个文件），
 * 于是 `@unidocs/doctype-server-common/agent` 被重写成
 * `src/index.ts/agent` —— `Cannot read directory ... not a directory`。
 *
 * 这个失效模式只在真的跑 `pnpm dev <stack>` 时才炸，而那正是最贵的发现时机。
 * 这个测试把它提前到 CI。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveWorkspaceAliases } from "../../../scripts/workspace-aliases.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PKG_DIRS = [join(ROOT, "packages"), join(ROOT, "unicas-packages")];

/**
 * 只认真正的 import/require 形式，不认裸字符串 —— `@unicas/admin-webui/ui`
 * 在 `unicas-packages/admin-webui/src/ui/index.ts` 里是个字符串常量，
 * 不是 import，不该被算进来。
 */
const IMPORT_RE =
  /(?:from\s*|import\s*\(\s*|require\(\s*)["'](@(?:unidocs|unicas)\/[^"']+)["']/g;

function walkSrc(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSrc(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

const aliases = resolveWorkspaceAliases(ROOT);

/** src 里出现过的每一个 workspace specifier（含子路径），去重后带上出处。 */
const specifiers = new Map();
for (const pkgRoot of PKG_DIRS) {
  for (const pkgDir of readdirSync(pkgRoot)) {
    for (const file of walkSrc(join(pkgRoot, pkgDir, "src"))) {
      const content = readFileSync(file, "utf8");
      for (const m of content.matchAll(IMPORT_RE)) {
        if (!specifiers.has(m[1])) {
          specifiers.set(m[1], file.slice(ROOT.length + 1));
        }
      }
    }
  }
}

/**
 * 只有「基础包已经在表里」的子路径才危险。
 *
 * 表里没有的包（`@unicas/tenant-protocol-legacy` 等）走 esbuild 自己的 node 解析、
 * 读 package.json 的 `exports`，子路径正常工作 —— 那条路不经过前缀重写。
 * 而基础包一旦登记，它指向的是一个 **.ts 文件**，esbuild 的 alias 又是
 * 前缀匹配，于是 `<base>/<subpath>` 被重写成 `<file>.ts/<subpath>`。
 * 所以规则是：**登记了基础包，就必须把它在 src 里用到的每个子路径也登记。**
 */
const subpathsNeedingAlias = [...specifiers]
  .filter(([spec]) => spec.split("/").length > 2)
  .filter(([spec]) => Object.hasOwn(aliases, spec.split("/").slice(0, 2).join("/")));

/**
 * src 里 import 的每个**基础包**本身也必须在表里。
 *
 * 上面那条子路径规则原本假设「表里没有的包走 esbuild 自己的 node 解析、读
 * package.json 的 `exports`，正常工作」。那个假设是错的，`pnpm dev psd`
 * 炸在这上面：仓库里每个 workspace 包的 `exports` 都是
 * `development -> src/index.ts` / `import -> dist/index.js`，而
 * `stacks/unidocs-cloudflare/local/runtime.mjs` 的 esbuild 只传
 * `conditions: ["workerd", "worker", "browser"]` —— 没有 `development`。
 * 于是未登记的包一律落到 `dist/index.js`：
 *
 *   - `@unicas/admin-protocol` 从没 build 过，dist 不存在 → Could not resolve；
 *   - `@unicas/control-plane` 的 dist 是 4c873f6 改名之前编的，里面还写着
 *     早已不存在的 `@unicas/protocol-admin` → 同样 Could not resolve。
 *
 * 两者都不是源码问题，源码是对的 —— 是「没登记就会去读构建产物」这条隐式
 * 回退路径的问题。登记到 src 之后既修好了当下，也让这类陈旧 dist 再不可能
 * 被悄悄读进 bundle。
 */
const basePackages = [...specifiers].map(([spec, where]) => [
  spec.split("/").slice(0, 2).join("/"),
  where,
]);

describe("esbuild 的 workspace alias 表", () => {
  test("扫到了 import（防止 walk 静默扫空）", () => {
    expect(specifiers.size).toBeGreaterThan(5);
  });

  test("扫到了带子路径的 import（防止过滤条件写空后静默通过）", () => {
    expect(subpathsNeedingAlias.length).toBeGreaterThan(0);
  });

  test.each(subpathsNeedingAlias)(
    "%s 在 alias 表里（基础包已登记，子路径就必须登记）",
    (spec, where) => {
      const base = spec.split("/").slice(0, 2).join("/");
      expect(
        Object.keys(aliases),
        `${where} import 了 ${spec}。基础包 ${base} 已在`
        + " scripts/workspace-aliases.mjs 里并指向一个 .ts 文件，而 esbuild 的"
        + ` alias 是前缀匹配 —— 未登记的 ${spec} 会被重写成 <file>.ts/<subpath>，`
        + " bundle 时报 \"Cannot read directory ... not a directory\"。"
        + " 加一条指向该子路径真实入口文件的映射。",
      ).toContain(spec);
    },
  );

  test.each(basePackages)(
    "%s 在 alias 表里（未登记就会回退去读 dist 构建产物）",
    (base, where) => {
      expect(
        Object.keys(aliases),
        `${where} import 了 ${base}，但它不在 scripts/workspace-aliases.mjs 里。`
        + " esbuild 只传 workerd/worker/browser 条件，命不中 `development`，"
        + " 于是这个包会解析到 dist/index.js —— 要么根本没 build 过，要么是"
        + " 改名前的陈旧产物。两种都在 bundle 期报 Could not resolve。"
        + " 加一条指向它 src/index.ts 的映射。",
      ).toContain(base);
    },
  );

  test.each(Object.entries(aliases))("%s 指向的文件真实存在", (_spec, target) => {
    expect(existsSync(target), `alias 目标不存在：${target}`).toBe(true);
  });
});
