import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CONTROL_PLANE_MCP_PATH } from "../src/config.js";

describe("control-plane MCP package boundary", () => {
  test("is private and exposes only the canonical MCP path", () => {
    const pkg = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
      "utf8",
    )) as { private?: boolean; dependencies?: Record<string, string> };

    expect(pkg.private).toBe(true);
    expect(CONTROL_PLANE_MCP_PATH).toBe("/mcp");
    expect(pkg.dependencies).toHaveProperty("@unicas/service", "workspace:*");
    expect(pkg.dependencies).not.toHaveProperty("@unicas/control-plane");
    expect(pkg.dependencies).not.toHaveProperty("@unicas/tenant-protocol");

    const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const file of ["auth.ts", "config.ts", "server.ts", "worker.ts"]) {
      expect(readFileSync(join(sourceDir, file), "utf8"), file).not.toContain(".prepare(");
    }
  });
});