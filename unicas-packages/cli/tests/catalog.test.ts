import { describe, expect, test } from "vitest";
import { getToolDefinition, TOOL_CATALOG } from "../src/mcp/catalog.js";

/** The exact tool contract of the remote control-plane MCP server. */
const REMOTE_TOOL_NAMES = [
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
  "invite_member",
  "remove_member",
  "set_issuer",
  "create_issuer_key_challenge",
  "add_issuer_key",
  "transition_issuer_key",
];

describe("tool catalog", () => {
  test("exposes exactly the remote tool contract", () => {
    expect(TOOL_CATALOG.map((tool) => tool.name)).toEqual(REMOTE_TOOL_NAMES);
    expect(new Set(TOOL_CATALOG.map((tool) => tool.name)).size).toBe(TOOL_CATALOG.length);
  });

  test("every tool has a description, a zod input schema, and a known scope", () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(typeof tool.inputSchema.parse, tool.name).toBe("function");
      expect(["control:read", "control:write", "control:security"]).toContain(tool.requiredScope);
    }
  });

  test("creation tools are idempotent; destructive transitions are annotated", () => {
    expect(getToolDefinition("create_stack")?.annotations.idempotentHint).toBe(true);
    expect(getToolDefinition("invite_member")?.annotations.idempotentHint).toBe(true);
    expect(getToolDefinition("add_issuer_key")?.annotations.idempotentHint).toBe(true);
    expect(getToolDefinition("remove_member")?.annotations.destructiveHint).toBe(true);
    expect(getToolDefinition("set_issuer")?.annotations.destructiveHint).toBe(true);
    expect(getToolDefinition("transition_issuer_key")?.annotations.destructiveHint).toBe(true);
  });

  test("input schemas validate and reject bad arguments", () => {
    const getStack = getToolDefinition("get_stack");
    expect(getStack?.inputSchema.safeParse({ stackId: "cas_stack" }).success).toBe(true);
    expect(getStack?.inputSchema.safeParse({}).success).toBe(false);

    const createStack = getToolDefinition("create_stack");
    expect(createStack?.inputSchema.safeParse({ displayName: "Ops", idempotencyKey: "k1" }).success).toBe(true);
    expect(createStack?.inputSchema.safeParse({ displayName: "", idempotencyKey: "k1" }).success).toBe(false);

    const updateStack = getToolDefinition("update_stack");
    expect(updateStack?.inputSchema.safeParse({ stackId: "s", description: "Production", etag: '"1"' }).success).toBe(true);
    expect(updateStack?.inputSchema.safeParse({ stackId: "s", description: "x".repeat(2_001), etag: '"1"' }).success).toBe(false);

    const challenge = getToolDefinition("create_issuer_key_challenge");
    expect(challenge?.inputSchema.safeParse({ stackId: "s", kid: "k", algorithm: "EdDSA" }).success).toBe(true);
    expect(challenge?.inputSchema.safeParse({ stackId: "s", kid: "k", algorithm: "HS256" }).success).toBe(false);

    const transition = getToolDefinition("transition_issuer_key");
    expect(transition?.inputSchema.safeParse({
      stackId: "s",
      kid: "k",
      state: "revoked",
      etag: '"3"',
      confirmKid: "k",
      confirmState: "revoked",
    }).success).toBe(true);
  });
});
