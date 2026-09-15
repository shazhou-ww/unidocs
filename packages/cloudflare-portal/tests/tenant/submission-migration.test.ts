import { afterEach, describe, expect, it } from "vitest";
import { startRealD1, type RealD1 } from "./real-d1.js";

describe("tenant submissions migration (real D1)", () => {
  let real: RealD1 | undefined;

  afterEach(async () => {
    await real?.dispose();
    real = undefined;
  });

  async function seedDocument(): Promise<void> {
    await real!.db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t', 'd', 'n', 'markdown', NULL, 1)",
    ).run();
  }

  it("creates portal_submissions with a receipt_json JSON check", async () => {
    real = await startRealD1();
    const { results } = await real.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portal_submissions'")
      .all<{ name: string }>();
    expect(results).toHaveLength(1);
  });

  it("stores one receipt row for a committed submission", async () => {
    real = await startRealD1();
    await seedDocument();
    await real.db.prepare(
      "INSERT INTO portal_submissions (tenant_id, document_id, submission_id, actor_id, fingerprint, receipt_json, created_at) VALUES ('t', 'd', 's1', 'agent:x', 'f1', '{\"state\":\"committed\"}', 1)",
    ).run();
    const row = await real.db.prepare("SELECT COUNT(*) AS n FROM portal_submissions").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("rejects a second row with the same primary key", async () => {
    real = await startRealD1();
    await seedDocument();
    await real.db.prepare(
      "INSERT INTO portal_submissions (tenant_id, document_id, submission_id, actor_id, fingerprint, receipt_json, created_at) VALUES ('t', 'd', 's1', 'agent:x', 'f1', '{\"state\":\"committed\"}', 1)",
    ).run();
    await expect(real.db.prepare(
      "INSERT INTO portal_submissions (tenant_id, document_id, submission_id, actor_id, fingerprint, receipt_json, created_at) VALUES ('t', 'd', 's1', 'agent:x', 'f2', '{\"state\":\"committed\"}', 2)",
    ).run()).rejects.toThrow();
  });

  it("rejects a receipt_json value that is not valid JSON", async () => {
    real = await startRealD1();
    await seedDocument();
    await expect(real.db.prepare(
      "INSERT INTO portal_submissions (tenant_id, document_id, submission_id, actor_id, fingerprint, receipt_json, created_at) VALUES ('t', 'd', 's1', 'agent:x', 'f1', 'not json', 1)",
    ).run()).rejects.toThrow();
  });

  it("rejects a submission referencing a document that does not exist (D1 enforces foreign keys by default)", async () => {
    real = await startRealD1();
    await expect(real.db.prepare(
      "INSERT INTO portal_submissions (tenant_id, document_id, submission_id, actor_id, fingerprint, receipt_json, created_at) VALUES ('t', 'missing', 's1', 'agent:x', 'f1', '{\"state\":\"committed\"}', 1)",
    ).run()).rejects.toThrow();
  });
});
