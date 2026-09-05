import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runMcpStdioServer } from "../src/mcp/stdio-server.js";
import { TokenStore } from "../src/store.js";
import { FAKE_ORIGIN, FakeAdminApi } from "./helpers/fake-server.js";

interface LineReader {
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  all(): string[];
}

let dir: string;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unicas-cli-mcp-"));
  store = new TokenStore({ path: join(dir, "token.json") });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedSession(): Promise<void> {
  await store.save({
    adminOrigin: FAKE_ORIGIN,
    cookie: "cas_admin_session=session-1",
    csrfToken: "cli-csrf-1",
  });
}

async function startStdioServer(fetchImpl: typeof fetch): Promise<{ stdin: PassThrough; reader: LineReader; done: Promise<void> }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new StdioServerTransport(stdin as unknown as Readable, stdout as unknown as Writable);
  const serverPromise = runMcpStdioServer({ adminOrigin: FAKE_ORIGIN, store, fetchImpl, transport, log: () => undefined });
  const lines: string[] = [];
  const waiters: Array<(line: Record<string, unknown>) => void> = [];
  stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      lines.push(trimmed);
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const waiter = waiters.shift();
      waiter?.(parsed);
    }
  });
  const reader: LineReader = {
    next: (timeoutMs = 5_000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for an MCP message")), timeoutMs);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    }),
    all: () => [...lines],
  };
  const done = serverPromise.then(() => undefined);
  return { stdin, reader, done };
}

describe("unicas mcp (stdio server)", () => {
  test("answers initialize, lists the tool contract, and serves tools/call from the admin client", async () => {
    await seedSession();
    const server = new FakeAdminApi();
    const { stdin, reader, done } = await startStdioServer(server.fetch);

    stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    })}\n`);

    const initialize = await reader.next();
    expect(initialize.id).toBe(1);
    const result = initialize.result as { protocolVersion?: string; serverInfo?: { name?: string } };
    expect(typeof result.protocolVersion).toBe("string");
    expect(result.serverInfo?.name).toBe("unicas-control-plane-cli");

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

    const toolsList = await reader.next();
    expect(toolsList.id).toBe(2);
    const tools = (toolsList.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(15);
    expect(tools[0]?.name).toBe("whoami");
    expect(tools.map((tool) => tool.name)).toContain("get_oauth_issuer");
    expect(tools.map((tool) => tool.name)).not.toContain("add_issuer_key");

    stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    })}\n`);

    const call = await reader.next();
    expect(call.id).toBe(3);
    const callResult = call.result as {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(callResult.isError).toBe(false);
    expect(callResult.structuredContent).toMatchObject({
      identity: { subject: "sub-1" },
    });
    expect(callResult.structuredContent.memberships).toHaveLength(1);

    stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "invite_member",
        arguments: {
          stackId: "cas_stack_a",
          email: "alice@example.com",
          confirmEmail: "mallory@example.com",
          idempotencyKey: "invite-1",
        },
      },
    })}\n`);
    const rejected = await reader.next();
    expect(rejected.id).toBe(4);
    expect(rejected.result).toMatchObject({
      isError: true,
      structuredContent: { message: "confirmEmail must exactly match the invited email" },
    });
    expect(server.requests.some((request) => request.pathname.endsWith("/member-invitations"))).toBe(false);

    stdin.end();
    await done;

    const me = server.requests.find((request) => request.pathname === "/admin/me");
    expect(me).toBeDefined();
    expect(me?.cookie).toContain("cas_admin_session=");
  });

  test("returns a tool error result when not logged in", async () => {
    const server = new FakeAdminApi();
    const { stdin, reader, done } = await startStdioServer(server.fetch);

    stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    })}\n`);
    await reader.next();
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } })}\n`);

    const call = await reader.next();
    const callResult = call.result as { isError?: boolean; structuredContent?: { message?: string } };
    expect(callResult.isError).toBe(true);
    expect(callResult.structuredContent?.message).toMatch(/unicas login/);

    stdin.end();
    await done;
  });
});
