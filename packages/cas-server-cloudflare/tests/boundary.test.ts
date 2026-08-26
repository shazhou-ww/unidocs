import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import worker, { CAS_SERVER_CLOUDFLARE_PACKAGE } from "../src/worker.js";

describe("cas-server-cloudflare package boundary", () => {
  test("depends on protocol-cas only among CAS packages", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.name).toBe(CAS_SERVER_CLOUDFLARE_PACKAGE);
    expect(pkg.dependencies["@unidocs/protocol-cas"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/protocol-cas-legacy"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cloudflare-cas"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cas-client"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/gateway-common"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cas-admin-webui"]).toBeUndefined();
  });

  test("matches canonical stack routes and never /admin or legacy paths", async () => {
    const stackRoute = await worker.fetch(
      new Request("https://cas.example/stacks/s1/tenants/t1/root-refs", { method: "POST" }),
    );
    expect(stackRoute.status).toBe(501);

    const nodeRoute = await worker.fetch(
      new Request("https://cas.example/stacks/s1/tenants/t1/cas/nodes/abc/content"),
    );
    expect(nodeRoute.status).toBe(501);

    const admin = await worker.fetch(new Request("https://cas.example/admin/me"));
    expect(admin.status).toBe(404);

    const legacy = await worker.fetch(
      new Request("https://cas.example/tenants/t1/cas/nodes/abc/content"),
    );
    expect(legacy.status).toBe(404);

    const unknown = await worker.fetch(new Request("https://cas.example/health"));
    expect(unknown.status).toBe(404);
  });
});
