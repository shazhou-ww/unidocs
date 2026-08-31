import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("control admin service boundary", () => {
  test("uses semantic repository records without Cloudflare or SQL types", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(join(root, "src/control-admin.ts"), "utf8");
    expect(source).toContain("interface ControlPlaneAdminRepository");
    expect(source).toContain("class ControlPlaneAdminService");
    expect(source).not.toContain("D1Database");
    expect(source).not.toContain("D1PreparedStatement");
    expect(source).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|cas_)/i);

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies).not.toHaveProperty("@cloudflare/workers-types");
    expect(pkg.devDependencies).not.toHaveProperty("@cloudflare/workers-types");
  });
});
