/**
 * 防漂移：包依赖声明 vs 源码实际 import 的一致性校验。
 *
 * 背景（2026-08 依赖梳理轮）：`azure-markdown` 声明了 `@unidocs/core`、
 * `@unidocs/server-core` 却从不 import，`cloudflare-docx/markdown/psd`
 * 声明了 `@unidocs/server-core` 同样不用——这些都是靠人眼才发现的。
 * 四条规则把它变成 CI 里的硬约束：
 *
 * 1. src 里的 `@unidocs/*` import 必须声明在 `dependencies`（不能只放
 *    devDependencies，否则生产安装会漏）。
 * 2. 测试里的 `@unidocs/*` import 必须声明在 `dependencies` 或
 *    `devDependencies` 之一。
 * 3. 声明的每个 `@unidocs/*`（dep 或 devDep）必须在 src 或测试里真的被
 *    import 过——声明了不用的依赖只会让依赖图虚胖。
 * 4. composite 包的 tsconfig `references` 必须恰好覆盖 `dependencies`
 *    （允许额外引用 devDependencies，如 doctype-* 测试用的内存端口包）。
 *    缺失引用 = 依赖了却不声明，靠传递构建顺序侥幸通过；多余引用 =
 *    声明已删但 references 忘了同步。
 *
 * 另外校验包目录名与 package.json `name` 一致（改名时两个都要改）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PKGS_DIR = join(ROOT, "packages");

const IMPORT_RE =
  /(?:from\s*|import\s*\(\s*|require\(\s*)["'](@unidocs\/[^"']+)["']/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".wrangler") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** `@unidocs/server-core/port-contract` -> `@unidocs/server-core` */
function bareName(specifier) {
  return specifier.split("/").slice(0, 2).join("/");
}

function loadPackage(dirName) {
  const dir = join(PKGS_DIR, dirName);
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const declared = (field) =>
    new Set(
      Object.keys(json[field] ?? {}).filter((d) => d.startsWith("@unidocs/")),
    );
  const deps = declared("dependencies");
  const devDeps = declared("devDependencies");

  const srcImports = new Set();
  const testImports = new Set();
  for (const f of walk(dir)) {
    const rel = f.slice(dir.length + 1).replace(/\\/g, "/");
    const isTest = rel.startsWith("tests/") || /\.(test|spec)\./.test(rel);
    const content = readFileSync(f, "utf8");
    for (const m of content.matchAll(IMPORT_RE)) {
      (isTest ? testImports : srcImports).add(bareName(m[1]));
    }
  }

  const allImports = new Set([...srcImports, ...testImports]);
  return { dirName, name: json.name, deps, devDeps, srcImports, testImports, allImports };
}

function loadTsconfigRefs(dirName) {
  const tsconfigPath = join(PKGS_DIR, dirName, "tsconfig.json");
  let tsconfig;
  try {
    tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  } catch {
    return null; // 没有 tsconfig（理论上不该发生）
  }
  if (tsconfig.compilerOptions?.composite !== true) return null; // 非 composite 不参与 references 规则

  const refs = new Set();
  for (const ref of tsconfig.references ?? []) {
    const sub = ref.path.replace(/\.\.\//g, "");
    try {
      const refJson = JSON.parse(readFileSync(join(PKGS_DIR, sub, "package.json"), "utf8"));
      refs.add(refJson.name);
    } catch {
      refs.add(`<unresolved:${ref.path}>`);
    }
  }
  return refs;
}

const packages = readdirSync(PKGS_DIR)
  .filter((d) => statSync(join(PKGS_DIR, d)).isDirectory())
  .sort()
  .map(loadPackage);

describe("包依赖声明与源码 import 一致", () => {
  test.each(packages.map((p) => [p.name, p]))("%s: 目录名与包名一致", (_name, p) => {
    expect(p.name).toBe(`@unidocs/${p.dirName}`);
  });

  test.each(packages.map((p) => [p.name, p]))("%s: src 里的 @unidocs import 都在 dependencies 里", (_name, p) => {
    const missing = [...p.srcImports].filter((d) => !p.deps.has(d)).sort();
    expect(missing, `src import 未声明在 dependencies：${missing.join(", ")}`).toEqual([]);
  });

  test.each(packages.map((p) => [p.name, p]))("%s: 测试里的 @unidocs import 在 deps 或 devDeps 里", (_name, p) => {
    const known = new Set([...p.deps, ...p.devDeps]);
    const missing = [...p.testImports].filter((d) => !known.has(d)).sort();
    expect(missing, `测试 import 未声明：${missing.join(", ")}`).toEqual([]);
  });

  test.each(packages.map((p) => [p.name, p]))("%s: 声明的 @unidocs 依赖都被实际 import 过", (_name, p) => {
    const declared = new Set([...p.deps, ...p.devDeps]);
    const unused = [...declared].filter((d) => !p.allImports.has(d)).sort();
    expect(unused, `声明了但从未 import（src 或测试都没有）：${unused.join(", ")}`).toEqual([]);
  });

  test.each(packages.map((p) => [p.name, p]))("%s: tsconfig references 与 dependencies 一致", (_name, p) => {
    const refs = loadTsconfigRefs(p.dirName);
    if (refs === null) return; // 非 composite 包（如 web-psd）不适用

    const missingRef = [...p.deps].filter((d) => !refs.has(d)).sort();
    const known = new Set([...p.deps, ...p.devDeps]);
    const staleRef = [...refs].filter((d) => !known.has(d)).sort();
    expect(missingRef, `声明了 dependencies 但 tsconfig 没引用：${missingRef.join(", ")}`).toEqual([]);
    expect(staleRef, `tsconfig 引用了但未声明（dep 或 devDep 都没有）：${staleRef.join(", ")}`).toEqual([]);
  });
});
