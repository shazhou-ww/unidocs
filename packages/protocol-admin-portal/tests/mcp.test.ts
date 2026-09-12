import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { z } from "zod";
import { ADMIN_MCP_ZIP_MAX_BYTES, ADMIN_MCP_ZIP_MAX_BASE64_LENGTH, AdminMcpBase64ZipSchema, AdminMcpIdempotencyKeySchema, AdminMcpInputSchemas } from "../src/mcp.js";

const etag = `"sha256-${"a".repeat(43)}"`;
const conditional = { idempotencyKey: "intent-1", etag };

test("pins all tool input JSON schema fingerprints", () => {
  expect(Object.keys(AdminMcpInputSchemas)).toHaveLength(27);
  expect(Object.fromEntries(Object.entries(AdminMcpInputSchemas).map(([name, schema]) => [name,
    createHash("sha256").update(JSON.stringify(z.toJSONSchema(schema, { io: "input" }))).digest("hex"),
  ]))).toMatchSnapshot();
});

test.each(["", "x".repeat(129), "newline\n", "tab\t", "\x7f", "\u00e9"])("rejects invalid idempotency key %#", key => {
  expect(AdminMcpIdempotencyKeySchema.safeParse(key).success).toBe(false);
});

test("accepts exact printable ASCII limits without changing the key", () => {
  for (const key of [" ", "x".repeat(128), " retry with spaces "]) expect(AdminMcpIdempotencyKeySchema.parse(key)).toBe(key);
});

test("every mutation requires an explicit key, and conditional tools require an ETag", () => {
  const mutations = Object.values(AdminMcpInputSchemas).filter(schema => "idempotencyKey" in schema.shape);
  expect(mutations).toHaveLength(12);
  for (const schema of mutations) {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === "idempotencyKey")).toBe(true);
  }
  const conditionals = Object.values(AdminMcpInputSchemas).filter(schema => "etag" in schema.shape);
  expect(conditionals).toHaveLength(5);
  for (const schema of conditionals) {
    const result = schema.safeParse({});
    if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === "etag")).toBe(true);
  }
});

test("requires a real update and exact boolean confirmation", () => {
  const base = { documentType: "markdown", ...conditional };
  for (const fields of [{}, { reason: "because" }, { confirmEnabled: true }, { enabled: true }, { enabled: false }, { enabled: false, confirmEnabled: true }]) {
    expect(AdminMcpInputSchemas.update_document_type.safeParse({ ...base, ...fields }).success).toBe(false);
  }
  for (const enabled of [true, false]) expect(AdminMcpInputSchemas.update_document_type.safeParse({ ...base, enabled, confirmEnabled: enabled }).success).toBe(true);
});

test("requires reasons for every candidate selection and confirmation to clear an Operator", () => {
  const base = { documentType: "markdown", ...conditional };
  for (const fields of [{ typeCardBundleId: "card" }, { viewBundleId: "view" }, { builtinOperatorId: "operator" }, { builtinOperatorId: null, confirmOperatorId: "operator" }]) {
    for (const reason of [undefined, "", "   "]) expect(AdminMcpInputSchemas.update_document_type.safeParse({ ...base, ...fields, reason }).success).toBe(false);
    expect(AdminMcpInputSchemas.update_document_type.safeParse({ ...base, ...fields, reason: "release" }).success).toBe(true);
  }
  expect(AdminMcpInputSchemas.update_document_type.safeParse({ ...base, builtinOperatorId: null, reason: "retire" }).success).toBe(false);
});

test("requires normalized email and administrator identity confirmations", () => {
  const add = { idempotencyKey: "intent", email: "Admin@example.com", confirmEmail: " admin@EXAMPLE.COM " };
  expect(AdminMcpInputSchemas.add_administrator.safeParse(add).success).toBe(true);
  expect(AdminMcpInputSchemas.add_administrator.safeParse({ ...add, confirmEmail: "other@example.com" }).success).toBe(false);
  const remove = { ...conditional, adminId: "admin", confirmAdminId: "other", confirmEmail: "admin@example.com" };
  expect(AdminMcpInputSchemas.remove_administrator.safeParse(remove).success).toBe(false);
  expect(AdminMcpInputSchemas.remove_administrator.safeParse({ ...remove, confirmAdminId: "admin" }).success).toBe(true);
});

test.each(["", "YQ", "YQ=", "YQ===", "YQ==\n", " YQ==", "data:application/zip;base64,YQ==", "____", "----", "YR==", "YWJ=", "====", "AA=A"])("rejects noncanonical base64 %#", value => {
  expect(AdminMcpBase64ZipSchema.safeParse(value).success).toBe(false);
});

test("enforces decoded size even when encoded lengths are identical", () => {
  expect(ADMIN_MCP_ZIP_MAX_BASE64_LENGTH).toBe(11_184_812);
  for (const size of [1, 2, 3, ADMIN_MCP_ZIP_MAX_BYTES - 1, ADMIN_MCP_ZIP_MAX_BYTES, ADMIN_MCP_ZIP_MAX_BYTES + 1]) {
    const encoded = Buffer.alloc(size).toString("base64");
    expect(AdminMcpBase64ZipSchema.safeParse(encoded).success).toBe(size <= ADMIN_MCP_ZIP_MAX_BYTES);
  }
});

test("rejects unknown transport credentials and source URLs", () => {
  for (const schema of Object.values(AdminMcpInputSchemas)) {
    for (const key of ["cookie", "csrfToken", "accessToken", "sourceUrl"]) {
      const result = schema.safeParse({ [key]: "secret" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.some(issue => issue.code === "unrecognized_keys")).toBe(true);
    }
  }
});