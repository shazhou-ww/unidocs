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
});
