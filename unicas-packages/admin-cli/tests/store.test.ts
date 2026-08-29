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
    const path = join(dir, "session.json");
    const store = new TokenStore({ path });
    const session: PersistedSession = {
      adminOrigin: "https://unicas.test",
      cookie: "cas_admin_session=s1",
      csrfToken: "csrf-1",
      identity: { identityIssuer: "https://accounts.google.com", subject: "sub-1", displayName: "Alice", emailForDisplay: "alice@example.com" },
    };
    await store.save(session);

    const loaded = await store.load();
    expect(loaded.adminOrigin).toBe("https://unicas.test");
    expect(loaded.cookie).toBe("cas_admin_session=s1");
    expect(loaded.csrfToken).toBe("csrf-1");
    expect(loaded.identity?.subject).toBe("sub-1");
    expect(typeof loaded.savedAt).toBe("number");

    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("loads an empty session when the file is missing", async () => {
    const store = new TokenStore({ path: join(dir, "missing.json") });
    expect(await store.load()).toEqual({ adminOrigin: "", cookie: "", csrfToken: "" });
  });

  test("loads an empty session when the file is corrupt", async () => {
    const path = join(dir, "session.json");
    await writeFile(path, "{ not json", "utf8");
    const store = new TokenStore({ path });
    expect(await store.load()).toEqual({ adminOrigin: "", cookie: "", csrfToken: "" });
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  test("overwrites atomically and keeps savedAt fresh", async () => {
    const path = join(dir, "session.json");
    const store = new TokenStore({ path });
    await store.save({ adminOrigin: "https://a.test", cookie: "c1", csrfToken: "t1" });
    const first = await store.load();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save({ adminOrigin: "https://a.test", cookie: "c2", csrfToken: "t2" });
    const second = await store.load();
    expect(second.cookie).toBe("c2");
    expect((second.savedAt ?? 0) > (first.savedAt ?? 0)).toBe(true);
  });

  test("clear removes the file", async () => {
    const path = join(dir, "session.json");
    const store = new TokenStore({ path });
    await store.save({ adminOrigin: "https://a.test", cookie: "c1", csrfToken: "t1" });
    await store.clear();
    await expect(store.load()).resolves.toEqual({ adminOrigin: "", cookie: "", csrfToken: "" });
  });
});
