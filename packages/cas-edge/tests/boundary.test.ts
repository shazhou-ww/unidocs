import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CAS_EDGE_DISPATCH } from "../src/worker.js";
import worker from "../src/worker.js";

describe("cas-edge package boundary", () => {
  test("is private and does not depend on tenant DO implementation packages", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies ?? {}).not.toHaveProperty("@unidocs/cloudflare-cas");
    expect(pkg.dependencies ?? {}).not.toHaveProperty("@unidocs/cas-server-common");
    expect(CAS_EDGE_DISPATCH).toEqual({
      tenantPrefix: "/stacks",
      adminPrefix: "/admin",
    });
  });

  test("rejects paths outside /stacks and /admin", async () => {
    const res = await worker.fetch(new Request("https://cas.example/health"));
    expect(res.status).toBe(404);
  });

  test("never forwards the private audit-reader RPC or legacy internal paths", async () => {
    const rpc = await worker.fetch(new Request("https://cas.example/_internal/audit/refs"));
    expect(rpc.status).toBe(404);
    const internal = await worker.fetch(new Request("https://cas.example/_internal/root-refs"));
    expect(internal.status).toBe(404);
    const tenantLegacy = await worker.fetch(new Request("https://cas.example/tenants/t/cas/usage"));
    expect(tenantLegacy.status).toBe(404);
  });
});
