import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("service-cloudflare package boundary", () => {
  test("is the single Cloudflare deployment adapter over the cloud-neutral service", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const wrangler = readFileSync(join(root, "wrangler.toml"), "utf8");

    expect(pkg.name).toBe("@unicas/service-cloudflare");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies["@unicas/service"]).toBe("workspace:*");
    expect(wrangler).toContain('name = "unidocs-cas"');
    expect(wrangler).toContain('pattern = "unicas.shazhou.work/*"');
    expect(wrangler).not.toContain("[[services]]");
    expect(wrangler).toContain('binding = "CAS_CONTROL_DB"');
    expect(wrangler).toContain('binding = "CAS_DB"');
    expect(wrangler).toContain('binding = "CAS_R2"');
    expect(wrangler).toContain('binding = "OAUTH_KV"');

    for (const packageName of ["admin-webui", "control-plane-mcp"]) {
      const legacyPackage = JSON.parse(readFileSync(
        join(root, "..", packageName, "package.json"),
        "utf8",
      ));
      expect(legacyPackage.scripts.deploy, packageName).toBeUndefined();
    }
  });
});