import { describe, it, expect, vi } from "vitest";
import { DocSession } from "../src/doc-session.js";
import type { RenderLike } from "../src/doc-session.js";
import type { BlobStore, PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";

const canvas = { width: 4, height: 4, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

function docWithLayers(ids: string[]): PsdDoc {
  return {
    canvas,
    layers: ids.map((id) => ({
      id,
      type: "raster" as const,
      name: id,
      bounds: [0, 0, 1, 1] as [number, number, number, number],
      opacity: 1,
      blendMode: "normal" as const,
      visible: true,
      locked: false,
      clipping: false,
      pixels: { width: 1, height: 1, hash: `h-${id}` },
    })),
  };
}

function setOp(layerId: string, opacity: number): PsdOp {
  return { kind: "set_props", payload: { layerId, props: { opacity } } };
}

function irBytesFor(doc: PsdDoc): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

/** Memory BlobStore keyed by hash → IR bytes (mask/layer pixel blobs aren't
 *  exercised here — every layer's `pixels` is already a `{width,height,hash}`
 *  ref, so `deserialize` never calls `store.get` beyond the top-level IR). */
function memStore(blobs: Record<string, Uint8Array>): BlobStore {
  return {
    async get(hash) {
      return blobs[hash] ?? null;
    },
    async put() {
      throw new Error("memStore.put: not implemented");
    },
  };
}

function mockRender(): RenderLike & { applyOpCalls: PsdOp[]; resetCalls: PsdDoc[] } {
  const applyOpCalls: PsdOp[] = [];
  const resetCalls: PsdDoc[] = [];
  return {
    applyOpCalls,
    resetCalls,
    async applyOp(op) {
      applyOpCalls.push(op);
      return [0, 0, 1, 1];
    },
    async reset(doc) {
      resetCalls.push(doc);
    },
  };
}

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

type Scripted = { status: number; body?: unknown };

/** Mock fetch routing `.../apply` (POST) and `.../snapshot` (GET) against
 *  per-endpoint response queues, recording every call (method + parsed
 *  body) in order for assertion. */
function mockFetch(opts: { apply?: Scripted[]; snapshot?: Scripted[] }): { fn: typeof fetch; calls: FetchCall[] } {
  const applyQueue = [...(opts.apply ?? [])];
  const snapshotQueue = [...(opts.snapshot ?? [])];
  const calls: FetchCall[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    let scripted: Scripted | undefined;
    if (u.endsWith("/apply")) scripted = applyQueue.shift();
    else if (u.endsWith("/snapshot")) scripted = snapshotQueue.shift();
    if (!scripted) throw new Error(`mockFetch: no scripted response left for ${method} ${u}`);
    return {
      status: scripted.status,
      ok: scripted.status >= 200 && scripted.status < 300,
      json: async () => scripted.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const opts = (extra: Partial<{
  doc: PsdDoc;
  version: number;
  store: BlobStore;
  render: RenderLike;
  fetchImpl: typeof fetch;
  genId: () => string;
}>) => ({
  gw: "/gw",
  user: "u1",
  type: "psd",
  docId: "d1",
  doc: docWithLayers(["l1"]),
  version: 5,
  store: memStore({}),
  render: mockRender(),
  ...extra,
});

describe("DocSession.applyLocal", () => {
  it("advances the local doc, paints via render.applyOp, and background-POSTs with opId + baseVersion; 200 advances version", async () => {
    const render = mockRender();
    const { fn, calls } = mockFetch({ apply: [{ status: 200, body: { success: true, version: 6 } }] });
    const session = new DocSession(opts({ version: 5, render, fetchImpl: fn, genId: () => "op-1" }));

    const rect = await session.applyLocal(setOp("l1", 0.5));

    expect(rect).toEqual([0, 0, 1, 1]);
    expect(session.doc.layers[0]!.opacity).toBe(0.5);
    expect(render.applyOpCalls).toHaveLength(1);

    await vi.waitFor(() => expect(session.version).toBe(6));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("/gw/users/u1/docs/psd/d1/apply");
    expect(calls[0]!.body).toEqual({
      operations: [setOp("l1", 0.5)],
      baseVersion: 5,
      opId: "op-1",
    });
  });

  it("queues distinct ops (a real queue, not a single coalesced slot) — all three get POSTed in order", async () => {
    const render = mockRender();
    const { fn, calls } = mockFetch({
      apply: [
        { status: 200, body: { success: true, version: 6 } },
        { status: 200, body: { success: true, version: 7 } },
        { status: 200, body: { success: true, version: 8 } },
      ],
    });
    let n = 0;
    const session = new DocSession(opts({ version: 5, render, fetchImpl: fn, genId: () => `op-${++n}` }));

    const op1 = setOp("l1", 0.1);
    const op2 = setOp("l1", 0.2);
    const op3 = setOp("l1", 0.3);

    // All three fire before any background POST has a chance to settle —
    // must not drop or coalesce any of them.
    const p1 = session.applyLocal(op1);
    const p2 = session.applyLocal(op2);
    const p3 = session.applyLocal(op3);
    await Promise.all([p1, p2, p3]);

    expect(render.applyOpCalls).toEqual([op1, op2, op3]);

    await vi.waitFor(() => expect(session.version).toBe(8));
    const applyCalls = calls.filter((c) => c.url.endsWith("/apply"));
    expect(applyCalls).toHaveLength(3);
    expect(applyCalls.map((c) => (c.body as { operations: PsdOp[] }).operations[0])).toEqual([op1, op2, op3]);
    expect(applyCalls.map((c) => (c.body as { baseVersion: number }).baseVersion)).toEqual([5, 6, 7]);
    // Distinct ids for distinct ops.
    expect(new Set(applyCalls.map((c) => (c.body as { opId: string }).opId)).size).toBe(3);
  });
});

describe("DocSession rebase (409 and reconcile)", () => {
  it("409 on /apply triggers a rebase: fetches the new snapshot, replays pending, calls render.reset, updates version, then resubmits with the SAME opId", async () => {
    const render = mockRender();
    const newBase = docWithLayers(["l1"]);
    newBase.layers[0]!.opacity = 0.9; // someone else's server-side edit

    const { fn, calls } = mockFetch({
      apply: [
        { status: 409 },
        { status: 200, body: { success: true, version: 11 } },
      ],
      snapshot: [{ status: 200, body: { success: true, version: 10, hash: "h-new" } }],
    });
    const store = memStore({ "h-new": irBytesFor(newBase) });
    const session = new DocSession(opts({ version: 5, store, render, fetchImpl: fn, genId: () => "op-x" }));

    const op = setOp("l1", 0.5);
    await session.applyLocal(op);

    await vi.waitFor(() => expect(session.version).toBe(11));

    // Replayed op1 on top of the new base — l1 ends up at the op's value.
    expect(session.doc.layers[0]!.opacity).toBe(0.5);
    expect(render.resetCalls).toHaveLength(1);
    expect(render.resetCalls[0]!.layers[0]!.opacity).toBe(0.5);

    const applyCalls = calls.filter((c) => c.url.endsWith("/apply"));
    expect(applyCalls).toHaveLength(2);
    // Same opId on the retry after rebase — not a freshly generated one.
    expect((applyCalls[0]!.body as { opId: string }).opId).toBe("op-x");
    expect((applyCalls[1]!.body as { opId: string }).opId).toBe("op-x");
    // Resubmitted against the rebased version.
    expect((applyCalls[1]!.body as { baseVersion: number }).baseVersion).toBe(10);

    const snapshotCalls = calls.filter((c) => c.url.endsWith("/snapshot"));
    expect(snapshotCalls).toHaveLength(1);
  });

  it("reuses the SAME opId when a lost-ack forces a retry, rather than generating a fresh one", async () => {
    const render = mockRender();
    const newBase = docWithLayers(["l1"]);
    const { fn, calls } = mockFetch({
      apply: [
        { status: 409 }, // simulates a lost ack: server already has a newer baseVersion
        { status: 200, body: { success: true, version: 31 } },
      ],
      snapshot: [{ status: 200, body: { success: true, version: 30, hash: "h-retry" } }],
    });
    const store = memStore({ "h-retry": irBytesFor(newBase) });
    const idsGenerated: string[] = [];
    const session = new DocSession(
      opts({
        version: 5,
        store,
        render,
        fetchImpl: fn,
        genId: () => {
          const id = `retry-op-${idsGenerated.length}`;
          idsGenerated.push(id);
          return id;
        },
      }),
    );

    await session.applyLocal(setOp("l1", 0.7));
    await vi.waitFor(() => expect(session.version).toBe(31));

    // genId was called exactly once — applyLocal's original id is what
    // gets resubmitted, never a second freshly minted one.
    expect(idsGenerated).toHaveLength(1);
    const applyCalls = calls.filter((c) => c.url.endsWith("/apply"));
    expect(applyCalls).toHaveLength(2);
    expect((applyCalls[0]!.body as { opId: string }).opId).toBe(idsGenerated[0]);
    expect((applyCalls[1]!.body as { opId: string }).opId).toBe(idsGenerated[0]);
  });

  it("drops a pending op whose target layer is gone in the new base, keeps the others, and does not throw", async () => {
    const render = mockRender();
    const newBase = docWithLayers(["l1"]); // l2 was removed server-side
    const { fn, calls } = mockFetch({
      apply: [
        { status: 409 },
        { status: 200, body: { success: true, version: 21 } },
      ],
      snapshot: [{ status: 200, body: { success: true, version: 20, hash: "h-new2" } }],
    });
    const store = memStore({ "h-new2": irBytesFor(newBase) });
    let n = 0;
    const session = new DocSession(
      opts({ doc: docWithLayers(["l1", "l2"]), version: 5, store, render, fetchImpl: fn, genId: () => `op-${++n}` }),
    );

    const opA = setOp("l1", 0.4); // survives replay
    const opB = setOp("l2", 0.4); // l2 is gone from newBase — dropped
    const pA = session.applyLocal(opA);
    const pB = session.applyLocal(opB);
    await Promise.all([pA, pB]);

    await vi.waitFor(() => expect(session.version).toBe(21));

    // opB's target is gone — rebase didn't throw, opA survived and applied.
    expect(session.doc.layers.map((l) => l.id)).toEqual(["l1"]);
    expect(session.doc.layers[0]!.opacity).toBe(0.4);
    expect(render.resetCalls).toHaveLength(1);

    // Only opA got resubmitted after rebase (opB was dropped, never re-POSTed).
    const applyCalls = calls.filter((c) => c.url.endsWith("/apply"));
    expect(applyCalls).toHaveLength(2);
    expect((applyCalls[0]!.body as { operations: PsdOp[] }).operations[0]).toEqual(opA);
    expect((applyCalls[1]!.body as { operations: PsdOp[] }).operations[0]).toEqual(opA);
    expect((applyCalls[1]!.body as { opId: string }).opId).toBe((applyCalls[0]!.body as { opId: string }).opId);
  });
});

describe("DocSession concurrency", () => {
  it("does not lose ops or regress version when reconcile() races a parked /apply fetch", async () => {
    const render = mockRender();

    function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const opA = setOp("l1", 0.6); // in flight when the agent's snapshot lands
    const opB = setOp("l2", 0.6); // must survive the race, whatever happens to opA

    const applyADeferred = defer<Response>();
    const calls: FetchCall[] = [];
    const opBApplyQueue: Scripted[] = [{ status: 200, body: { success: true, version: 11 } }];
    const snapshotQueue: Scripted[] = [{ status: 200, body: { success: true, version: 10, hash: "h-new" } }];

    // Custom router (not the shared `mockFetch` helper): opA's /apply call
    // is parked on a manually-resolved deferred so the test controls
    // exactly when it settles relative to `reconcile()`.
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, method, body });
      if (u.endsWith("/apply")) {
        const target = (body.operations[0] as PsdOp).payload.layerId;
        if (target === "l1") return applyADeferred.promise;
        const r = opBApplyQueue.shift();
        if (!r) throw new Error("mock: no more opB /apply responses queued");
        return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as unknown as Response;
      }
      if (u.endsWith("/snapshot")) {
        const r = snapshotQueue.shift();
        if (!r) throw new Error("mock: no more /snapshot responses queued");
        return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as unknown as Response;
      }
      throw new Error(`mock: unexpected url ${u}`);
    }) as unknown as typeof fetch;

    const newBase = docWithLayers(["l2"]); // agent's /run deleted l1 while opA was in flight
    const store = memStore({ "h-new": irBytesFor(newBase) });
    let n = 0;
    const session = new DocSession(
      opts({ doc: docWithLayers(["l1", "l2"]), version: 5, store, render, fetchImpl, genId: () => `id-${n++}` }),
    );

    // Seed #pending = [opA, opB]; the background drain starts and parks on
    // opA's /apply fetch.
    await Promise.all([session.applyLocal(opA), session.applyLocal(opB)]);
    await vi.waitFor(() => expect(calls.filter((c) => c.url.endsWith("/apply"))).toHaveLength(1));

    // The agent's /run lands server-side while opA's POST is still parked.
    const reconcileP = session.reconcile();

    // reconcile() must NOT be able to start its rebase (no /snapshot fetch
    // yet) while a drain iteration is parked mid-fetch — otherwise it races
    // the eventual (possibly stale) /apply response against its own
    // #pending/#version writes.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((c) => c.url.endsWith("/snapshot"))).toHaveLength(0);

    // Now let opA's parked POST resolve as an ordinary success.
    applyADeferred.resolve({ status: 200, ok: true, json: async () => ({ success: true, version: 6 }) } as unknown as Response);

    await reconcileP;
    await vi.waitFor(() => expect(session.version).toBe(11), { timeout: 500 });

    // Must never observably regress to opA's stale 200 (v6) once the
    // rebase has moved the session past it.
    expect(session.version).not.toBe(6);
    // opB must not have been silently dropped by an out-of-order shift():
    // it ends up applied to #doc and (since it survives replay against the
    // new base) resubmitted and committed.
    expect(session.doc.layers.find((l) => l.id === "l2")?.opacity).toBe(0.6);
    expect(render.resetCalls).toHaveLength(1);
  });
});

describe("DocSession.reconcile", () => {
  it("walks the same rebase path as a 409 — fetches the new snapshot and warm-resets the render", async () => {
    const render = mockRender();
    const agentDoc = docWithLayers(["l1", "l2"]); // agent's /run added l2
    const { fn, calls } = mockFetch({
      snapshot: [{ status: 200, body: { success: true, version: 42, hash: "h-agent" } }],
    });
    const store = memStore({ "h-agent": irBytesFor(agentDoc) });
    const session = new DocSession(opts({ doc: docWithLayers(["l1"]), version: 5, store, render, fetchImpl: fn }));

    await session.reconcile();

    expect(session.version).toBe(42);
    expect(session.doc.layers.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(render.resetCalls).toHaveLength(1);
    expect(render.resetCalls[0]!.layers.map((l) => l.id)).toEqual(["l1", "l2"]);

    const snapshotCalls = calls.filter((c) => c.url.endsWith("/snapshot"));
    expect(snapshotCalls).toHaveLength(1);
    // No pending ops to resubmit — reconcile must not fire a spurious /apply.
    expect(calls.filter((c) => c.url.endsWith("/apply"))).toHaveLength(0);
  });
});
