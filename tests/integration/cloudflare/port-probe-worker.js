/**
 * Test-only probe Worker: exposes the Cloudflare storage-port implementations
 * (`packages/cloudflare-sdk/src/ports-cf.ts`) over HTTP so that the
 * cloud-neutral `runPortContract` suite — which runs in Node — can drive the
 * real Durable Object / D1 / R2 code paths inside workerd.
 *
 * This file is NEVER deployed and is deliberately absent from
 * `bundleTargets()` in `scripts/doc-types.mjs`. `tests/integration/cloudflare/cf-port-contract.test.mjs`
 * bundles it in-memory with esbuild and hands the text to Miniflare as an
 * inline `script`, the same trick `CAS_FAULT_SCRIPT` uses.
 *
 * ## Wire protocol
 *
 * `POST /call`
 *   headers:
 *     X-Probe-Instance  routes to a Durable Object via `idFromName` — a fresh
 *                       value means a virgin sqlite + KV state. This is
 *                       SEPARATE from X-Doc-Id on purpose: the contract pins
 *                       the document identity it indexes under ("doc-1"), so
 *                       identity cannot double as the isolation key.
 *     X-Doc-Type / X-Doc-Id / X-User-Id
 *                       the `DocIdentity` handed to D1DocIndex.
 *   body: { port, method, args }   port ∈ deltas|snapshots|blobs|index|indexQuery
 *   → 200 { ok: true, value }
 *   → 200 { ok: false, error: { name, message, currentVersion, attempted } }
 *
 * `POST /reset`
 *   Truncates the shared, per-Miniflare-instance state that a fresh Durable
 *   Object id does NOT isolate: the D1 `docs` / `snapshots` tables and the R2
 *   bucket. Called once per `factory()`.
 *
 * `Uint8Array` cannot survive JSON, so bytes travel in both directions as
 * `{ "$bytes": "<base64>" }` (see encodeValue / decodeValue).
 *
 * VersionConflictError must survive the HTTP hop as a *type*, because the
 * contract asserts `rejects.toThrow(VersionConflictError)`. The DO side flattens
 * it to `{ name, currentVersion, attempted }`; the proxy in the test file
 * reconstructs a genuine instance from that.
 */

import {
  D1DocIndex,
  D1DocIndexQuery,
  DoDeltaLog,
  DoSnapshotCache,
  R2BlobCas,
} from "../../../packages/cloudflare-sdk/src/ports-cf.ts";

const BYTES_KEY = "$bytes";

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
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeValue(v);
    return out;
  }
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value !== null && typeof value === "object") {
    if (typeof value[BYTES_KEY] === "string") return fromBase64(value[BYTES_KEY]);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v);
    return out;
  }
  return value;
}

export class PortProbe {
  #ctx;
  #env;

  constructor(ctx, env) {
    this.#ctx = ctx;
    this.#env = env;
  }

  async fetch(request) {
    const identity = {
      docType: request.headers.get("X-Doc-Type") ?? "",
      docId: request.headers.get("X-Doc-Id") ?? "",
      userId: request.headers.get("X-User-Id") ?? "",
    };
    const { port, method, args } = await request.json();

    // The editor DO does this in `#ensureLoaded`; idempotent, so no need to
    // remember whether we already did it for this instance.
    DoDeltaLog.ensureTables(this.#ctx);

    const ports = {
      deltas: new DoDeltaLog(this.#ctx),
      snapshots: new DoSnapshotCache(this.#ctx),
      blobs: new R2BlobCas(this.#env.CAS),
      index: new D1DocIndex(this.#env.SNAPSHOTS_DB, identity),
      indexQuery: new D1DocIndexQuery(this.#env.SNAPSHOTS_DB),
    };

    const target = ports[port];
    if (!target || typeof target[method] !== "function") {
      return Response.json(
        { ok: false, error: { name: "Error", message: `no such port method: ${port}.${method}` } },
        { status: 400 },
      );
    }

    try {
      const value = await target[method](...decodeValue(args ?? []));
      return Response.json({ ok: true, value: encodeValue(value) });
    } catch (err) {
      return Response.json({
        ok: false,
        error: {
          name: err?.name ?? "Error",
          message: String(err?.message ?? err),
          // Present only on VersionConflictError; JSON drops the undefineds.
          currentVersion: err?.currentVersion,
          attempted: err?.attempted,
        },
      });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/reset") {
      await env.SNAPSHOTS_DB.prepare("DELETE FROM docs").run();
      await env.SNAPSHOTS_DB.prepare("DELETE FROM snapshots").run();
      const listed = await env.CAS.list();
      await Promise.all(listed.objects.map((obj) => env.CAS.delete(obj.key)));
      return Response.json({ ok: true });
    }

    const instance = request.headers.get("X-Probe-Instance");
    if (!instance) {
      return Response.json({ ok: false, error: { name: "Error", message: "missing X-Probe-Instance" } }, { status: 400 });
    }
    const stub = env.PROBE.get(env.PROBE.idFromName(instance));
    return stub.fetch(request);
  },
};
