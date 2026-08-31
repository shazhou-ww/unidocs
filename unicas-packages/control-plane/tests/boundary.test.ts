import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CAS_CONTROL_PLANE_PACKAGE } from "../src/index.js";

describe("cas-control-plane package boundary", () => {
  test("depends only on the admin protocol and cloud-neutral service", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.name).toBe(CAS_CONTROL_PLANE_PACKAGE);
    expect(pkg.dependencies["@unicas/admin-protocol"]).toBe("workspace:*");
    expect(pkg.dependencies["@unicas/service"]).toBe("workspace:*");
    expect(pkg.dependencies["@unicas/tenant-client"]).toBeUndefined();
    expect(pkg.dependencies["@unicas/admin-webui"]).toBeUndefined();

    const serviceSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/service.ts"),
      "utf8",
    );
    for (const sql of [
      "INSERT INTO cas_operator_identities",
      "SELECT s.stack_id, s.display_name",
      "INSERT INTO cas_stacks",
      "UPDATE cas_stacks SET display_name",
      "cas_stack_member_invitations",
      "DELETE FROM cas_stack_members",
    ]) {
      expect(serviceSource).not.toContain(sql);
    }
  });
});
