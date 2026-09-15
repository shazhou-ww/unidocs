import { afterEach, describe, expect, it } from "vitest";
import { startRealD1, type RealD1 } from "./real-d1.js";

describe("operator loop repair migration (real D1)", () => {
  let real: RealD1 | undefined;

  afterEach(async () => {
    await real?.dispose();
    real = undefined;
  });

  it("adds a nullable redelivery time to documents and retain time to versions", async () => {
    real = await startRealD1();
    await real.db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t', 'd', 'n', 'markdown', NULL, 1)",
    ).run();
    await real.db.prepare(
      `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
       VALUES ('t', 'd', 0, NULL, 0, 'agent:x', 's', '[]', 'h', 1, 'c', 1)`,
    ).run();
    const document = await real.db.prepare("SELECT initialization_redelivered_at FROM portal_documents").first();
    const version = await real.db.prepare("SELECT snapshot_retained_at FROM portal_versions").first();
    expect(document).toEqual({ initialization_redelivered_at: null });
    expect(version).toEqual({ snapshot_retained_at: null });
  });

  it("takes versions committed before it as retained, and leaves documents unmarked", async () => {
    real = await startRealD1({ through: "0013_tenant_submissions.sql" });
    await real.db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t', 'd', 'n', 'markdown', 0, 1)",
    ).run();
    await real.db.prepare(
      `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
       VALUES ('t', 'd', 0, NULL, 0, 'agent:x', 's', '[]', 'h', 1, 'c', 1234)`,
    ).run();

    await real.applyMigration("0014_operator_loop_repair.sql");

    const version = await real.db.prepare("SELECT snapshot_retained_at, snapshot_retain_attempted_at, snapshot_lost_at FROM portal_versions").first();
    expect(version).toEqual({ snapshot_retained_at: 1234, snapshot_retain_attempted_at: null, snapshot_lost_at: null });
    const document = await real.db.prepare("SELECT initialization_redelivered_at FROM portal_documents").first();
    expect(document).toEqual({ initialization_redelivered_at: null });
  });

  it("indexes only the versions still waiting for a retain", async () => {
    real = await startRealD1();
    const index = await real.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'portal_version_unretained'").first<{ sql: string }>();
    expect(index?.sql).toContain("WHERE snapshot_retained_at IS NULL AND snapshot_lost_at IS NULL");
  });
});
