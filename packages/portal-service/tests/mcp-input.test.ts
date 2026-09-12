import { expect, test } from "vitest";
import type { AdministratorMemberRecord, DocumentTypeRegistration } from "@unidocs/protocol-admin-portal";
import { requireAdminMcpDocumentTypeConfirmation, requireAdminMcpRemovalConfirmation } from "../src/mcp/input.js";

const etag = `"sha256-${"a".repeat(43)}"`;
const current: AdministratorMemberRecord = { adminId: "member", email: "member@example.com", etag, bound: true, addedBy: "admin", addedAt: "2026-09-12T00:00:00.000Z" };
const removal = { adminId: "member", confirmAdminId: "member", confirmEmail: " MEMBER@example.com ", etag, idempotencyKey: "remove-intent" };

test("matches removal against current membership, not caller-supplied email", () => {
  expect(() => requireAdminMcpRemovalConfirmation(removal, current)).not.toThrow();
  for (const input of [{ ...removal, adminId: "other" }, { ...removal, confirmAdminId: "other" }, { ...removal, confirmEmail: "other@example.com" }, { ...removal, confirmEmail: "invalid" }]) {
    expect(() => requireAdminMcpRemovalConfirmation(input, current)).toThrow(expect.objectContaining({ code: "invalid_request" }));
  }
  expect(() => requireAdminMcpRemovalConfirmation(removal, { ...current, etag: "new-etag" })).toThrow(expect.objectContaining({ code: "precondition_failed" }));
});

const registration: DocumentTypeRegistration = {
  documentType: "markdown", internalName: "Markdown", enabled: false, etag,
  latestDocumentContract: null, typeCardBundle: null, viewBundle: null, updatedAt: current.addedAt,
  builtinOperator: {
    operatorId: "operator", documentType: "markdown", name: "Operator", description: "", etag,
    baseUrl: "https://operator.example", validatedAt: current.addedAt,
    descriptor: { protocol: "unidocs-operator/v1", declaredOperatorId: "operator", displayName: "Operator", supportedDocumentTypes: ["markdown"], supportedDocumentContracts: { markdown: [0] } },
  },
};

test("requires the current Operator and preserves the caller's ETag", () => {
  const input = { documentType: "markdown", builtinOperatorId: null, confirmOperatorId: "operator", reason: "retire", etag, idempotencyKey: "retire-intent" };
  expect(() => requireAdminMcpDocumentTypeConfirmation(input, registration)).not.toThrow();
  expect(() => requireAdminMcpDocumentTypeConfirmation({ ...input, confirmOperatorId: "other" }, registration)).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requireAdminMcpDocumentTypeConfirmation(input, { ...registration, builtinOperator: null })).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requireAdminMcpDocumentTypeConfirmation(input, { ...registration, etag: "new-etag" })).toThrow(expect.objectContaining({ code: "precondition_failed" }));
  expect(input.etag).toBe(etag);
});

test("state checks also enforce enabled confirmation and selection reasons", () => {
  for (const fields of [{ enabled: true }, { enabled: false, confirmEnabled: true }, { viewBundleId: "view", reason: " " }]) {
    expect(() => requireAdminMcpDocumentTypeConfirmation({ documentType: "markdown", etag, idempotencyKey: "intent", ...fields }, registration)).toThrow(expect.objectContaining({ code: "invalid_request" }));
  }
});