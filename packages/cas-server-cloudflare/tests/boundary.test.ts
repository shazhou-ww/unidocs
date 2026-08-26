import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import worker from "../src/worker.js";
import type { Env } from "../src/worker.js";

/** The boundary tests never reach storage; bare D1/R2-shaped stubs suffice. */
const STUB_ENV = {
  CAS_CONTROL_DB: {},
  CAS_DB: { exec: async () => undefined },
  CAS_R2: {},
  CAS_DO: {},
} as unknown as Env;

describe("cas-server-cloudflare package boundary", () => {
  test("depends on protocol-cas, the authority repository, and service-auth only", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.name).toBe("@unidocs/cas-server-cloudflare");
    expect(pkg.dependencies["@unidocs/protocol-cas"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/cas-control-plane"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/cas-server-common"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/protocol"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/svalue-codec"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/service-auth"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/protocol-cas-legacy"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cloudflare-cas"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cas-client"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/gateway-common"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cas-admin-webui"]).toBeUndefined();
  });

  test("tenant routes require a capability; /admin and legacy paths never match", async () => {
    // Stack-scoped tenant route without a token: authorization runs first → 401.
    const stackRoute = await worker.fetch(
      new Request("https://cas.example/stacks/s1/tenants/t1/root-refs", { method: "POST" }),
      STUB_ENV,
    );
    expect(stackRoute.status).toBe(401);

    const nodeRoute = await worker.fetch(
      new Request("https://cas.example/stacks/s1/tenants/t1/cas/nodes/abc/content"),
      STUB_ENV,
    );
    expect(nodeRoute.status).toBe(401);

    const admin = await worker.fetch(new Request("https://cas.example/admin/me"), STUB_ENV);
    expect(admin.status).toBe(404);

    const legacy = await worker.fetch(
      new Request("https://cas.example/tenants/t1/cas/nodes/abc/content"),
      STUB_ENV,
    );
    expect(legacy.status).toBe(404);

    const unknown = await worker.fetch(new Request("https://cas.example/health"), STUB_ENV);
    expect(unknown.status).toBe(404);
  });
});
