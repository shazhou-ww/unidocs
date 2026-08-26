import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CAS_ADMIN_WEBUI_MOUNT } from "../src/server/config.js";

describe("cas-admin-webui package boundary", () => {
  test("depends on protocol-cas-admin and cas-control-plane only", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies["@unidocs/protocol-cas-admin"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/cas-control-plane"]).toBe("workspace:*");
    expect(pkg.dependencies["@unidocs/cloudflare-cas"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cas-client"]).toBeUndefined();
    expect(pkg.dependencies["@unidocs/cas-server-common"]).toBeUndefined();
    expect(CAS_ADMIN_WEBUI_MOUNT).toBe("/admin");
  });
});
