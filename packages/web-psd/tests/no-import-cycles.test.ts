import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * No module in `src/` may import its way back to itself.
 *
 * Circular ES modules do resolve, so a cycle compiles, typechecks and passes
 * every other test — then breaks in the browser only: Vite's hot update can
 * leave a binding inside the cycle `undefined`, and the page keeps running in
 * that half-initialised state until a full reload. The symptom is a feature
 * that is demonstrably present in the served source and simply does not
 * respond, which is a miserable thing to debug from the outside.
 *
 * That happened once already: `ui/controller.ts` imported `ui/zoom-controller.ts`
 * for the open-a-document zoom while zoom-controller imported controller back
 * for `getController`. Both were one import away from not needing each other.
 */
const SRC = resolve(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Resolves a relative specifier the way the TS/ESM setup here writes them:
 *  `./x.js` on disk is `./x.ts` or `./x.tsx`. */
function resolveSpecifier(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const deps: string[] = [];
    for (const m of readFileSync(file, "utf8").matchAll(/^\s*import[^"']*["'](\.[^"']+)["']/gm)) {
      const target = resolveSpecifier(file, m[1]);
      if (target) deps.push(target);
    }
    graph.set(file, deps);
  }
  return graph;
}

function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const walk = (node: string): string[] | null => {
    if (state.get(node) === "open") return [...stack.slice(stack.indexOf(node)), node];
    if (state.get(node) === "done") return null;
    state.set(node, "open");
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      const found = walk(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of graph.keys()) {
    const found = walk(node);
    if (found) return found;
  }
  return null;
}

describe("module graph", () => {
  it("has no import cycles in src/", () => {
    const cycle = findCycle(importGraph());
    expect(cycle?.map((p) => relative(SRC, p)).join(" -> ") ?? null).toBeNull();
  });
});
