import { describe, expect, it } from "vitest";
import {
  deploymentPlan as unicasPlan,
  parseArgs as parseUnicasArgs,
} from "../../../stacks/unicas/deploy/deploy.mjs";
import {
  assertProductionIdentityReady,
  deploymentPlan as cloudflarePlan,
  parseArgs as parseCloudflareArgs,
} from "../../../stacks/unidocs-cloudflare/deploy/deploy.mjs";

describe("stack deployment plans", () => {
  it("deploys UniCAS backing workers before edge and builds smoke dependencies", () => {
    const plan = unicasPlan(parseUnicasArgs([])).map((command) => command.join(" "));
    expect(plan.findIndex((command) => command.includes("server-cloudflare exec wrangler deploy")))
      .toBeLessThan(plan.findIndex((command) => command.includes("admin-webui exec wrangler deploy")));
    expect(plan.findIndex((command) => command.includes("admin-webui exec wrangler deploy")))
      .toBeLessThan(plan.findIndex((command) => command.includes("control-plane-mcp exec wrangler deploy")));
    expect(plan.findIndex((command) => command.includes("control-plane-mcp exec wrangler deploy")))
      .toBeLessThan(plan.findIndex((command) => command.includes("@unicas/edge exec wrangler deploy")));
    expect(plan.at(-3)).toContain("@unicas/tenant-protocol build");
    expect(plan.at(-2)).toContain("@unidocs/service-auth build");
    expect(plan.at(-1)).toBe("node stacks/unicas/deploy/smoke.mjs");
  });

  it("deploys selected Cloudflare docs before gateway migration and deploy", () => {
    const options = parseCloudflareArgs(["--service", "docx,markdown", "--gateway"]);
    const plan = cloudflarePlan(options).map((command) => command.join(" "));
    expect(plan[0]).toContain("cloudflare-docx build");
    expect(plan[2]).toContain("cloudflare-markdown build");
    expect(plan[4]).toContain("wrangler d1 migrations apply");
    expect(plan.at(-1)).toContain("cloudflare-gateway exec wrangler deploy");
  });

  it("blocks every real Cloudflare app deployment while identity is insecure", () => {
    expect(() => assertProductionIdentityReady(
      'createInsecureTenantIdentityResolver(true)',
    )).toThrow(/refusing the deployment/);
    expect(() => assertProductionIdentityReady("createProductionIdentityResolver()"))
      .not.toThrow();
  });
});