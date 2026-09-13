import { expect, test, vi } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createAdminMcpServer, type AdminMcpReadServices } from "../src/mcp/server.js";

const identity = { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: 1_800_000_000 };

function handler(scopes: readonly string[], active = { value: true }, services?: AdminMcpReadServices) {
  const grant = { memberId: "member", identity, clientId: "github-copilot", scopes };
  return createMcpHandler(() => createAdminMcpServer({
    grant, allowedEmails: [identity.email], now: () => 1_800_000_010,
    findMember: async () => active.value ? { memberId: "member", ...identity, active: true } : null, services,
  }), { route: "/mcp", authContext: { props: { ...grant, scopes: [...scopes] } } });
}

async function request(current: ReturnType<typeof handler>, method: string, params: Record<string, unknown>) {
  const headers = new Headers({ Accept: "application/json, text/event-stream", "Content-Type": "application/json", Host: "localhost", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method });
  if (method === "tools/call" && typeof params.name === "string") headers.set("Mcp-Name", params.name);
  return current.fetch(new Request("https://localhost/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params: { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "unidocs-test", version: "1.0.0" }, [CLIENT_CAPABILITIES_META_KEY]: {} } } }) }));
}

test("lists and calls whoami with current member identity", async () => {
  const current = handler(["admin:read"]);
  const listed = await (await request(current, "tools/list", {})).json() as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } };
  expect(listed.result.tools).toEqual([expect.objectContaining({ name: "whoami", annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }) })]);
  const called = await (await request(current, "tools/call", { name: "whoami", arguments: {} })).json() as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
  expect(called.result.isError).not.toBe(true);
  expect(called.result.structuredContent).toEqual({ memberId: "member", identity: { issuer: identity.issuer, subject: identity.subject, email: identity.email }, scopes: ["admin:read"], oauthClientHandle: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

test("whoami rechecks scope and active membership on every call", async () => {
  const missingScope = await (await request(handler([]), "tools/call", { name: "whoami", arguments: {} })).json() as { result: { isError?: boolean } };
  expect(missingScope.result.isError).toBe(true);
  const active = { value: true };
  const current = handler(["admin:read"], active);
  expect(((await (await request(current, "tools/call", { name: "whoami", arguments: {} })).json()) as { result: { isError?: boolean } }).result.isError).not.toBe(true);
  active.value = false;
  expect(((await (await request(current, "tools/call", { name: "whoami", arguments: {} })).json()) as { result: { isError?: boolean } }).result.isError).toBe(true);
});

test("publishes and maps the complete read-only tool catalog", async () => {
  const calls: Array<{ name: string; input: unknown[]; toolName: string | undefined }> = [];
  const operation = (name: string) => vi.fn(async (admin: { caller?: { toolName?: string } }, ...input: unknown[]) => {
    calls.push({ name, input, toolName: admin.caller?.toolName });
    return { operation: name, input };
  });
  const services = {
    documentTypes: { list: operation("list_document_types"), get: operation("get_document_type") },
    documentContracts: { list: operation("list_document_contracts"), get: operation("get_document_contract") },
    typeCardBundles: { list: operation("list_type_card_bundles"), get: operation("get_type_card_bundle") },
    viewBundles: { list: operation("list_view_bundles"), get: operation("get_view_bundle") },
    operatorValidations: { get: operation("get_operator_validation") },
    operators: { list: operation("list_operators"), get: operation("get_operator") },
    administrators: { list: operation("list_administrators"), get: operation("get_administrator") },
    auditEvents: { list: operation("list_admin_audit_events") },
  } as unknown as AdminMcpReadServices;
  const current = handler(["admin:read"], { value: true }, services);
  const listed = await (await request(current, "tools/list", {})).json() as { result: { tools: Array<{ name: string }> } };
  expect(listed.result.tools.map(tool => tool.name)).toEqual([
    "whoami", "list_document_types", "get_document_type", "list_document_contracts", "get_document_contract",
    "list_type_card_bundles", "get_type_card_bundle", "list_view_bundles", "get_view_bundle", "get_operator_validation",
    "list_operators", "get_operator", "list_administrators", "get_administrator", "list_admin_audit_events",
  ]);
  const inputs: Array<[string, Record<string, unknown>, unknown[]]> = [
    ["list_document_types", { limit: 10 }, [{ limit: 10 }]],
    ["get_document_type", { documentType: "markdown" }, ["markdown"]],
    ["list_document_contracts", { documentType: "markdown", limit: 5 }, ["markdown", { limit: 5 }]],
    ["get_document_contract", { documentType: "markdown", documentContractIdx: 1 }, ["markdown", 1]],
    ["list_type_card_bundles", { documentType: "markdown" }, [{ documentType: "markdown" }]],
    ["get_type_card_bundle", { typeCardBundleId: "tb_id" }, ["tb_id"]],
    ["list_view_bundles", { documentType: "markdown" }, [{ documentType: "markdown" }]], ["get_view_bundle", { viewBundleId: "vb_id" }, ["vb_id"]],
    ["get_operator_validation", { validationId: "validation" }, ["validation"]],
    ["list_operators", { documentType: "markdown" }, [{ documentType: "markdown" }]], ["get_operator", { operatorId: "op_id" }, ["op_id"]],
    ["list_administrators", {}, [{}]], ["get_administrator", { adminId: "admin" }, ["admin"]],
    ["list_admin_audit_events", { callerChannel: "mcp" }, [{ callerChannel: "mcp" }]],
  ];
  for (const [name, argumentsValue, expectedInput] of inputs) {
    const response = await (await request(current, "tools/call", { name, arguments: argumentsValue })).json() as { result: { isError?: boolean; structuredContent: { operation: string } } };
    expect(response.result.isError, name).not.toBe(true);
    expect(response.result.structuredContent.operation).toBe(name);
    expect(calls.at(-1)).toEqual({ name, input: expectedInput, toolName: name });
  }
});

test("returns stable errors without leaking internal exceptions", async () => {
  const failure = vi.fn(async () => { throw new Error("private database response"); });
  const services = { documentTypes: { list: failure, get: failure } } as unknown as AdminMcpReadServices;
  const body = await (await request(handler(["admin:read"], { value: true }, services), "tools/call", { name: "list_document_types", arguments: {} })).json() as { result: { isError: boolean; content: Array<{ text: string }>; structuredContent: unknown } };
  expect(body.result).toMatchObject({ isError: true, structuredContent: { error: { code: "internal_error" } } });
  expect(JSON.stringify(body)).not.toContain("private database response");
});