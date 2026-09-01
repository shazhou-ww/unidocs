import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createControlPlaneMcpServer } from "../src/mcp/server.js";
import type { ControlPlaneMcpGrantProps } from "../src/mcp/server.js";
import { migrateControlSchema } from "../src/control-schema.js";
import { createControlPlaneOperations } from "../src/control-operations.js";

let miniflare: Miniflare;
let db: D1Database;

beforeEach(async () => {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "control-plane-mcp-server-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "control-plane-mcp-server-test-db" },
    }]
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "control-plane-mcp-server-test");
  await migrateControlSchema(db);
});
afterEach(async () => miniflare.dispose());

describe("adapter-hosted control-plane MCP server", () => {
  test("lists tools and maps whoami to the OAuth identity", async () => {
    const handler = handlerFor(grant(["control:read"]));
    const listed = await mcpRequest(handler, "tools/list", {});
    const body = await listed.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "whoami", "list_stacks", "get_stack", "list_members", "get_issuer",
      "list_issuer_keys", "list_ref_domains", "list_control_audit_events",
      "list_root_domain_refs", "list_root_domain_events", "create_stack",
      "update_stack", "invite_member", "remove_member", "set_issuer",
      "create_issuer_key_challenge", "add_issuer_key", "transition_issuer_key",
    ]);
    const whoami = await callTool(handler, "whoami", {});
    expect(whoami.structuredContent).toMatchObject({
      identity: { subject: "alice-sub", displayName: "Alice", emailForDisplay: "alice@example.com" },
      memberships: [],
    });
  });

  test("enforces read, write, security, and deployment-policy gates", async () => {
    expect((await callTool(handlerFor(grant([])), "whoami", {})).content[0]?.text).toContain("control:read");
    expect((await callTool(handlerFor(grant(["control:write"])), "create_stack", {
      displayName: "Operations", idempotencyKey: "create-ops-1",
    })).content[0]?.text).toContain("disabled by deployment policy");
    expect((await callTool(handlerFor(grant(["control:write"]), { mutationsEnabled: true }), "invite_member", {
      stackId: "cas_stack", email: "bob@example.com", confirmEmail: "bob@example.com", idempotencyKey: "invite-1",
    })).content[0]?.text).toContain("control:security");
  });

  test("creates idempotent stacks, records MCP audit attribution, and guards writes with ETags", async () => {
    const handler = handlerFor(grant(["control:read", "control:write"]), { mutationsEnabled: true });
    const first = await callTool(handler, "create_stack", { displayName: "Operations", idempotencyKey: "create-ops-1" });
    expect(first.structuredContent).toMatchObject({ displayName: "Operations", revision: 1, etag: '"1"' });
    const replay = await callTool(handler, "create_stack", { displayName: "Operations", idempotencyKey: "create-ops-1" });
    expect(replay.structuredContent.stackId).toBe(first.structuredContent.stackId);
    const stale = await callTool(handler, "update_stack", { stackId: first.structuredContent.stackId, description: "Production", etag: '"0"' });
    expect(stale).toMatchObject({ isError: true, structuredContent: { error: "REVISION_MISMATCH" } });
    const updated = await callTool(handler, "update_stack", { stackId: first.structuredContent.stackId, description: "Production", etag: '"1"' });
    expect(updated.structuredContent).toMatchObject({ description: "Production", revision: 2, etag: '"2"' });
    const audit = await callTool(handler, "list_control_audit_events", { stackId: first.structuredContent.stackId, limit: 10 });
    const items = audit.structuredContent.items as Array<Record<string, unknown>>;
    expect(items.find((item) => item.action === "stack.created")).toMatchObject({
      caller: {
        channel: "mcp", oauthClientHandle: "a".repeat(64), toolName: "create_stack",
      }
    });
  });

  test("invites, lists, and removes members through the extracted admin service", async () => {
    const handler = handlerFor(grant(["control:read", "control:write", "control:security"]), { mutationsEnabled: true });
    const stack = await callTool(handler, "create_stack", { displayName: "Members", idempotencyKey: "members-stack-1" });
    const stackId = String(stack.structuredContent.stackId);
    const invitation = await callTool(handler, "invite_member", {
      stackId,
      email: "bob@example.com",
      confirmEmail: "bob@example.com",
      idempotencyKey: "invite-bob-1",
    });
    const replay = await callTool(handler, "invite_member", {
      stackId,
      email: "bob@example.com",
      confirmEmail: "bob@example.com",
      idempotencyKey: "invite-bob-1",
    });
    expect(replay.structuredContent).toEqual(invitation.structuredContent);
    const acceptUrl = String(invitation.structuredContent.acceptUrl);
    const token = acceptUrl.split("/").pop()!;
    expect(await createControlPlaneOperations(db).acceptMemberInvitation({
      identity: { identityIssuer: "https://accounts.google.com", subject: "bob-sub" },
      profile: { displayName: "Bob", emailForDisplay: "bob@example.com" },
    }, { path: { token } })).toMatchObject({ subject: "bob-sub", displayName: "Bob" });
    const members = await callTool(handler, "list_members", { stackId, limit: 10 });
    expect(members.structuredContent.items).toEqual([
      expect.objectContaining({ subject: "alice-sub" }),
      expect.objectContaining({ subject: "bob-sub", displayName: "Bob", emailForDisplay: "bob@example.com" }),
    ]);
    const stale = await callTool(handler, "remove_member", {
      stackId,
      identityIssuer: "https://accounts.google.com",
      subject: "bob-sub",
      confirmSubject: "bob-sub",
      etag: '"0"',
    });
    expect(stale).toMatchObject({ isError: true, structuredContent: { error: "REVISION_MISMATCH" } });
    expect((await callTool(handler, "remove_member", {
      stackId,
      identityIssuer: "https://accounts.google.com",
      subject: "bob-sub",
      confirmSubject: "bob-sub",
      etag: '"1"',
    })).structuredContent).toEqual({ ok: true });
  });

  test("reads adapter-provided root-domain audit data", async () => {
    const auditReader = {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/_internal/audit/domains");
        return Response.json({ domains: [{ stackId: url.searchParams.get("stackId"), refDomain: "doc", revision: 2 }] });
      }
    };
    const handler = handlerFor(grant(["control:read", "control:write"]), { mutationsEnabled: true, auditReader });
    const stack = await callTool(handler, "create_stack", { displayName: "Audit", idempotencyKey: "create-audit-1" });
    expect((await callTool(handler, "list_ref_domains", { stackId: stack.structuredContent.stackId })).structuredContent)
      .toEqual({ domains: [{ stackId: stack.structuredContent.stackId, refDomain: "doc", revision: 2 }] });
  });
});

function grant(scopes: readonly string[]): ControlPlaneMcpGrantProps {
  return {
    identityIssuer: "https://accounts.google.com", subject: "alice-sub", displayName: "Alice",
    emailForDisplay: "alice@example.com", scopes, oauthClientId: "github-copilot", oauthClientHandle: "a".repeat(64),
  };
}
function handlerFor(props: ControlPlaneMcpGrantProps, options: Parameters<typeof createControlPlaneMcpServer>[1] = {}) {
  return createMcpHandler(
    () => createControlPlaneMcpServer(createControlPlaneOperations(db), options),
    { route: "/mcp", authContext: { props } },
  );
}
function mcpRequest(handler: ReturnType<typeof createMcpHandler>, method: string, params: Record<string, unknown>): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream", "Content-Type": "application/json", Host: "localhost",
    "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
  });
  if (method === "tools/call" && typeof params.name === "string") headers.set("Mcp-Name", params.name);
  return handler.fetch(new Request("https://localhost/mcp", {
    method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: crypto.randomUUID(), method, params: {
        ...params, _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "control-plane-mcp-test", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        }
      }
    }),
  }));
}
async function callTool(handler: ReturnType<typeof createMcpHandler>, name: string, argumentsValue: Record<string, unknown>): Promise<{
  isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown>;
}> {
  const response = await mcpRequest(handler, "tools/call", { name, arguments: argumentsValue });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown> } };
  return body.result;
}
