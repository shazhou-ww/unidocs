import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createContext } from "../src/commands/common.js";
import type { CliContext } from "../src/commands/common.js";
import { logoutCommand } from "../src/commands/logout.js";
import { membersCommand } from "../src/commands/members.js";
import { stacksCommand } from "../src/commands/stacks.js";
import { statusCommand } from "../src/commands/status.js";
import { whoamiCommand } from "../src/commands/whoami.js";
import { TokenStore } from "../src/store.js";
import { FAKE_RESOURCE, FakeServer } from "./helpers/fake-server.js";

let dir: string;
let ctx: CliContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unicas-cli-cmd-"));
  ctx = createContext(
    { UNICAS_CONFIG_DIR: dir, UNICAS_SERVER_URL: FAKE_RESOURCE },
    new FakeServer().fetch,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { writes, restore: () => spy.mockRestore() };
}

async function seedLoggedIn(store: TokenStore): Promise<void> {
  await store.save({
    serverUrl: FAKE_RESOURCE,
    clientInformation: { client_id: "cli-client-1", token_endpoint_auth_method: "none" },
    tokens: { access_token: "access-seeded", refresh_token: "refresh-seeded", token_type: "Bearer", scope: "control:read control:write control:security" },
  });
}

describe("command layer", () => {
  test("whoami prints the operator identity as JSON", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeServer({
      toolResults: {
        whoami: { structuredContent: { identity: { subject: "alice" }, memberships: [] } },
      },
    });
    ctx = createContext(
      { UNICAS_CONFIG_DIR: dir, UNICAS_SERVER_URL: FAKE_RESOURCE },
      server.fetch,
    );
    const { writes } = captureStdout();
    await whoamiCommand(ctx);
    const output = writes.join("");
    const parsed = JSON.parse(output) as { identity: { subject: string } };
    expect(parsed.identity.subject).toBe("alice");
  });

  test("whoami fails with exit code 2 when not logged in", async () => {
    await expect(whoamiCommand(ctx)).rejects.toMatchObject({
      name: "CliError",
      exitCode: 2,
      message: /unicas login/,
    });
  });

  test("status reports the local session without network traffic", async () => {
    await seedLoggedIn(ctx.store);
    const { writes } = captureStdout();
    await statusCommand(ctx);
    const status = JSON.parse(writes.join("")) as { loggedIn: boolean; scopes: string[] };
    expect(status.loggedIn).toBe(true);
    expect(status.scopes).toContain("control:write");
    expect(ctx.store.path).toContain(dir);
  });

  test("stacks create auto-generates an idempotency key", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeServer({
      toolResults: {
        create_stack: { structuredContent: { stackId: "cas_stack", displayName: "Ops", revision: 1, etag: '"1"' } },
      },
    });
    ctx = createContext(
      { UNICAS_CONFIG_DIR: dir, UNICAS_SERVER_URL: FAKE_RESOURCE },
      server.fetch,
    );
    const { writes } = captureStdout();
    await stacksCommand(ctx, "create", ["Ops"]);
    const parsed = JSON.parse(writes.join("")) as { stackId: string };
    expect(parsed.stackId).toBe("cas_stack");
    const call = server.requests.find(
      (request) => request.pathname === "/mcp" && (request.body as { method?: string })?.method === "tools/call",
    );
    const args = ((call?.body as { params?: { arguments?: Record<string, unknown> } })?.params?.arguments) ?? {};
    expect(args.displayName).toBe("Ops");
    expect(String(args.idempotencyKey)).toMatch(/^unicas-cli:/);
  });

  test("stacks update resolves the current ETag when none is passed", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeServer({
      toolResults: {
        get_stack: { structuredContent: { stackId: "cas_stack", revision: 2, etag: '"2"' } },
        update_stack: { structuredContent: { stackId: "cas_stack", displayName: "Renamed", revision: 3, etag: '"3"' } },
      },
    });
    ctx = createContext(
      { UNICAS_CONFIG_DIR: dir, UNICAS_SERVER_URL: FAKE_RESOURCE },
      server.fetch,
    );
    const { writes } = captureStdout();
    await stacksCommand(ctx, "update", ["cas_stack", "Renamed"]);
    const parsed = JSON.parse(writes.join("")) as { displayName: string };
    expect(parsed.displayName).toBe("Renamed");
    const calls = server.requests.filter(
      (request) => request.pathname === "/mcp" && (request.body as { method?: string })?.method === "tools/call",
    );
    expect(calls).toHaveLength(2);
    const updateCall = calls.find(
      (request) => (request.body as { params?: { name?: string } })?.params?.name === "update_stack",
    );
    const args = ((updateCall?.body as { params?: { arguments?: Record<string, unknown> } })?.params?.arguments) ?? {};
    expect(args.etag).toBe('"2"');
  });

  test("logout revokes the refresh token and clears the store", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeServer();
    ctx = createContext(
      { UNICAS_CONFIG_DIR: dir, UNICAS_SERVER_URL: FAKE_RESOURCE },
      server.fetch,
    );
    const { writes } = captureStdout();
    await logoutCommand(ctx);
    expect(writes.join("")).toMatch(/Revoked/);
    expect(await ctx.store.load()).toEqual({ serverUrl: "" });
    const revoke = server.requests.find((request) => request.pathname === "/oauth/token/revoke");
    expect(revoke).toBeDefined();
    const form = new URLSearchParams(revoke?.rawBody ?? "");
    expect(form.get("token")).toBe("refresh-seeded");
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("cli-client-1");
  });

  test("a non-TTY destructive command demands an explicit confirmation flag", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeServer();
    ctx = createContext(
      { UNICAS_CONFIG_DIR: dir, UNICAS_SERVER_URL: FAKE_RESOURCE },
      server.fetch,
    );
    // Non-TTY stdin: the confirm flag is required for member removal.
    await expect(
      membersCommand(ctx, "remove", [
        "cas_stack",
        "--identity-issuer",
        "https://accounts.google.com",
        "--subject",
        "bob",
        "--etag",
        '"1"',
      ]),
    ).rejects.toThrow(/confirm-subject/);
  });
});
