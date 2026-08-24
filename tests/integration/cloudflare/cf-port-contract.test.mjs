/**
 * Runs the cloud-neutral port contract (`runPortContract`) against the real
 * Cloudflare implementations in `packages/cloudflare-sdk/src/ports-cf.ts`.
 *
 * Until this file existed, the contract only ever ran against the in-memory
 * ports, so `DoDeltaLog.append`'s conditional insert — the single thing
 * standing between a stale `baseVersion` and a corrupt delta log — had zero
 * automated coverage.
 *
 * Shape: a probe Worker (`tests/integration/cloudflare/port-probe-worker.js`, bundled in-memory and
 * loaded as a Miniflare inline `script`) exposes the five ports over HTTP; the
 * proxies below implement the port interfaces by POSTing to it. See that file
 * for the wire protocol.
 *
 * Isolation, which the contract requires of every `factory()`:
 *   - Durable Object sqlite + KV: a fresh `X-Probe-Instance` per factory call
 *     routes to a brand new DO via `idFromName`.
 *   - D1 and R2 are per-Miniflare, not per-DO, so the factory also hits
 *     `/reset` to truncate them.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { afterAll, beforeAll } from "vitest";
import { COMPATIBILITY_DATE } from "../../../scripts/doc-types.mjs";
import { runPortContract } from "../../../packages/server-core/src/testing/port-contract.ts";
import { VersionConflictError } from "../../../packages/server-core/src/errors.ts";
import { DirectUnitOfWork } from "../../../packages/cloudflare-sdk/src/ports-cf.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROBE_WORKER = "unidocs-port-probe";
const BYTES_KEY = "$bytes";

// Fixed identity: the contract's DocIndex tests address the document as
// ("text", "doc-1") owned by "user-1", and D1DocIndex keys its writes off the
// identity it was constructed with. Isolation therefore rides on a separate
// header (X-Probe-Instance), not on the doc id.
const DOC_TYPE = "text";
const DOC_ID = "doc-1";
const USER_ID = "user-1";

let mf;
let instanceSeq = 0;

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeValue(value) {
  if (value instanceof Uint8Array) return { [BYTES_KEY]: toBase64(value) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, encodeValue(v)]),
    );
  }
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value !== null && typeof value === "object") {
    if (typeof value[BYTES_KEY] === "string") return fromBase64(value[BYTES_KEY]);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, decodeValue(v)]),
    );
  }
  return value;
}

async function bundleProbeWorker() {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [join(ROOT, "tests/integration/cloudflare/port-probe-worker.js")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    alias: {
      "@unidocs/core": join(ROOT, "packages/core/src/index.ts"),
      "@unidocs/cas": join(ROOT, "packages/cas/src/index.ts"),
      "@unidocs/server-core": join(ROOT, "packages/server-core/src/index.ts"),
    },
    logOverride: { "empty-import-meta": "silent" },
  });
  return result.outputFiles[0].text;
}

async function migrateSnapshotsDb() {
  const db = await mf.getD1Database("SNAPSHOTS_DB", PROBE_WORKER);
  const sql = await readFile(
    join(ROOT, "packages/cloudflare-gateway/migrations/0001_init.sql"),
    "utf8",
  );
  for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.exec(statement);
  }
}

/** One port method call: POST to the probe, revive errors as real classes. */
async function call(instance, port, method, args) {
  const res = await mf.dispatchFetch("http://probe/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Probe-Instance": instance,
      "X-Doc-Type": DOC_TYPE,
      "X-Doc-Id": DOC_ID,
      "X-User-Id": USER_ID,
    },
    body: JSON.stringify({ port, method, args: encodeValue(args) }),
  });
  const payload = await res.json();
  if (payload.ok) return decodeValue(payload.value);

  const { name, message, currentVersion, attempted } = payload.error;
  if (name === "VersionConflictError") {
    // Rebuilt as a genuine instance — the contract asserts the *type*, not
    // just the message.
    throw new VersionConflictError(currentVersion, attempted);
  }
  const err = new Error(message);
  err.name = name;
  throw err;
}

const PORT_METHODS = {
  deltas: [
    "append",
    "head",
    "since",
    "range",
    "remove",
    "latestSnapshotRef",
    "recordSnapshot",
    "countSince",
  ],
  snapshots: ["get", "put"],
  blobs: ["putIfAbsent", "get"],
  index: ["register", "touch", "recordSnapshot"],
  indexQuery: ["list", "snapshots"],
};

function makeCfPorts(instance) {
  const ports = {};
  for (const [port, methods] of Object.entries(PORT_METHODS)) {
    ports[port] = Object.fromEntries(
      methods.map((method) => [
        method,
        (...args) => call(instance, port, method, args),
      ]),
    );
  }
  // The real Cloudflare UnitOfWork, wrapping the same two proxied ports the
  // contract will drive. It runs the callback and nothing else — see
  // DirectUnitOfWork for why that is the strongest thing available here.
  ports.unitOfWork = new DirectUnitOfWork({
    deltas: ports.deltas,
    index: ports.index,
  });
  return ports;
}

beforeAll(async () => {
  const script = await bundleProbeWorker();

  mf = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      log: new Log(LogLevel.WARN),
      workers: [
        {
          name: PROBE_WORKER,
          modules: true,
          script,
          compatibilityDate: COMPATIBILITY_DATE,
          durableObjects: {
            PROBE: { className: "PortProbe", useSQLite: true },
          },
          d1Databases: { SNAPSHOTS_DB: "unidocs-snapshots" },
          r2Buckets: { CAS: "unidocs-cas" },
        },
      ],
    }),
  );

  await mf.ready;
  await migrateSnapshotsDb();
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

runPortContract(
  "cloudflare ports",
  async () => {
    const instance = `probe-${++instanceSeq}`;
    const res = await mf.dispatchFetch("http://probe/reset", { method: "POST" });
    if (!res.ok) throw new Error(`probe reset failed: ${res.status}`);
    await res.json();
    return makeCfPorts(instance);
  },
  // transactional: false — the delta log lives in a Durable Object's private
  // sqlite and the index lives in D1. Two physically separate services, no
  // shared transaction, nothing to roll back across them. This is structural,
  // not unimplemented: the contract's two rollback tests are skipped here and
  // every other test still has to pass. Azure's Postgres backend, where both
  // are tables in one database, passes them with `true`.
  {
    transactional: false,
    prepareConcurrency: async () => ({
      concurrentWriters: 2,
      how: "each port call is a separate fetch into the worker; no pool to warm",
    }),
  },
);
