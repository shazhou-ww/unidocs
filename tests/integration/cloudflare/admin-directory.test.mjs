import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { COMPATIBILITY_DATE } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const identity = email => ({ issuer: "https://accounts.google.com", subject: email, email, emailVerified: true });

test("workerd preserves one administrator, rolls back failed audit writes and restores command results", async () => {
  const built = await build({ absWorkingDir: root, entryPoints: [join(root, "tests/integration/cloudflare/admin-directory-probe.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "es2024" });
  const persistPath = await mkdtemp(join(tmpdir(), "workerd-admin-directory-"));
  const options = convertV4MiniflareOptions({
    host: "127.0.0.1", port: 0, log: new Log(LogLevel.WARN), resourcePersistencePath: persistPath,
    workers: [{
      name: "admin-directory-probe", modules: true, script: built.outputFiles[0].text,
      compatibilityDate: COMPATIBILITY_DATE, durableObjects: { PROBE: { className: "AdminDirectoryProbe", useSQLite: true } }
    }],
  });
  let runtime;
  const call = async body => {
    const response = await runtime.dispatchFetch("http://probe/", { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    runtime = new Miniflare(options); await runtime.ready;
    expect((await call({ action: "bind", identity: identity("alice@example.com") })).status).toBe(403);
    expect((await call({ action: "bootstrap", email: "alice@example.com" })).status).toBe(200);
    const alice = (await call({ action: "bind", identity: identity("alice@example.com") })).body;
    const actor = { ...identity(alice.email), adminId: alice.adminId };
    expect((await call({ action: "add", actor, email: "bob@example.com", key: "bob" })).status).toBe(200);
    const bob = (await call({ action: "bind", identity: identity("bob@example.com") })).body;
    const other = { ...identity(bob.email), adminId: bob.adminId };
    await call({ action: "fail-audit" });
    const removal = { action: "remove", actor, adminId: bob.adminId, revision: bob.revision, key: "remove-bob" };
    expect((await call(removal)).status).toBe(503);
    expect((await call({ action: "list", actor })).body).toHaveLength(2);
    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    expect((await call({ action: "list", actor })).body).toHaveLength(2);
    const outcomes = await Promise.all([call(removal), call({ action: "remove", actor: other, adminId: alice.adminId, revision: alice.revision, key: "remove-alice" })]);
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual([200, 403]);
    const winner = outcomes[0].status === 200 ? actor : other;
    const removed = outcomes[0].status === 200 ? other : actor;
    const successfulCommand = outcomes[0].status === 200 ? removal : { action: "remove", actor: other, adminId: alice.adminId, revision: alice.revision, key: "remove-alice" };
    expect((await call({ action: "list", actor: winner })).body).toHaveLength(1);
    expect((await call({ action: "list", actor: removed })).status).toBe(403);
    const firstResult = await call(successfulCommand);
    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    expect(await call(successfulCommand)).toEqual(firstResult);
    expect((await call({ action: "bootstrap", email: "new@example.com" })).status).toBe(409);
    const replacement = await call({ action: "add", actor: winner, email: removed.email, key: "replacement" });
    expect(replacement.body.adminId).not.toBe(removed.adminId);
    await call({ action: "bind", identity: identity(removed.email) });
    expect((await call({ action: "list", actor: removed })).status).toBe(403);
    const audit = (await call({ action: "audit", actor: winner })).body;
    expect(audit.filter(event => event.action === "administrator.removed")).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("emailVerified");
    const validation = await call({ action: "type-validate", actor: winner });
    expect(validation.status).toBe(200);
    expect((await call({ action: "type-list", actor: winner })).body).toEqual([]);
    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    const registration = { action: "type-register", actor: winner, validationId: validation.body.validationId, key: "register-type" };
    await call({ action: "fail-audit" });
    expect((await call(registration)).status).toBe(503);
    expect((await call({ action: "type-list", actor: winner })).body).toEqual([]);
    const registered = await call(registration);
    expect(registered.body).toMatchObject({ docType: "markdown", enabled: true, revision: 1 });
    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    expect(await call(registration)).toEqual(registered);
    expect((await call({ action: "type-list", actor: winner })).body).toEqual([registered.body]);
    expect((await call({ action: "type-list", actor: removed })).status).toBe(403);
    await call({ action: "fail-audit" });
    expect((await call({ action: "type-disable", actor: winner, key: "disable-type" })).status).toBe(503);
    expect((await call({ action: "type-list", actor: winner })).body[0].enabled).toBe(true);
    expect((await call({ action: "type-disable", actor: winner, key: "disable-type" })).body).toMatchObject({ enabled: false, revision: 2 });
  } finally {
    await runtime?.dispose();
    await rm(persistPath, { recursive: true, force: true });
  }
}, 60_000);