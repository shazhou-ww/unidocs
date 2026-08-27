import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  checkCasContractDocs,
  currentContractDocuments,
  inspectContractDocument,
} from "../../../scripts/check-cas-contract-docs.mjs";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

describe("CAS contract documentation guard", () => {
  test("current non-historical documentation contains no retired CAS guidance", () => {
    expect(checkCasContractDocs(REPO_ROOT)).toEqual([]);
  });

  test.each([
    ["owner-assignment", "Call rootAssignments and persist cas_root_owners."],
    ["portable-node-route", "POST /_internal/nodes/{hash}"],
    ["shared-cas-key", "Set CAS_ACCESS_KEY on both services."],
    ["tenantless-root-route", "POST /_internal/root-refs"],
    ["stale-admin-route", "GET /stacks/{stackId}/admin/root-ref-domains/doc/refs"],
  ])("detects %s guidance", (rule, source) => {
    expect(inspectContractDocument("fixture.md", source)).toEqual([
      expect.objectContaining({ rule }),
    ]);
  });

  test("permits retired details only inside an explicit migration section", () => {
    const source = [
      "<!-- cas-contract-docs: migration-start -->",
      "The rollback artifact still reads CAS_ACCESS_KEY.",
      "<!-- cas-contract-docs: migration-end -->",
    ].join("\n");
    expect(inspectContractDocument("fixture.md", source)).toEqual([]);
  });

  test("rejects malformed migration markers", () => {
    expect(inspectContractDocument("fixture.md", "<!-- cas-contract-docs: migration-start -->"))
      .toEqual([expect.objectContaining({ rule: "migration-marker" })]);
    expect(inspectContractDocument("fixture.md", "<!-- cas-contract-docs: migration-end -->"))
      .toEqual([expect.objectContaining({ rule: "migration-marker" })]);
  });

  test("historical plans are outside the live-contract document set", () => {
    const documents = currentContractDocuments(REPO_ROOT);
    expect(documents).toContain("docs/cas-architecture.md");
    expect(documents.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
  });
});