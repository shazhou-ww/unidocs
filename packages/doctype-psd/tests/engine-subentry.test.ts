import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../src/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../src");

/** Static import graph reachable from a src entry (relative imports only). */
function importClosure(entryRel: string): Set<string> {
  const seen = new Set<string>();
  const walk = (rel: string) => {
    const abs = path.resolve(SRC, rel).replace(/\.js$/, ".ts");
    if (seen.has(abs)) return;
    seen.add(abs);
    const code = readFileSync(abs, "utf8");
    for (const m of code.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
      const dep = path.relative(SRC, path.resolve(path.dirname(abs), m[1]));
      walk(dep);
    }
    for (const m of code.matchAll(/from\s+"(ag-psd)"/g)) seen.add("PKG:" + m[1]);
  };
  walk(entryRel);
  return seen;
}

describe("engine subentry", () => {
  it("exports the browser-safe surface", () => {
    for (const name of ["render", "renderRegion", "applyOne", "deserialize", "resolvePixels", "PixelCache"]) {
      expect(typeof (engine as any)[name]).toBe("function");
    }
  });

  it("does NOT pull ag-psd or the parse/export path into its import graph", () => {
    const closure = importClosure("engine.ts");
    const abs = (rel: string) => path.resolve(SRC, rel);
    expect(closure.has("PKG:ag-psd")).toBe(false);
    expect(closure.has(abs("psd/load.ts"))).toBe(false);
    expect(closure.has(abs("psd/save.ts"))).toBe(false);
    expect(closure.has(abs("psd/canvas-shim.ts"))).toBe(false);
    expect(closure.has(abs("doctype.ts"))).toBe(false);
  });
});
