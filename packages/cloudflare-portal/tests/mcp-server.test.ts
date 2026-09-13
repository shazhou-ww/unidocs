import { expect, test, vi } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createAdminMcpServer, type AdminMcpReadServices } from "../src/mcp/server.js";

const identity = { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: 1_800_000_000 };

function handler(scopes: readonly string[], active = { value: true }, services?: AdminMcpReadServices, policy?: Parameters<typeof createAdminMcpServer>[0]["policy"]) {
  const grant = { memberId: "member", identity, clientId: "github-copilot", scopes };
  return createMcpHandler(() => createAdminMcpServer({
    grant, allowedEmails: [identity.email], now: () => 1_800_000_010,
    findMember: async () => active.value ? { memberId: "member", ...identity, active: true } : null, services, policy,
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

test("registers and maps append_document_contract only when content mutations are enabled", async () => {
  const append = vi.fn(async (admin, documentType, body, key, requestId) => ({ admin, documentType, body, key, requestId }));
  const services = {
    documentContracts: { append, get: vi.fn(), list: vi.fn() },
  } as unknown as AdminMcpReadServices;
  const policy = { enabled: true, contentMutationsEnabled: true, publishMutationsEnabled: false, securityMutationsEnabled: false };
  const current = handler(["admin:read", "admin:content"], { value: true }, services, policy);
  const listed = await (await request(current, "tools/list", {})).json() as { result: { tools: Array<{ name: string }> } };
  expect(listed.result.tools.map(tool => tool.name)).toContain("append_document_contract");
  const input = {
    documentType: "markdown", idempotencyKey: "append-contract-1", formatVersion: 1,
    snapshot: { schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" } },
    location: { schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" } }, reason: "Add initial contract",
  };
  const called = await (await request(current, "tools/call", { name: "append_document_contract", arguments: input })).json() as { result: { isError?: boolean } };
  expect(called.result.isError).not.toBe(true);
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({ caller: expect.objectContaining({ toolName: "append_document_contract" }) }),
    "markdown", { formatVersion: 1, snapshot: input.snapshot, location: input.location, reason: input.reason },
    "append-contract-1", expect.any(String),
  );

  const readOnly = handler(["admin:read", "admin:content"], { value: true }, services);
  const readOnlyList = await (await request(readOnly, "tools/list", {})).json() as { result: { tools: Array<{ name: string }> } };
  expect(readOnlyList.result.tools.map(tool => tool.name)).not.toContain("append_document_contract");
  const missingScope = handler(["admin:read"], { value: true }, services, policy);
  const denied = await (await request(missingScope, "tools/call", { name: "append_document_contract", arguments: input })).json() as { result: { isError?: boolean } };
  expect(denied.result.isError).toBe(true);
});

test("maps bundle and Operator content mutations without deriving concurrency inputs", async () => {
  const mutation = () => vi.fn(async () => ({ ok: true }));
  const uploadTypeCard = mutation();
  const updateTypeCard = mutation();
  const uploadView = mutation();
  const updateView = mutation();
  const validateOperator = mutation();
  const createOperator = mutation();
  const updateOperator = mutation();
  const read = vi.fn(async () => ({ items: [], nextCursor: null }));
  const services = {
    documentTypes: { get: read, list: read }, documentContracts: { get: read, list: read },
    typeCardBundles: { get: read, list: read, upload: uploadTypeCard, updateMetadata: updateTypeCard },
    viewBundles: { get: read, list: read, upload: uploadView, updateMetadata: updateView },
    operatorValidations: { get: read, validate: validateOperator },
    operators: { get: read, list: read, create: createOperator, updateMetadata: updateOperator },
    administrators: { get: read, list: read }, auditEvents: { list: read },
  } as unknown as AdminMcpReadServices;
  const policy = { enabled: true, contentMutationsEnabled: true, publishMutationsEnabled: false, securityMutationsEnabled: false };
  const current = handler(["admin:read", "admin:content"], { value: true }, services, policy);
  const etag = `"sha256-${"a".repeat(43)}"`;
  const calls: Array<[string, Record<string, unknown>]> = [
    ["upload_type_card_bundle", { name: "Card", description: "Candidate", base64Zip: "UEs=", idempotencyKey: "upload-card-1" }],
    ["update_type_card_bundle_metadata", { typeCardBundleId: "tb_id", name: "Card 2", description: "Updated", etag, idempotencyKey: "update-card-1" }],
    ["upload_view_bundle", { name: "View", description: "Candidate", base64Zip: "UEs=", idempotencyKey: "upload-view-1" }],
    ["update_view_bundle_metadata", { viewBundleId: "vb_id", name: "View 2", description: "Updated", etag, idempotencyKey: "update-view-1" }],
    ["create_operator_validation", { baseUrl: "https://unidocs-markdown.shazhou.workers.dev", expectedDocumentType: "markdown", expectedConfigEtag: null, idempotencyKey: "validate-operator-1" }],
    ["create_operator", { validationId: "validation-1", name: "Markdown", description: "Built in", idempotencyKey: "create-operator-1" }],
    ["update_operator_metadata", { operatorId: "op_id", name: "Markdown 2", description: "Updated", etag, idempotencyKey: "update-operator-1" }],
  ];
  for (const [name, argumentsValue] of calls) {
    const response = await (await request(current, "tools/call", { name, arguments: argumentsValue })).json() as { result: { isError?: boolean } };
    expect(response.result.isError, name).not.toBe(true);
  }
  expect(uploadTypeCard).toHaveBeenCalledWith(expect.any(Object), { name: "Card", description: "Candidate" }, expect.any(ReadableStream), "upload-card-1", expect.any(String));
  expect(updateTypeCard).toHaveBeenCalledWith(expect.any(Object), "tb_id", { name: "Card 2", description: "Updated" }, "update-card-1", etag, expect.any(String));
  expect(uploadView).toHaveBeenCalledWith(expect.any(Object), { name: "View", description: "Candidate" }, expect.any(ReadableStream), "upload-view-1", expect.any(String));
  expect(updateView).toHaveBeenCalledWith(expect.any(Object), "vb_id", { name: "View 2", description: "Updated" }, "update-view-1", etag, expect.any(String));
  expect(validateOperator).toHaveBeenCalledWith(expect.any(Object), { baseUrl: "https://unidocs-markdown.shazhou.workers.dev", expectedDocumentType: "markdown", expectedConfigEtag: null }, "validate-operator-1", expect.any(String));
  expect(createOperator).toHaveBeenCalledWith(expect.any(Object), { validationId: "validation-1", name: "Markdown", description: "Built in" }, "create-operator-1", expect.any(String));
  expect(updateOperator).toHaveBeenCalledWith(expect.any(Object), "op_id", { name: "Markdown 2", description: "Updated" }, "update-operator-1", etag, expect.any(String));
});

test("maps publish and security tools behind independent switches with receipt-first confirmation", async () => {
  const createDocumentType = vi.fn(async () => ({ documentType: "dt-new", etag: "etag" }));
  const addAdministrator = vi.fn(async () => ({ adminId: "admin-new", etag: "etag" }));
  const replayUpdate = vi.fn(async (): Promise<{ documentType: string; etag: string } | null> => null);
  const updateDocumentType = vi.fn(async () => ({ documentType: "markdown", etag: "updated-etag" }));
  const replayRemove = vi.fn(async () => false);
  const removeAdministrator = vi.fn(async () => undefined);
  const read = vi.fn(async () => ({ items: [], nextCursor: null }));
  const etag = `"sha256-${"a".repeat(43)}"`;
  const getDocumentType = vi.fn(async () => ({ documentType: "markdown", internalName: "Markdown", enabled: false, latestDocumentContract: null, typeCardBundle: null, viewBundle: null, builtinOperator: null, updatedAt: "2026-09-13T00:00:00.000Z", etag }));
  const getAdministrator = vi.fn(async () => ({ adminId: "admin-old", email: "old@example.com", bound: true, addedBy: "member", addedAt: "2026-09-13T00:00:00.000Z", etag }));
  const services = {
    documentTypes: { get: getDocumentType, list: read, create: createDocumentType, replayUpdate, update: updateDocumentType },
    administrators: { get: getAdministrator, list: read, add: addAdministrator, replayRemove, remove: removeAdministrator },
  } as unknown as AdminMcpReadServices;
  const policy = { enabled: true, contentMutationsEnabled: false, publishMutationsEnabled: true, securityMutationsEnabled: true };
  const current = handler(["admin:read", "admin:publish", "admin:security"], { value: true }, services, policy);
  const listed = await (await request(current, "tools/list", {})).json() as { result: { tools: Array<{ name: string }> } };
  expect(listed.result.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["create_document_type", "update_document_type", "add_administrator", "remove_administrator"]));

  const created = await (await request(current, "tools/call", { name: "create_document_type", arguments: { internalName: "Draft", idempotencyKey: "create-draft-1" } })).json() as { result: { isError?: boolean } };
  expect(created.result.isError).not.toBe(true);
  expect(createDocumentType).toHaveBeenCalledWith(expect.objectContaining({ caller: expect.objectContaining({ toolName: "create_document_type" }) }), { internalName: "Draft" }, "create-draft-1", expect.any(String));

  const added = await (await request(current, "tools/call", { name: "add_administrator", arguments: { email: "new@example.com", confirmEmail: "new@example.com", idempotencyKey: "add-admin-1" } })).json() as { result: { isError?: boolean } };
  expect(added.result.isError).not.toBe(true);
  expect(addAdministrator).toHaveBeenCalledWith(expect.objectContaining({ caller: expect.objectContaining({ toolName: "add_administrator" }) }), { email: "new@example.com" }, "add-admin-1", expect.any(String));

  const updated = await (await request(current, "tools/call", { name: "update_document_type", arguments: { documentType: "markdown", internalName: "Markdown 2", etag, idempotencyKey: "update-draft-1" } })).json() as { result: { isError?: boolean } };
  expect(updated.result.isError).not.toBe(true);
  expect(replayUpdate).toHaveBeenCalledWith(expect.any(Object), "markdown", { internalName: "Markdown 2" }, "update-draft-1", etag);
  expect(updateDocumentType).toHaveBeenCalledWith(expect.objectContaining({ caller: expect.objectContaining({ toolName: "update_document_type" }) }), "markdown", { internalName: "Markdown 2" }, "update-draft-1", etag, expect.any(String));

  const removed = await (await request(current, "tools/call", { name: "remove_administrator", arguments: { adminId: "admin-old", confirmAdminId: "admin-old", confirmEmail: "old@example.com", etag, idempotencyKey: "remove-admin-1" } })).json() as { result: { isError?: boolean } };
  expect(removed.result.isError).not.toBe(true);
  expect(replayRemove).toHaveBeenCalledWith(expect.any(Object), "admin-old", "remove-admin-1", etag);
  expect(removeAdministrator).toHaveBeenCalledWith(expect.objectContaining({ caller: expect.objectContaining({ toolName: "remove_administrator" }) }), "admin-old", "remove-admin-1", etag, expect.any(String));

  replayUpdate.mockResolvedValueOnce({ documentType: "markdown", etag: "replayed-etag" });
  replayRemove.mockResolvedValueOnce(true);
  getDocumentType.mockClear();
  getAdministrator.mockClear();
  await request(current, "tools/call", { name: "update_document_type", arguments: { documentType: "markdown", internalName: "Markdown 2", etag, idempotencyKey: "update-draft-1" } });
  await request(current, "tools/call", { name: "remove_administrator", arguments: { adminId: "admin-old", confirmAdminId: "admin-old", confirmEmail: "old@example.com", etag, idempotencyKey: "remove-admin-1" } });
  expect(getDocumentType).not.toHaveBeenCalled();
  expect(getAdministrator).not.toHaveBeenCalled();

  replayUpdate.mockResolvedValueOnce(null);
  replayRemove.mockResolvedValueOnce(false);
  updateDocumentType.mockClear();
  removeAdministrator.mockClear();
  const staleUpdate = await (await request(current, "tools/call", { name: "update_document_type", arguments: { documentType: "markdown", internalName: "Markdown 3", etag: `"sha256-${"b".repeat(43)}"`, idempotencyKey: "update-draft-2" } })).json() as { result: { structuredContent: { error?: { code: string } } } };
  const wrongRemoval = await (await request(current, "tools/call", { name: "remove_administrator", arguments: { adminId: "admin-old", confirmAdminId: "admin-old", confirmEmail: "wrong@example.com", etag, idempotencyKey: "remove-admin-2" } })).json() as { result: { structuredContent: { error?: { code: string } } } };
  expect(staleUpdate.result.structuredContent.error?.code).toBe("precondition_failed");
  expect(wrongRemoval.result.structuredContent.error?.code).toBe("invalid_request");
  expect(updateDocumentType).not.toHaveBeenCalled();
  expect(removeAdministrator).not.toHaveBeenCalled();
});

test("returns stable administrator safety errors", async () => {
  const cannotRemoveSelf = Object.assign(new Error("private detail"), { code: "cannot_remove_self" });
  const services = {
    administrators: {
      get: vi.fn(), list: vi.fn(), replayRemove: vi.fn(async () => { throw cannotRemoveSelf; }), remove: vi.fn(),
    },
  } as unknown as AdminMcpReadServices;
  const policy = { enabled: true, contentMutationsEnabled: false, publishMutationsEnabled: false, securityMutationsEnabled: true };
  const etag = `"sha256-${"a".repeat(43)}"`;
  const response = await (await request(handler(["admin:security"], { value: true }, services, policy), "tools/call", {
    name: "remove_administrator", arguments: { adminId: "member", confirmAdminId: "member", confirmEmail: "admin@example.com", etag, idempotencyKey: "remove-self-1" },
  })).json() as { result: { content: Array<{ text: string }>; structuredContent: { error: { code: string } } } };
  expect(response.result.structuredContent.error.code).toBe("cannot_remove_self");
  expect(JSON.stringify(response)).not.toContain("private detail");
});