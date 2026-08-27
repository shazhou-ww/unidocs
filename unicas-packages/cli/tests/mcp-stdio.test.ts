import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runMcpStdioServer } from "../src/mcp/stdio-server.js";
import { TokenStore } from "../src/store.js";
import { FAKE_RESOURCE, FakeServer } from "./helpers/fake-server.js";

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

async function seedTokens(): Promise<void> {
  await store.save({
    serverUrl: FAKE_RESOURCE,
    clientInformation: { client_id: "cli-client-1", token_endpoint_auth_method: "none" },
    tokens: { access_token: "access-seeded", refresh_token: "refresh-seeded", token_type: "Bearer" },
  });
}

async function startStdioServer(fetchImpl: typeof fetch): Promise<{ stdin: PassThrough; reader: LineReader; done: Promise<void> }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new StdioServerTransport(stdin as unknown as Readable, stdout as unknown as Writable);
  const serverPromise = runMcpStdioServer({ serverUrl: FAKE_RESOURCE, store, fetchImpl, transport, log: () => undefined });
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
  test("answers initialize, lists the 18 tools, and forwards tools/call to the remote", async () => {
    await seedTokens();
    const server = new FakeServer({
      toolResults: {
        whoami: {
          structuredContent: {
            identity: { identityIssuer: "https://accounts.google.com", subject: "alice" },
            memberships: [],
          },
        },
      },
    });
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
    expect(tools).toHaveLength(18);
    expect(tools[0]?.name).toBe("whoami");
    expect(tools.map((tool) => tool.name)).toContain("transition_issuer_key");

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
      identity: { subject: "alice" },
      memberships: [],
    });

    stdin.end();
    await done;

    const forwarded = server.requests.find(
      (request) => request.pathname === "/mcp" && (request.body as { method?: string })?.method === "tools/call",
    );
    expect(forwarded).toBeDefined();
    expect(forwarded?.authorization).toBe("Bearer access-seeded");
  });

  test("returns a tool error result when not logged in", async () => {
    const server = new FakeServer({ authChallengeCount: 1 });
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
