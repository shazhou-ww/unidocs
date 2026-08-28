import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TokenStore } from "../src/store.js";
import type { PersistedSession } from "../src/store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unicas-cli-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TokenStore", () => {
  test("round-trips a session and writes a 0600 file", async () => {
    const path = join(dir, "token.json");
    const store = new TokenStore({ path });
    const session: PersistedSession = {
      serverUrl: "https://unicas.test/mcp",
      clientInformation: { client_id: "c1", token_endpoint_auth_method: "none" },
      tokens: { access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 900 },
    };
    await store.save(session);

    const loaded = await store.load();
    expect(loaded.serverUrl).toBe("https://unicas.test/mcp");
    expect(loaded.clientInformation).toEqual({ client_id: "c1", token_endpoint_auth_method: "none" });
    expect(loaded.tokens).toMatchObject({ access_token: "at", refresh_token: "rt" });
    expect(typeof loaded.savedAt).toBe("number");

    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("loads an empty session when the file is missing", async () => {
    const store = new TokenStore({ path: join(dir, "missing.json") });
    expect(await store.load()).toEqual({ serverUrl: "" });
  });

  test("loads an empty session when the file is corrupt", async () => {
    const path = join(dir, "token.json");
    await writeFile(path, "{ not json", "utf8");
    const store = new TokenStore({ path });
    expect(await store.load()).toEqual({ serverUrl: "" });
    // The corrupt file is preserved for manual recovery.
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  test("overwrites atomically and keeps savedAt fresh", async () => {
    const path = join(dir, "token.json");
    const store = new TokenStore({ path });
    await store.save({ serverUrl: "https://a.test/mcp", tokens: { access_token: "old", token_type: "Bearer" } });
    const first = await store.load();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save({ serverUrl: "https://a.test/mcp", tokens: { access_token: "new", token_type: "Bearer" } });
    const second = await store.load();
    expect(second.tokens?.access_token).toBe("new");
    expect((second.savedAt ?? 0) > (first.savedAt ?? 0)).toBe(true);
    expect(first.savedAt !== second.savedAt).toBe(true);
  });

  test("clear removes the file", async () => {
    const path = join(dir, "token.json");
    const store = new TokenStore({ path });
    await store.save({ serverUrl: "https://a.test/mcp" });
    await store.clear();
    await expect(store.load()).resolves.toEqual({ serverUrl: "" });
  });
});
