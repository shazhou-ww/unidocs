import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { migrateControlSchema } from "@unicas/control-plane";
import { createMcpHandler } from "agents/mcp/server";
import { createControlPlaneMcpServer } from "../src/server.js";
import type { ControlPlaneMcpGrantProps } from "../src/server.js";

let miniflare: Miniflare;
let db: D1Database;

beforeEach(async () => {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "control-plane-mcp-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "control-plane-mcp-test-db" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "control-plane-mcp-test");
  await migrateControlSchema(db);
});

afterEach(async () => {
  await miniflare.dispose();
});

describe("control-plane MCP server", () => {
  test("lists the initial read tools and maps whoami to the OAuth identity", async () => {
    const handler = handlerFor(grant(["control:read"]));
    const listed = await mcpRequest(handler, "tools/list", {});
    expect(listed.status, await listed.clone().text()).toBe(200);
    const listBody = await listed.json() as {
      result: { tools: Array<{ name: string; annotations?: Record<string, boolean> }> };
    };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual([
      "whoami",
      "list_stacks",
      "get_stack",
      "list_members",
      "get_issuer",
      "list_issuer_keys",
      "list_ref_domains",
      "list_control_audit_events",
      "list_root_domain_refs",
      "list_root_domain_events",
      "create_stack",
      "update_stack",
      "create_ref_domain",
      "transition_ref_domain",
      "invite_member",
      "remove_member",
      "set_issuer",
      "create_issuer_key_challenge",
      "add_issuer_key",
      "transition_issuer_key",
    ]);
    expect(listBody.result.tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const called = await mcpRequest(handler, "tools/call", {
      name: "whoami",
      arguments: {},
    });
    expect(called.status, await called.clone().text()).toBe(200);
    const callBody = await called.json() as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(callBody.result.isError).not.toBe(true);
    expect(callBody.result.structuredContent).toMatchObject({
      identity: {
        identityIssuer: "https://accounts.google.com",
        subject: "alice-sub",
        displayName: "Alice",
        emailForDisplay: "alice@example.com",
      },
      memberships: [],
    });
  });

  test("returns a tool error without control:read", async () => {
    const response = await mcpRequest(handlerFor(grant([])), "tools/call", {
      name: "whoami",
      arguments: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("control:read");
  });

  test("keeps mutations disabled unless deployment policy explicitly enables them", async () => {
    const response = await mcpRequest(handlerFor(grant(["control:write"])), "tools/call", {
      name: "create_stack",
      arguments: { displayName: "Operations", idempotencyKey: "create-ops-1" },
    });
    const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("disabled by deployment policy");
  });

  test("creates idempotent stacks when write scope and mutation policy are both present", async () => {
    const handler = handlerFor(grant(["control:read", "control:write"]), { mutationsEnabled: true });
    const first = await callTool(handler, "create_stack", {
      displayName: "Operations",
      idempotencyKey: "create-ops-1",
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ displayName: "Operations", revision: 1, etag: '"1"' });

    const replay = await callTool(handler, "create_stack", {
      displayName: "Operations",
      idempotencyKey: "create-ops-1",
    });
    expect(replay.structuredContent).toMatchObject({
      stackId: first.structuredContent.stackId,
      revision: 1,
    });

    const audit = await callTool(handler, "list_control_audit_events", {
      stackId: first.structuredContent.stackId,
      limit: 10,
    });
    expect(audit.structuredContent).toMatchObject({
      items: [{
        action: "stack.created",
        caller: {
          channel: "mcp",
          oauthClientHandle: "a".repeat(64),
          toolName: "create_stack",
        },
      }],
    });
  });

  test("requires security scope for member invitations", async () => {
    const result = await callTool(
      handlerFor(grant(["control:write"]), { mutationsEnabled: true }),
      "invite_member",
      {
        stackId: "cas_stack",
        email: "bob@example.com",
        confirmEmail: "bob@example.com",
        idempotencyKey: "invite-bob-1",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("control:security");
  });

  test("guards ordinary lifecycle writes with confirmations and current ETags", async () => {
    const handler = handlerFor(grant(["control:write"]), { mutationsEnabled: true });
    const stack = await callTool(handler, "create_stack", {
      displayName: "Lifecycle",
      idempotencyKey: "create-lifecycle-1",
    });
    const stackId = String(stack.structuredContent.stackId);
    const domain = await callTool(handler, "create_ref_domain", {
      stackId,
      refDomain: "doc",
      idempotencyKey: "create-doc-domain-1",
    });

    const unconfirmed = await callTool(handler, "transition_ref_domain", {
      stackId,
      refDomain: "doc",
      status: "write_disabled",
      etag: domain.structuredContent.etag,
      confirmRefDomain: "other",
      confirmStatus: "write_disabled",
    });
    expect(unconfirmed).toMatchObject({
      isError: true,
      structuredContent: { error: "CONFIRMATION_REQUIRED" },
    });

    const transitioned = await callTool(handler, "transition_ref_domain", {
      stackId,
      refDomain: "doc",
      status: "write_disabled",
      etag: domain.structuredContent.etag,
      confirmRefDomain: "doc",
      confirmStatus: "write_disabled",
    });
    expect(transitioned.structuredContent).toMatchObject({ status: "write_disabled", revision: 2, etag: '"2"' });

    const staleUpdate = await callTool(handler, "update_stack", {
      stackId,
      displayName: "Changed",
      etag: '"0"',
    });
    expect(staleUpdate).toMatchObject({
      isError: true,
      structuredContent: { error: "REVISION_MISMATCH" },
    });
  });
});

function grant(scopes: readonly string[]): ControlPlaneMcpGrantProps {
  return {
    identityIssuer: "https://accounts.google.com",
    subject: "alice-sub",
    displayName: "Alice",
    emailForDisplay: "alice@example.com",
    scopes,
    oauthClientId: "github-copilot",
    oauthClientHandle: "a".repeat(64),
  };
}

function handlerFor(
  props: ControlPlaneMcpGrantProps,
  options: Parameters<typeof createControlPlaneMcpServer>[1] = {},
) {
  return createMcpHandler(
    () => createControlPlaneMcpServer(db, options),
    {
      route: "/mcp",
      authContext: { props },
    },
  );
}

function mcpRequest(
  handler: ReturnType<typeof createMcpHandler>,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  const meta = {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_INFO_META_KEY]: { name: "control-plane-mcp-test", version: "1.0.0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Host: "localhost",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  });
  if (method === "tools/call" && typeof params.name === "string") {
    headers.set("Mcp-Name", params.name);
  }
  return handler.fetch(new Request("https://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: { ...params, _meta: meta },
    }),
  }));
}

async function callTool(
  handler: ReturnType<typeof createMcpHandler>,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<{
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent: Record<string, unknown>;
}> {
  const response = await mcpRequest(handler, "tools/call", {
    name,
    arguments: argumentsValue,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json() as {
    result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };
  };
  return body.result;
}