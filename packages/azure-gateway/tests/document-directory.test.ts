import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgGatewayDocumentDirectory } from "../src/document-directory.js";

it("updates only a higher ready version in one tenant-scoped PostgreSQL statement", async () => {
  const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
  const directory = new PgGatewayDocumentDirectory({ query } as unknown as Pool);
  await directory.advanceVersion("tenant", "doc", 3, 200);
  expect(query).toHaveBeenCalledTimes(1);
  const [sql, values] = query.mock.calls[0]!;
  expect(sql).toContain("version = $3");
  expect(sql).toContain("GREATEST(updated_at, $4)");
  expect(sql).toContain("tenant_id = $1 AND doc_id = $2 AND state = 'ready'");
  expect(sql).toContain("COALESCE(version, 0) < $3");
  expect(values).toEqual(["tenant", "doc", 3, 200]);
  await expect(directory.advanceVersion("tenant", "doc", 0, 200)).rejects.toThrow();
  await expect(directory.advanceVersion("tenant", "doc", 3, -1)).rejects.toThrow();
  expect(query).toHaveBeenCalledTimes(1);
});

it("propagates storage failure so the caller can preserve committed content and report pending projection", async () => {
  const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
  const directory = new PgGatewayDocumentDirectory({ query } as unknown as Pool);
  await expect(directory.advanceVersion("tenant", "doc", 3, 200)).rejects.toThrow("database unavailable");
});