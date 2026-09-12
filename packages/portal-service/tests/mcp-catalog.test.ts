import { expect, test } from "vitest";
import { AdminMcpInputSchemas } from "@unidocs/protocol-admin-portal";
import { ADMIN_MCP_CATALOG, ADMIN_MCP_SCOPES, requireAdminMcpToolAccess, type AdminMcpToolName } from "../src/mcp/catalog.js";

const allEnabled = { enabled: true, contentMutationsEnabled: true, publishMutationsEnabled: true, securityMutationsEnabled: true };
const names = Object.keys(ADMIN_MCP_CATALOG) as AdminMcpToolName[];

test("pins the 27-tool catalog and annotations", () => {
  expect(names).toHaveLength(27);
  expect(names.toSorted()).toEqual(Object.keys(AdminMcpInputSchemas).toSorted());
  expect(ADMIN_MCP_SCOPES.map(scope => names.filter(name => ADMIN_MCP_CATALOG[name].scope === scope).length)).toEqual([15, 8, 2, 2]);
  expect(ADMIN_MCP_CATALOG).toMatchSnapshot();
  for (const name of names.filter(name => ADMIN_MCP_CATALOG[name].scope === "admin:read")) {
    expect(ADMIN_MCP_CATALOG[name].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  }
  expect(ADMIN_MCP_CATALOG.remove_administrator.annotations.destructiveHint).toBe(true);
});

test.each(names)("%s requires its explicit scope without implication", name => {
  for (const scope of [...ADMIN_MCP_SCOPES, "admin:*", "unknown"]) {
    const invoke = () => requireAdminMcpToolAccess(name, [scope], allEnabled);
    if (scope === ADMIN_MCP_CATALOG[name].scope) expect(invoke).not.toThrow();
    else expect(invoke).toThrow(expect.objectContaining({ code: "forbidden" }));
  }
  expect(() => requireAdminMcpToolAccess(name, [], allEnabled)).toThrow();
  expect(() => requireAdminMcpToolAccess(name, ADMIN_MCP_SCOPES, { ...allEnabled, enabled: false })).toThrow();
});

test.each(names)("%s obeys independent mutation switches", name => {
  for (const enabledScope of ADMIN_MCP_SCOPES) {
    const invoke = () => requireAdminMcpToolAccess(name, ADMIN_MCP_SCOPES, {
      enabled: true,
      contentMutationsEnabled: enabledScope === "admin:content",
      publishMutationsEnabled: enabledScope === "admin:publish",
      securityMutationsEnabled: enabledScope === "admin:security",
    });
    if (ADMIN_MCP_CATALOG[name].scope === "admin:read" || ADMIN_MCP_CATALOG[name].scope === enabledScope) expect(invoke).not.toThrow();
    else expect(invoke).toThrow();
  }
});