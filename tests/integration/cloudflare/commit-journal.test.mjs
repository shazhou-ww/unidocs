import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { COMPATIBILITY_DATE } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("workerd atomically settles journal receipts and recovers pending and terminal records across restarts", async () => {
  const built = await build({
    absWorkingDir: root,
    entryPoints: [join(root, "tests/integration/cloudflare/commit-journal-probe.ts")],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    alias: {
      "@unidocs/protocol": join(root, "packages/protocol/src/index.ts"),
      "@unicas/codec": join(root, "unicas-packages/codec/src/index.ts"),
      "@unidocs/protocol-doc": join(root, "packages/protocol-doc/src/index.ts"),
      "@unidocs/svalue-codec/internal": join(root, "packages/svalue-codec/src/internal.ts"),
      "@unidocs/svalue-codec": join(root, "packages/svalue-codec/src/index.ts"),
      "@unidocs/doctype-server-common": join(root, "packages/doctype-server-common/src/index.ts"),
    },
    logOverride: { "empty-import-meta": "silent" },
  });
  const persistPath = await mkdtemp(join(tmpdir(), "workerd-commit-journal-"));
  const options = convertV4MiniflareOptions({
    host: "127.0.0.1", port: 0, log: new Log(LogLevel.WARN), resourcePersistencePath: persistPath,
    workers: [{ name: "commit-journal-probe", modules: true, script: built.outputFiles[0].text,
      compatibilityDate: COMPATIBILITY_DATE, durableObjects: { PROBE: { className: "CommitJournalProbe", useSQLite: true } } }],
  });
  let runtime;
  const call = async body => {
    const response = await runtime.dispatchFetch("http://probe/", { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const candidate = { action: "begin", opId: "op-1", payload: {
    baseVersion: 1, description: "local commit test", operations: [{ kind: "setContent", payload: { content: "# Original" } }],
  } };
  try {
    runtime = new Miniflare(options); await runtime.ready;
    const first = await call(candidate);
    expect(first.status).toBe(200); expect(first.body.state).toBe("pending");
    expect(await call(candidate)).toEqual(first);
    expect((await call({ ...candidate, payload: { ...candidate.payload, description: "different" } })).body.error).toBe("payload_mismatch");
    expect((await call({ ...candidate, opId: "op-2" })).body.error).toBe("pending_exists");
    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    expect((await call({ action: "recover" })).body).toEqual({ receipt: first.body, payload: candidate.payload });
    const committed = { ...first.body, state: "committed", version: 2 };
    expect((await call({ action: "settle", receipt: committed, fail: true })).body.error).toBe("injected local failure");
    expect((await call({ action: "versions" })).body).toEqual([]);
    expect((await call({ action: "lookup", receipt: first.body })).body).toEqual(first.body);
    expect((await call({ action: "settle", receipt: committed })).body).toEqual(committed);
    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options); await runtime.ready;
    expect((await call(candidate)).body).toEqual(committed);
    expect((await call({ action: "settle", receipt: committed })).body).toEqual(committed);
    expect((await call({ action: "versions" })).body).toEqual([{ version: 2 }]);
    expect((await call({ action: "recover" })).body).toBeNull();
  } finally {
    await runtime?.dispose();
    await rm(persistPath, { recursive: true, force: true });
  }
}, 60_000);