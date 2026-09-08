import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { COMPATIBILITY_DATE } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = value => value.repeat(64);

test("platform document DO atomically advances retained roots and preserves receipts across restart", async () => {
  const built = await build({
    absWorkingDir: root, entryPoints: [join(root, "tests/integration/cloudflare/platform-document-probe.ts")],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers"],
  });
  const persistence = await mkdtemp(join(tmpdir(), "platform-document-"));
  const options = convertV4MiniflareOptions({
    host: "127.0.0.1", port: 0, log: new Log(LogLevel.WARN), resourcePersistencePath: persistence,
    workers: [{ name: "platform-document", modules: true, script: built.outputFiles[0].text,
      compatibilityDate: COMPATIBILITY_DATE,
      durableObjects: { DOCUMENTS: { className: "PlatformDocument", useSQLite: true } } }],
  });
  let runtime;
  const call = async body => {
    const response = await runtime.dispatchFetch("http://platform-document/", { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const identity = { tenantId: "tenant-1", docId: "doc-1", docType: "markdown",
    ownerActorId: "actor-1", schemaVersion: "markdown/1" };
  const candidate = { operationId: "save-1", baseVersion: 1, stateHash: hash("b") };
  try {
    runtime = new Miniflare(options); await runtime.ready;
    const created = await call({ action: "create", identity, stateHash: hash("a"), at: 100 });
    expect(created).toEqual({ status: 200, body: { identity, head: { version: 1, stateHash: hash("a"), createdAt: 100 } } });
    expect(await call({ action: "create", identity, stateHash: hash("a"), at: 100 })).toEqual(created);
    expect((await call({ action: "create", identity: { ...identity, ownerActorId: "actor-2" }, stateHash: hash("a"), at: 100 })).status).toBe(409);
    expect(await call({ action: "status", operationId: "missing" })).toEqual({ status: 200,
      body: { operationId: "missing", state: "unknown", reason: "not_found" } });

    const begun = await Promise.all(Array.from({ length: 8 }, () => call({ action: "begin", candidate })));
    expect(new Set(begun.map(result => JSON.stringify(result)))).toHaveLength(1);
    expect(begun[0]).toMatchObject({ status: 200, body: { operationId: candidate.operationId,
      baseVersion: 1, state: "pending" } });
    expect((await call({ action: "begin", candidate: { ...candidate, stateHash: hash("c") } })).body.error)
      .toBe("operation_payload_conflict");

    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    expect(await call({ action: "status", operationId: candidate.operationId })).toEqual(begun[0]);
    expect((await call({ action: "pending", operationId: candidate.operationId })).body)
      .toEqual({ candidate, receipt: begun[0].body });
    const otherIdentity = { ...identity, docId: "doc-2" };
    await call({ action: "create", docId: "doc-2", identity: otherIdentity, stateHash: hash("a"), at: 100 });
    const other = await call({ action: "begin", docId: "doc-2", candidate });
    expect(other.body.requestDigest).not.toBe(begun[0].body.requestDigest);
    const committed = await call({ action: "commit", operationId: candidate.operationId, at: 200 });
    expect(committed).toMatchObject({ status: 200, body: { state: "committed", version: 2 } });
    expect(await call({ action: "commit", operationId: candidate.operationId, at: 999 })).toEqual(committed);
    expect(await call({ action: "read" })).toEqual({ status: 200,
      body: { identity, head: { version: 2, stateHash: candidate.stateHash, createdAt: 200 } } });
    expect((await call({ action: "begin", candidate: { operationId: "stale", baseVersion: 1, stateHash: hash("d") } })).body)
      .toMatchObject({ state: "rejected", reason: "version_conflict", headVersion: 2 });

    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    expect(await call({ action: "status", operationId: candidate.operationId })).toEqual(committed);
    expect((await call({ action: "read" })).body.head).toEqual({ version: 2, stateHash: candidate.stateHash, createdAt: 200 });
  } finally {
    await runtime?.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
}, 60_000);