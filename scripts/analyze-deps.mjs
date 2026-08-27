// One-off dependency analysis: declared vs actual cross-package dependencies.
// Usage: node scripts/analyze-deps.mjs
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const packageRoots = ["packages", "unicas-packages"];

function readJson(p) {
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

const pkgs = new Map(); // name -> { dir, json }
for (const packageRoot of packageRoots) {
  const packagesDir = join(root, packageRoot);
  const pkgDirs = readdirSync(packagesDir)
    .filter((dir) => statSync(join(packagesDir, dir)).isDirectory())
    .sort();
  for (const dir of pkgDirs) {
    const packageDir = join(packagesDir, dir);
    const json = readJson(join(packageDir, "package.json"));
    if (json) pkgs.set(json.name, { dir: packageDir, json });
  }
}

// Walk all source-ish files, skipping node_modules / dist / .wrangler / build output
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist" || entry === ".wrangler" || entry === ".turbo") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const importRe =
  /(?:from\s*|import\s*\(\s*|require\(\s*)["'](@(?:unidocs|unicas)\/[^"']+)["']/g;

// pkgName -> Set<imported pkg name>
const actual = new Map();
// pkgName -> Map<imported pkg -> [files]>
const actualFiles = new Map();

for (const [name, { dir }] of pkgs) {
  const files = walk(dir);
  const found = new Set();
  const byTarget = new Map();
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    const rel = relative(root, f).split(sep).join("/");
    for (const m of content.matchAll(importRe)) {
      const target = m[1];
      // strip subpath, e.g. @unidocs/svalue-codec/internal -> @unidocs/svalue-codec
      const bare = target.split("/").slice(0, 2).join("/");
      found.add(bare);
      if (!byTarget.has(bare)) byTarget.set(bare, new Set());
      byTarget.get(bare).add(rel);
    }
  }
  actual.set(name, found);
  actualFiles.set(name, byTarget);
}

console.log("=== Declared vs actual cross-package dependencies ===\n");
for (const [name, { json }] of [...pkgs].sort()) {
  const isWorkspacePackage = (dependency) => dependency.startsWith("@unidocs/") || dependency.startsWith("@unicas/");
  const declaredDeps = new Set(Object.keys(json.dependencies ?? {}).filter(isWorkspacePackage));
  const declaredDev = new Set(Object.keys(json.devDependencies ?? {}).filter(isWorkspacePackage));
  const actualSet = actual.get(name) ?? new Set();
  const declaredAll = new Set([...declaredDeps, ...declaredDev]);

  const missing = [...actualSet].filter((d) => !declaredAll.has(d)).sort(); // imported but not declared
  const unusedDeps = [...declaredDeps].filter((d) => !actualSet.has(d)).sort(); // declared dep, never imported
  const unusedDev = [...declaredDev].filter((d) => !actualSet.has(d)).sort(); // declared devDep, never imported
  const devButUsedInProd = [...declaredDev].filter((d) => declaredDeps.has(d)); // n/a
  void devButUsedInProd;

  console.log(`## ${name}`);
  console.log(`  declared deps:     ${[...declaredDeps].sort().join(", ") || "—"}`);
  console.log(`  declared devDeps:  ${[...declaredDev].sort().join(", ") || "—"}`);
  console.log(`  actual imports:    ${[...actualSet].sort().join(", ") || "—"}`);
  if (missing.length) console.log(`  ⚠ IMPORTED BUT NOT DECLARED: ${missing.join(", ")}`);
  if (unusedDeps.length) console.log(`  ◌ declared dep, never imported in src: ${unusedDeps.join(", ")}`);
  if (unusedDev.length) console.log(`  ◌ declared devDep, never imported in src: ${unusedDev.join(", ")}`);
  console.log("");
}

console.log("=== Import detail (pkg -> files importing each workspace target) ===\n");
for (const [name, byTarget] of [...actualFiles].sort()) {
  const lines = [];
  for (const [target, files] of [...byTarget].sort()) {
    lines.push(`    ${target}: ${[...files].join(", ")}`);
  }
  if (lines.length) {
    console.log(`## ${name}`);
    console.log(lines.join("\n"));
    console.log("");
  }
}
