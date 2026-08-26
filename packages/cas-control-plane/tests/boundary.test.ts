import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CAS_CONTROL_PLANE_PACKAGE } from "../src/index.js";

describe("cas-control-plane package boundary", () => {
  test("depends on protocol-cas-admin only among CAS packages", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.name).toBe(CAS_CONTROL_PLANE_PACKAGE);
    expect(pkg.dependencies["@unidocs/protocol-cas-admin"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/cloudflare-cas"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cas-client"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cas-admin-webui"]).toBeUndefined();
  });
});
