import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("cas-admin-webui package boundary", () => {
  test("is browser-only: depends on the admin client facade and is not independently deployable", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies["@unicas/admin-client"]).toBe("workspace:*");
    // The final client direction is admin-webui -> admin-client -> admin-protocol;
    // protocol types flow through the client facade, never directly.
    expect(pkg.dependencies["@unicas/admin-protocol"]).toBeUndefined();
    expect(pkg.dependencies["@unicas/service"]).toBeUndefined();
    expect(pkg.dependencies["@unicas/control-plane"]).toBeUndefined();
    expect(pkg.dependencies["@unicas/tenant-client"]).toBeUndefined();
    expect(pkg.dependencies["@unicas/tenant-protocol"]).toBeUndefined();
    expect(pkg.scripts.deploy).toBeUndefined();
    // The OIDC BFF composition moved to @unicas/service-cloudflare; this
    // package ships only the browser UI.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    expect(() => readFileSync(join(root, "src/server/index.ts"), "utf8")).toThrow();
    expect(pkg.main).toBe("./src/ui/index.ts");
    expect(pkg.scripts.build).toBe("vite build");
  });
});
