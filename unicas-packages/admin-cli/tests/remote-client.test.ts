import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CliError } from "../src/errors.js";
import { UnicasRemoteClient } from "../src/remote/client.js";
import { TokenStore } from "../src/store.js";
import type { PersistedSession } from "../src/store.js";
import { FAKE_ORIGIN, FAKE_RESOURCE, FakeServer } from "./helpers/fake-server.js";

let dir: string;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unicas-cli-remote-"));
  store = new TokenStore({ path: join(dir, "token.json") });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedSession(overrides: Partial<PersistedSession> = {}): Promise<void> {
  await store.save({
    serverUrl: FAKE_RESOURCE,
    clientInformation: { client_id: "cli-client-1", token_endpoint_auth_method: "none" },
    tokens: { access_token: "access-seeded", refresh_token: "refresh-seeded", token_type: "Bearer" },
    ...overrides,
  });
}

describe("UnicasRemoteClient", () => {
  test("calls a tool with the stored bearer token", async () => {
    await seedSession();
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
    const client = new UnicasRemoteClient({ serverUrl: FAKE_RESOURCE, store, fetchImpl: server.fetch });
    const result = await client.callTool("whoami", {});

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      identity: { identityIssuer: "https://accounts.google.com", subject: "alice" },
    });
    const mcpPosts = server.requests.filter((request) => request.pathname === "/mcp" && request.method === "POST");
    expect(mcpPosts.length).toBeGreaterThan(0);
    const toolCall = mcpPosts.find((request) => (request.body as { method?: string })?.method === "tools/call");
    expect(toolCall).toBeDefined();
    expect(toolCall?.authorization).toBe("Bearer access-seeded");
    await client.close();
  });

  test("refreshes the access token on a 401 and retries the request", async () => {
    await seedSession();
    const server = new FakeServer({
      authChallengeCount: 1,
      toolResults: { whoami: { structuredContent: { identity: { subject: "alice" }, memberships: [] } } },
    });
    const client = new UnicasRemoteClient({ serverUrl: FAKE_RESOURCE, store, fetchImpl: server.fetch });
    const result = await client.callTool("whoami", {});

    expect(result.isError).toBe(false);
    // The refreshed token was persisted.
    const session = await store.load();
    expect(session.tokens?.access_token).not.toBe("access-seeded");
    expect(session.tokens?.access_token).toContain("access-");
    expect(session.tokens?.refresh_token).not.toBe("refresh-seeded");

    const refresh = server.requests.find((request) => request.pathname === "/oauth/token");
    expect(refresh).toBeDefined();
    const refreshForm = new URLSearchParams(refresh?.rawBody ?? "");
    expect(refreshForm.get("grant_type")).toBe("refresh_token");
    expect(refreshForm.get("refresh_token")).toBe("refresh-seeded");

    // The retried tools/call used the new token.
    const toolCall = server.requests.find(
      (request) => request.pathname === "/mcp" && (request.body as { method?: string })?.method === "tools/call",
    );
    expect(toolCall?.authorization).toContain("Bearer access-");
    expect(toolCall?.authorization).not.toBe("Bearer access-seeded");
    await client.close();
  });

  test("surfaces NeedsLoginError as a CliError with exit code 2 when not logged in", async () => {
    const server = new FakeServer({ authChallengeCount: 1 });
    const client = new UnicasRemoteClient({ serverUrl: FAKE_RESOURCE, store, fetchImpl: server.fetch });
    await expect(client.callTool("whoami", {})).rejects.toMatchObject({
      name: "CliError",
      exitCode: 2,
      message: /unicas login/,
    });
    await client.close();
  });

  test("reports a server tool error without throwing", async () => {
    await seedSession();
    const server = new FakeServer({
      toolResults: {
        get_stack: {
          structuredContent: { error: "NOT_FOUND", message: "stack not found" },
          isError: true,
        },
      },
    });
    const client = new UnicasRemoteClient({ serverUrl: FAKE_RESOURCE, store, fetchImpl: server.fetch });
    const result = await client.callTool("get_stack", { stackId: "missing" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "NOT_FOUND" });
    await client.close();
  });

  test("maps a network failure to CliError", async () => {
    await seedSession();
    const failingFetch = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const client = new UnicasRemoteClient({ serverUrl: FAKE_RESOURCE, store, fetchImpl: failingFetch as typeof fetch });
    await expect(client.callTool("whoami", {})).rejects.toBeInstanceOf(CliError);
    await client.close();
  });
});
