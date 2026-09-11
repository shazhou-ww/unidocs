import { expect, test } from "vitest";
import { requireExactFields, requireIdempotencyKey, requireIdentifier, requirePagination, requireRecordIdx, requireTenantScope, TENANT_LIMITS, TenantAccessError, TenantOperationError, type TenantContext } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };

test("a credential for one tenant cannot address another tenant", () => {
  expect(() => requireTenantScope(context, "tenant-a")).not.toThrow();
  expect(() => requireTenantScope(context, "tenant-b")).toThrow(expect.objectContaining({ code: "forbidden" }));
});

test.each(["", " ", "a".repeat(TENANT_LIMITS.identifier + 1)])("rejects an unusable tenant path segment %#", segment => {
  expect(() => requireTenantScope(context, segment)).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test.each(["", "space key", "a".repeat(TENANT_LIMITS.idempotencyKey + 1), "non-ascii-é"])("rejects an unbounded or non-printable idempotency key %#", key => {
  expect(() => requireIdempotencyKey(key)).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("accepts a printable bounded idempotency key", () => {
  expect(requireIdempotencyKey("retry-1")).toBe("retry-1");
});

test.each([undefined, 1, "", "with space", "a".repeat(TENANT_LIMITS.identifier + 1)])("rejects an invalid identifier %#", value => {
  expect(() => requireIdentifier(value)).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test.each([-1, 1.5, Number.NaN, "0", null])("rejects a record index that is not zero-based %#", value => {
  expect(() => requireRecordIdx(value)).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("accepts zero as a record index, because null means absent", () => {
  expect(requireRecordIdx(0)).toBe(0);
});

test("bounds pagination and rejects an oversized cursor", () => {
  expect(requirePagination(undefined)).toEqual({});
  expect(requirePagination({ limit: 25 })).toEqual({ limit: 25 });
  expect(() => requirePagination({ limit: 0 })).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requirePagination({ limit: 101 })).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requirePagination({ cursor: "a".repeat(1025) })).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("rejects a body carrying a field the operation does not define", () => {
  expect(requireExactFields({ name: "Notes" }, ["name"])).toEqual({ name: "Notes" });
  expect(() => requireExactFields({ name: "Notes", owner: "someone" }, ["name"])).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requireExactFields([], ["name"])).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requireExactFields(null, ["name"])).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("access failures are distinct from operation failures", () => {
  expect(new TenantAccessError("unauthorized")).toBeInstanceOf(Error);
  expect(new TenantOperationError("version_conflict").message).toBe("The observed current version does not match the current pointer");
});
