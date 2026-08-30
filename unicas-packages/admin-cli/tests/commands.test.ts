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
import type { TokenStore } from "../src/store.js";
import { FAKE_ORIGIN, FakeAdminApi } from "./helpers/fake-server.js";

let dir: string;
let ctx: CliContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unicas-cli-cmd-"));
  ctx = createContext(
    { UNICAS_CONFIG_DIR: dir, UNICAS_ADMIN_URL: FAKE_ORIGIN },
    new FakeAdminApi().fetch,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { writes, restore: () => spy.mockRestore() };
}

async function seedLoggedIn(store: TokenStore): Promise<void> {
  await store.save({
    adminOrigin: FAKE_ORIGIN,
    cookie: "cas_admin_session=session-1",
    csrfToken: "cli-csrf-1",
    identity: { identityIssuer: "https://accounts.google.com", subject: "sub-1", displayName: "Alice", emailForDisplay: "alice@example.com" },
    savedAt: Date.now(),
  });
}

describe("command layer", () => {
  test("whoami prints the operator identity as JSON", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeAdminApi();
    ctx = createContext({ UNICAS_CONFIG_DIR: dir, UNICAS_ADMIN_URL: FAKE_ORIGIN }, server.fetch);
    const { writes } = captureStdout();
    await whoamiCommand(ctx);
    const parsed = JSON.parse(writes.join("")) as { identity: { subject: string } };
    expect(parsed.identity.subject).toBe("sub-1");
    expect(server.requests[0]!.cookie).toContain("cas_admin_session=");
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
    const status = JSON.parse(writes.join("")) as { loggedIn: boolean; identity: { subject: string } | null };
    expect(status.loggedIn).toBe(true);
    expect(status.identity?.subject).toBe("sub-1");
    expect(ctx.store.path).toContain(dir);
  });

  test("stacks create auto-generates an idempotency key", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeAdminApi();
    ctx = createContext({ UNICAS_CONFIG_DIR: dir, UNICAS_ADMIN_URL: FAKE_ORIGIN }, server.fetch);
    const { writes } = captureStdout();
    await stacksCommand(ctx, "create", ["Ops"]);
    const parsed = JSON.parse(writes.join("")) as { stackId: string; displayName: string };
    expect(parsed.stackId).toBe("cas_stack_new");
    expect(parsed.displayName).toBe("Ops");
    const create = server.requests.find((request) => request.method === "POST" && request.pathname === "/admin/stacks")!;
    expect((create.body as { displayName: string }).displayName).toBe("Ops");
    expect(server.requests.some((request) => request.pathname === "/admin/stacks" && request.method === "POST")).toBe(true);
  });

  test("stacks update resolves the current ETag when none is passed", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeAdminApi();
    ctx = createContext({ UNICAS_CONFIG_DIR: dir, UNICAS_ADMIN_URL: FAKE_ORIGIN }, server.fetch);
    const { writes } = captureStdout();
    await stacksCommand(ctx, "update", ["cas_stack_a", "Renamed"]);
    const parsed = JSON.parse(writes.join("")) as { displayName: string };
    expect(parsed.displayName).toBe("Renamed");
    const get = server.requests.find((request) => request.method === "GET" && request.pathname === "/admin/stacks/cas_stack_a")!;
    expect(get).toBeDefined();
    const patch = server.requests.find((request) => request.method === "PATCH")!;
    expect(patch.pathname).toBe("/admin/stacks/cas_stack_a");
    expect(patch.body).toMatchObject({ displayName: "Renamed" });
  });

  test("stacks update can change only the description", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeAdminApi();
    ctx = createContext({ UNICAS_CONFIG_DIR: dir, UNICAS_ADMIN_URL: FAKE_ORIGIN }, server.fetch);
    await stacksCommand(ctx, "update", ["cas_stack_a", "--description", "Production"]);
    const patch = server.requests.find((request) => request.method === "PATCH")!;
    expect(patch.body).toEqual({ description: "Production" });
  });

  test("logout ends the BFF session and clears the store", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeAdminApi();
    ctx = createContext({ UNICAS_CONFIG_DIR: dir, UNICAS_ADMIN_URL: FAKE_ORIGIN }, server.fetch);
    const { writes } = captureStdout();
    await logoutCommand(ctx);
    expect(writes.join("")).toMatch(/Ended the Unicas admin session/);
    expect(await ctx.store.load()).toEqual({ adminOrigin: "", cookie: "", csrfToken: "" });
    expect(server.requests.some((request) => request.pathname === "/admin/auth/logout" && request.method === "POST")).toBe(true);
  });

  test("a non-TTY destructive command demands an explicit confirmation flag", async () => {
    await seedLoggedIn(ctx.store);
    const server = new FakeAdminApi();
    ctx = createContext({ UNICAS_CONFIG_DIR: dir, UNICAS_ADMIN_URL: FAKE_ORIGIN }, server.fetch);
    await expect(
      membersCommand(ctx, "remove", [
        "cas_stack_a",
        "--identity-issuer",
        "https://accounts.google.com",
        "--subject",
        "bob",
        "--etag",
        '"rev-3"',
      ]),
    ).rejects.toThrow(/confirm-subject/);
  });
});
