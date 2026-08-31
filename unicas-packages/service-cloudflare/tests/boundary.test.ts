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
    expect(pkg.dependencies["@unicas/control-plane"]).toBeUndefined();
    expect(readFileSync(join(root, "src/control-admin-repository.ts"), "utf8"))
      .toContain("implements ControlPlaneAdminRepository");
    expect(readFileSync(join(root, "src/control-operations.ts"), "utf8"))
      .toContain("createControlPlaneOperations");
    const operations = readFileSync(join(root, "src/control-operations.ts"), "utf8");
    expect(operations).not.toContain("@unicas/control-plane");
    expect(operations).not.toContain("legacy");
    for (const operation of [
      "listMembers",
      "deleteMember",
      "createMemberInvitation",
      "acceptMemberInvitation",
      "getIssuer",
      "putIssuer",
      "createPossessionChallenge",
      "listIssuerKeys",
      "createIssuerKey",
      "deleteIssuerKey",
      "listControlAuditEvents",
    ]) {
      expect(operations).toContain(`${operation}: admin.${operation}.bind(admin)`);
    }
    expect(wrangler).toContain('name = "unidocs-cas"');
    expect(wrangler).toContain('pattern = "unicas.shazhou.work/*"');
    expect(wrangler).not.toContain("[[services]]");
    expect(wrangler).toContain('binding = "CAS_CONTROL_DB"');
    expect(wrangler).toContain('binding = "CAS_DB"');
    expect(wrangler).toContain('binding = "CAS_R2"');
    expect(wrangler).toContain('binding = "OAUTH_KV"');

    expect(pkg.dependencies["@unicas/control-plane-mcp"]).toBeUndefined();
    for (const packageName of ["admin-webui"]) {
      const legacyPackage = JSON.parse(readFileSync(
        join(root, "..", packageName, "package.json"),
        "utf8",
      ));
      expect(legacyPackage.scripts.deploy, packageName).toBeUndefined();
    }
  });

  test("hosts the MCP/OAuth ingress and admin BFF locally without control-plane SQL", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const mcpDir = join(root, "src/mcp");
    for (const file of ["auth.ts", "config.ts", "server.ts", "worker.ts"]) {
      expect(readFileSync(join(mcpDir, file), "utf8"), file).not.toContain(".prepare(");
    }
    const bffDir = join(root, "src/admin-bff");
    for (const file of ["bff.ts", "config.ts", "csrf.ts", "session.ts", "index.ts"]) {
      expect(readFileSync(join(bffDir, file), "utf8"), file).not.toContain(".prepare(");
    }
    const host = readFileSync(join(root, "src/worker.ts"), "utf8");
    expect(host).toContain('from "./mcp/worker.js"');
    expect(host).toContain('from "./admin-bff/index.js"');
    expect(host).not.toContain("@unicas/control-plane-mcp");
    expect(host).not.toContain("@unicas/admin-webui");
  });
});