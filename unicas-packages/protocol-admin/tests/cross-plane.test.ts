import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  casAdminRoutes,
  casAuthPlanePolicy,
  matchCasAdminRoute,
} from "../src/index.js";

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readPkg(name: string): {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
}

const TENANT_IMPL_PACKAGES = [
  "@unicas/client",
  "@unicas/server-common",
] as const;

describe("cross-plane separation", () => {
  test("admin routes live only under the /admin plane", () => {
    const adminPaths = [
      casAdminRoutes.me(),
      casAdminRoutes.stacks(),
      casAdminRoutes.stack({ stackId: "s" }),
      casAdminRoutes.members({ stackId: "s" }),
      casAdminRoutes.rootDomainRefs({ stackId: "s", refDomain: "doc" }),
      casAdminRoutes.rootDomainEvents({ stackId: "s", refDomain: "doc" }),
      casAdminRoutes.controlAuditEvents({ stackId: "s" }),
    ];
    for (const path of adminPaths) {
      expect(path.startsWith("/admin/")).toBe(true);
      expect(path.startsWith("/stacks/")).toBe(false);
    }
  });

  test("admin matcher never recognizes tenant data-plane paths", () => {
    const tenantPaths = [
      "/stacks/s/tenants/t/nodes/h/content",
      "/stacks/s/tenants/t/root-refs",
      "/tenants/t/cas/usage",
      "/tenants/t/_internal/root-refs",
    ];
    for (const path of tenantPaths) {
      expect(matchCasAdminRoute("GET", path)).toBeNull();
      expect(matchCasAdminRoute("POST", path)).toBeNull();
    }
  });

  test("authorization matrix: credential classes stay on their plane", () => {
    expect(casAuthPlanePolicy.stackAdminPlane.pathPrefix).toBe("/admin");
    expect(casAuthPlanePolicy.stackAdminPlane.credential).toBe("google_oidc_bff_session");
    expect(casAuthPlanePolicy.stackAdminPlane.rejects).toEqual([
      "stack_issuer_jwt_capability",
    ]);
    expect(casAuthPlanePolicy.tenantDataPlane.pathPrefix).toBe("/stacks");
    expect(casAuthPlanePolicy.tenantDataPlane.credential).toBe(
      "stack_issuer_jwt_capability",
    );
    expect(casAuthPlanePolicy.tenantDataPlane.rejects).toEqual([
      "oidc_bff_session",
      "platform_operator_session",
    ]);
  });
});

describe("package dependency boundaries", () => {
  test("four middleware packages exist with required dependency direction", () => {
    const protocol = readPkg("protocol-admin");
    const control = readPkg("control-plane");
    const webui = readPkg("admin-webui");
    const edge = readPkg("edge");

    expect(protocol.name).toBe("@unicas/protocol-admin");
    expect(control.name).toBe("@unicas/control-plane");
    expect(webui.name).toBe("@unicas/admin-webui");
    expect(edge.name).toBe("@unicas/edge");
    expect(webui.private).toBe(true);
    expect(edge.private).toBe(true);

    expect(control.dependencies?.["@unicas/protocol-admin"]).toBe("workspace:*");
    expect(webui.dependencies?.["@unicas/protocol-admin"]).toBe("workspace:*");
    expect(webui.dependencies?.["@unicas/control-plane"]).toBe("workspace:*");

    // Admin protocol stays independent of the tenant protocol package
    // (canonical and migration-only legacy surface alike).
    expect(protocol.dependencies?.["@unicas/protocol"]).toBeUndefined();
    expect(protocol.devDependencies?.["@unicas/protocol"]).toBeUndefined();
    expect(protocol.dependencies?.["@unicas/protocol-legacy"]).toBeUndefined();
    expect(protocol.devDependencies?.["@unicas/protocol-legacy"]).toBeUndefined();

    for (const pkg of [protocol, control, webui, edge]) {
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      for (const forbidden of TENANT_IMPL_PACKAGES) {
        expect(deps[forbidden], `${pkg.name} must not depend on ${forbidden}`).toBeUndefined();
      }
    }

    expect(protocol.dependencies?.["@unicas/control-plane"]).toBeUndefined();
    expect(protocol.dependencies?.["@unicas/admin-webui"]).toBeUndefined();
    expect(control.dependencies?.["@unicas/admin-webui"]).toBeUndefined();
  });

  test("cas-client stays on the tenant protocol only", () => {
    const client = readPkg("client");
    // cas-client consumes the migration-only legacy tenant surface until the
    // caller migration (Task 8) moves it onto the canonical stack protocol.
    expect(client.dependencies?.["@unicas/protocol-legacy"]).toBe("workspace:*");
    expect(client.dependencies?.["@unicas/protocol-admin"]).toBeUndefined();
  });
});
