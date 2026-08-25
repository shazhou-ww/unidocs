import { describe, expect, it, vi } from "vitest";
import { CAS_SCHEMA_MIGRATIONS, migrateCasSchema } from "../src/cas/schema";

describe("CAS tenant schema", () => {
  it("creates tenant-scoped tables and indexes", () => {
    expect(CAS_SCHEMA_MIGRATIONS.join("\n")).toContain("tenant_id");
    expect(CAS_SCHEMA_MIGRATIONS.join("\n")).not.toContain("user_id");
  });

  it("renames legacy partition columns without rebuilding their data", async () => {
    const exec = vi.fn(async () => undefined);
    const prepare = vi.fn((sql: string) => ({
      all: async () => ({
        results: [{ name: sql.includes("cas_nodes") ? "user_id" : "tenant_id" }],
      }),
    }));

    await migrateCasSchema({ exec, prepare } as unknown as D1Database);

    expect(exec).toHaveBeenCalledWith(
      "ALTER TABLE cas_nodes RENAME COLUMN user_id TO tenant_id",
    );
    expect(exec).not.toHaveBeenCalledWith(
      "ALTER TABLE cas_edges RENAME COLUMN user_id TO tenant_id",
    );
  });
});