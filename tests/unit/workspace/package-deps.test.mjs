/**
 * 防漂移：包依赖声明 vs 源码实际 import 的一致性校验。
 *
 * 背景（2026-08 依赖梳理轮）：`azure-markdown` 声明了 `@unidocs/core`、
 * `@unidocs/doctype-server-common` 却从不 import，`cloudflare-docx/markdown/psd`
 * 声明了 `@unidocs/doctype-server-common` 同样不用——这些都是靠人眼才发现的。
 * 四条规则把它变成 CI 里的硬约束：
 *
 * 1. src 里的 `@unidocs/*`/`@unicas/*` import 必须声明在 `dependencies`
 *    （不能只放 devDependencies，否则生产安装会漏）。
 * 2. 测试里的 workspace import 必须声明在 `dependencies` 或
 *    `devDependencies` 之一。
 * 3. 声明的每个 workspace 依赖（dep 或 devDep）必须在 src 或测试里真的被
 *    import 过——声明了不用的依赖只会让依赖图虚胖。
 * 4. composite 包的 tsconfig `references` 必须恰好覆盖 `dependencies`
 *    （允许额外引用 devDependencies，如 doctype-* 测试用的内存端口包）。
 *    缺失引用 = 依赖了却不声明，靠传递构建顺序侥幸通过；多余引用 =
 *    声明已删但 references 忘了同步。
 *
 * 另外校验包目录名与 package.json `name` 一致（改名时两个都要改）。
 * 2026-08-26 起同时覆盖两个包目录：`packages/`（应用栈，`@unidocs/*`）与
 * `unicas-packages/`（独立部署的 CAS 中间件，`@unicas/*`）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
/** 每个包目录 + 它对应的 org 前缀。 */
const PKG_DIRS = [
  { dir: join(ROOT, "packages"), org: "@unidocs/" },
  { dir: join(ROOT, "unicas-packages"), org: "@unicas/" },
];

const IMPORT_RE =
  /(?:from\s*|import\s*\(\s*|require\(\s*)["'](@(?:unidocs|unicas)\/[^"']+)["']/g;

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

/** `@unidocs/doctype-server-common/memory-ports` -> `@unidocs/doctype-server-common` */
function bareName(specifier) {
  return specifier.split("/").slice(0, 2).join("/");
}

function loadPackage(pkgRoot, dirName) {
  const dir = join(pkgRoot.dir, dirName);
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const declared = (field) =>
    new Set(
      Object.keys(json[field] ?? {}).filter((d) => d.startsWith("@unidocs/") || d.startsWith("@unicas/")),
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
  return { pkgRoot, dirName, name: json.name, deps, devDeps, srcImports, testImports, allImports };
}

function loadTsconfigRefs(p) {
  const tsconfigPath = join(p.pkgRoot.dir, p.dirName, "tsconfig.json");
  let tsconfig;
  try {
    tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  } catch {
    return null; // 没有 tsconfig（理论上不该发生）
  }
  if (tsconfig.compilerOptions?.composite !== true) return null; // 非 composite 不参与 references 规则

  const refs = new Set();
  for (const ref of tsconfig.references ?? []) {
    try {
      // references 是相对 tsconfig 位置的路径；跨目录树（unicas-packages ↔ packages）
      // 时必须用 resolve 而不是剥掉 ../ 前缀。
      const refJson = JSON.parse(readFileSync(join(resolve(p.pkgRoot.dir, p.dirName, ref.path), "package.json"), "utf8"));
      refs.add(refJson.name);
    } catch {
      refs.add(`<unresolved:${ref.path}>`);
    }
  }
  return refs;
}

const packages = PKG_DIRS.flatMap((pkgRoot) =>
  readdirSync(pkgRoot.dir)
    .filter((d) => statSync(join(pkgRoot.dir, d)).isDirectory()
      && existsSync(join(pkgRoot.dir, d, "package.json")))
    .sort()
    .map((dirName) => loadPackage(pkgRoot, dirName)),
);

describe("包依赖声明与源码 import 一致", () => {
  test.each(packages.map((p) => [p.name, p]))("%s: 目录名与包名一致", (_name, p) => {
    expect(p.name).toBe(`${p.pkgRoot.org}${p.dirName}`);
  });

  test.each(packages.map((p) => [p.name, p]))("%s: src 里的 workspace import 都在 dependencies 里", (_name, p) => {
    const missing = [...p.srcImports].filter((d) => !p.deps.has(d)).sort();
    expect(missing, `src import 未声明在 dependencies：${missing.join(", ")}`).toEqual([]);
  });

  test.each(packages.map((p) => [p.name, p]))("%s: 测试里的 workspace import 在 deps 或 devDeps 里", (_name, p) => {
    const known = new Set([...p.deps, ...p.devDeps]);
    const missing = [...p.testImports].filter((d) => !known.has(d)).sort();
    expect(missing, `测试 import 未声明：${missing.join(", ")}`).toEqual([]);
  });

  test.each(packages.map((p) => [p.name, p]))("%s: 声明的 workspace 依赖都被实际 import 过", (_name, p) => {
    const declared = new Set([...p.deps, ...p.devDeps]);
    const unused = [...declared].filter((d) => !p.allImports.has(d)).sort();
    expect(unused, `声明了但从未 import（src 或测试都没有）：${unused.join(", ")}`).toEqual([]);
  });

  test.each(packages.map((p) => [p.name, p]))("%s: tsconfig references 与 dependencies 一致", (_name, p) => {
    const refs = loadTsconfigRefs(p);
    if (refs === null) return; // 非 composite 包（如 web-psd）不适用

    const missingRef = [...p.deps].filter((d) => !refs.has(d)).sort();
    const known = new Set([...p.deps, ...p.devDeps]);
    const staleRef = [...refs].filter((d) => !known.has(d)).sort();
    expect(missingRef, `声明了 dependencies 但 tsconfig 没引用：${missingRef.join(", ")}`).toEqual([]);
    expect(staleRef, `tsconfig 引用了但未声明（dep 或 devDep 都没有）：${staleRef.join(", ")}`).toEqual([]);
  });

  const PLATFORM_SDKS = new Set(["@unidocs/cloudflare-sdk", "@unidocs/azure-sdk"]);

  test.each(packages.filter(p => PLATFORM_SDKS.has(p.name)).map(p => [p.name, p]))(
    "%s: 平台 sdk 不依赖任何文档类型", (_name, p) => {
      const bad = [...p.deps].filter(d =>
        d.startsWith("@unidocs/doctype-") && d !== "@unidocs/doctype-server-common").sort();
      expect(bad, `平台 sdk 依赖了文档类型：${bad.join(", ")}`).toEqual([]);
    },
  );

  test.each(packages.filter(p => p.name.startsWith("@unidocs/doctype-")
    && p.name !== "@unidocs/doctype-server-common").map(p => [p.name, p]))(
    "%s: 文档类型不依赖任何平台 sdk", (_name, p) => {
      const bad = [...p.deps, ...p.devDeps].filter(d => PLATFORM_SDKS.has(d)).sort();
      expect(bad, `文档类型依赖了平台 sdk：${bad.join(", ")}`).toEqual([]);
    },
  );

  test.each(packages.filter(p => p.name.startsWith("@unidocs/doctype-")
    && p.name !== "@unidocs/doctype-server-common").map(p => [p.name, p]))(
    "%s: 对 doctype-server-common 的 src import 全是 import type", (_name, p) => {
      const dir = join(p.pkgRoot.dir, p.dirName);
      const offenders = [];
      for (const f of walk(dir)) {
        const rel = f.slice(dir.length + 1).replace(/\\/g, "/");
        if (rel.startsWith("tests/") || /\.(test|spec)\./.test(rel)) continue;
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.includes("@unidocs/doctype-server-common")) continue;
          if (!/^\s*import\s+type\b/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
        }
      }
      expect(offenders, `必须是 import type，否则服务端代码会进浏览器产物：\n${offenders.join("\n")}`).toEqual([]);
    },
  );
});
