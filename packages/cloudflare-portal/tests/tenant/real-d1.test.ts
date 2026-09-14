import { afterEach, describe, expect, it } from "vitest";
import { startRealD1, type RealD1 } from "./real-d1.js";

describe("startRealD1", () => {
  let real: RealD1 | undefined;

  afterEach(async () => {
    await real?.dispose();
    real = undefined;
  });

  it("applies every migration, admin and tenant alike", async () => {
    real = await startRealD1();
    const { results } = await real.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all<{ name: string }>();
    const names = results.map(row => row.name);
    // 0002 (admin catalog), 0012 (tenant) and 0012's late index must all be present.
    expect(names).toContain("portal_document_types");
    expect(names).toContain("portal_documents");
    expect(names).toContain("portal_tenant_sessions");
    expect(names).toContain("portal_comment_version");
  });

  it("gives each call an isolated database", async () => {
    const first = await startRealD1();
    const second = await startRealD1();
    try {
      await first.db.prepare(
        "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t', 'd', 'n', 'markdown', NULL, 1)",
      ).run();
      const row = await second.db.prepare("SELECT COUNT(*) AS n FROM portal_documents").first<{ n: number }>();
      expect(row?.n).toBe(0);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
