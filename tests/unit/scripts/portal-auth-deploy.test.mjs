import { readFile, stat } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { checkPortalAuthDeployment, createPortalAuthDeploymentConfig, portalAuthDeploymentSummary } from "../../../stacks/unidocs-cloudflare/deploy/portal-auth.mjs";

const settings = { databaseId: "11111111-2222-4333-8444-555555555555", googleClientId: "existing-gateway-client.apps.googleusercontent.com", bootstrapEmail: "admin@example.com" };
const template = { compatibility_date: "2026-09-10", routes: [{ pattern: "unidocs.shazhou.work/*" }], vars: { UNRELATED_SECRET: "must-not-copy" } };

describe("Portal auth deployment preparation", () => {
  test("approved production cutover owns only admin routes and a separate database", async () => {
    const config = JSON.parse(await readFile(new URL("../../../packages/cloudflare-portal/wrangler.production.jsonc", import.meta.url), "utf8"));
    expect(config.routes.map(route => route.pattern)).toEqual(["unidocs.shazhou.work/admin", "unidocs.shazhou.work/admin/*"]);
    expect(config.d1_databases[0].database_id).not.toBe("d3c78c42-b32f-4a4d-86e4-6cf6341baa8f");
    expect(config.name).toBe("unidocs-portal");
    expect(config.workers_dev).toBe(false);
    expect(config.vars).not.toHaveProperty("GATEWAY_OIDC_CLIENT_SECRET");
    expect(config.secrets.required).toContain("GATEWAY_OIDC_CLIENT_SECRET");
  });
  test("uses an independent Worker and D1 with no public routes or copied secret values", () => {
    const config = createPortalAuthDeploymentConfig(template, { ...settings, clientSecret: "do-not-serialize" });
    expect(config.name).toBe("unidocs-portal");
    expect(config.routes).toEqual([]);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "unidocs-portal", database_id: settings.databaseId });
    expect(config.vars.PORTAL_ORIGIN).toBe("https://unidocs.shazhou.work");
    expect(config.observability.logs.invocation_logs).toBe(false);
    expect(config.secrets.required).toEqual(["GATEWAY_OIDC_CLIENT_SECRET"]);
    expect(JSON.stringify(config)).not.toContain("do-not-serialize");
    expect(JSON.stringify(config)).not.toContain("must-not-copy");
  });

  test.each([undefined, "local-portal-auth", "00000000-0000-0000-0000-000000000000", "d3c78c42-b32f-4a4d-86e4-6cf6341baa8f"])("refuses missing, placeholder or Gateway database ID %s", databaseId => {
    expect(() => createPortalAuthDeploymentConfig(template, { ...settings, databaseId })).toThrow("dedicated Portal D1");
  });

  test("requires real client ID shape and normalized bootstrap address", () => {
    expect(() => createPortalAuthDeploymentConfig(template, { ...settings, googleClientId: "" })).toThrow("client ID");
    expect(() => createPortalAuthDeploymentConfig(template, { ...settings, bootstrapEmail: "Admin@Example.com" })).toThrow("normalized");
  });

  test("summary explicitly identifies conflicts without leaking client or bootstrap values", () => {
    const summary = portalAuthDeploymentSummary(createPortalAuthDeploymentConfig(template, settings));
    expect(summary.conflicts).toContain("cookie: __Host-unidocs_admin");
    expect(summary.willDeploy).toBe(false);
    expect(summary.callback).toBe("https://unidocs.shazhou.work/admin/auth/callback");
    expect(JSON.stringify(summary)).not.toContain(settings.googleClientId);
    expect(JSON.stringify(summary)).not.toContain(settings.bootstrapEmail);
  });

  test("only requests dry-run and deletes temporary configuration on success", async () => {
    let configPath;
    const result = await checkPortalAuthDeployment(settings, (_executable, args, options) => {
      expect(args).toContain("--dry-run");
      expect(args).not.toContain("--remote");
      configPath = args.at(-1);
      expect(options.stdio).toBe("pipe");
      return { status: 0 };
    });
    expect(result.willDeploy).toBe(false);
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("deletes temporary configuration and suppresses raw CLI output on failure", async () => {
    let configPath;
    await expect(checkPortalAuthDeployment(settings, (_executable, args) => {
      configPath = args.at(-1);
      return { status: 1, stderr: "secret-output" };
    })).rejects.toThrow("dry-run failed");
    await expect(readFile(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});