import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CAS_ADMIN_WEBUI_MOUNT } from "../src/server/config.js";

describe("cas-admin-webui package boundary", () => {
  test("depends on admin contracts and is not independently deployable", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies["@unicas/admin-protocol"]).toBe("workspace:*");
    expect(pkg.dependencies["@unicas/control-plane"]).toBe("workspace:*");
    expect(pkg.dependencies["@unicas/tenant-client"]).toBeUndefined();
    expect(pkg.dependencies["@unicas/tenant-protocol"]).toBeUndefined();
    expect(pkg.scripts.deploy).toBeUndefined();
    expect(CAS_ADMIN_WEBUI_MOUNT).toBe("/admin");
  });
});
