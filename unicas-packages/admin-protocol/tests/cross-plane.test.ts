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

const TENANT_IMPLEMENTATION_PACKAGES = [
  "@unicas/tenant-client",
  "@unicas/tenant-blob-client",
  "@unicas/codec",
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
    const protocol = readPkg("admin-protocol");
    const control = readPkg("control-plane");
    const webui = readPkg("admin-webui");
    const edge = readPkg("edge");

    expect(protocol.name).toBe("@unicas/admin-protocol");
    expect(control.name).toBe("@unicas/control-plane");
    expect(webui.name).toBe("@unicas/admin-webui");
    expect(edge.name).toBe("@unicas/edge");
    expect(webui.private).toBe(true);
    expect(edge.private).toBe(true);

    expect(control.dependencies?.["@unicas/admin-protocol"]).toBe("workspace:*");
    expect(webui.dependencies?.["@unicas/admin-protocol"]).toBe("workspace:*");
    expect(webui.dependencies?.["@unicas/control-plane"]).toBe("workspace:*");

    // Shared cross-plane contracts may flow tenant-protocol -> admin-protocol,
    // but the retired legacy package must never return.
    expect(protocol.dependencies?.["@unicas/tenant-protocol-legacy"]).toBeUndefined();
    expect(protocol.devDependencies?.["@unicas/tenant-protocol-legacy"]).toBeUndefined();

    for (const pkg of [protocol, control, webui, edge]) {
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      for (const forbidden of TENANT_IMPLEMENTATION_PACKAGES) {
        expect(deps[forbidden], `${pkg.name} must not depend on ${forbidden}`).toBeUndefined();
      }
    }

    for (const pkg of [control, webui, edge]) {
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      expect(deps["@unicas/tenant-protocol"]).toBeUndefined();
    }

    expect(protocol.dependencies?.["@unicas/control-plane"]).toBeUndefined();
    expect(protocol.dependencies?.["@unicas/admin-webui"]).toBeUndefined();
    expect(control.dependencies?.["@unicas/admin-webui"]).toBeUndefined();
  });

  test("tenant-client stays on the tenant protocol only", () => {
    const client = readPkg("tenant-client");
    expect(client.dependencies?.["@unicas/tenant-protocol-legacy"]).toBeUndefined();
    expect(client.dependencies?.["@unicas/admin-protocol"]).toBeUndefined();
  });

  test("tenant protocol never depends on the admin protocol", () => {
    const protocol = readPkg("tenant-protocol");
    expect(protocol.dependencies?.["@unicas/admin-protocol"]).toBeUndefined();
    expect(protocol.devDependencies?.["@unicas/admin-protocol"]).toBeUndefined();
  });
});
