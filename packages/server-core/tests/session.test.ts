import { describe, expect, it } from "vitest";
import type { CasRef, CasReferences, DocumentType } from "@unidocs/core";
import type { Delta, DeltaLog, DocIndex, DocRecord } from "../src/ports.js";
import { createMemoryPorts } from "../src/memory-ports.js";
import { computeHash } from "../src/hash.js";
import {
  DeltaRejectedError,
  DocExistsError,
  RootRefsError,
  VersionConflictError,
} from "../src/errors.js";
import { CasClientError } from "../src/cas-client.js";
import { DocumentSession, type CasGateway, type SessionDeps } from "../src/session.js";

// --------------------------------------------------------------------------
// A minimal document type: the document is a string.
// --------------------------------------------------------------------------

type TextOp =
  | { kind: "append"; text: string; refs?: Record<string, number> }
  | { kind: "boom" };

type TextQuery = { kind: "text" };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function makeTextDocType(): DocumentType<string, TextQuery, TextOp> {
  return {
    async init() {
      return "";
    },
    async query(_q, doc) {
      return doc;
    },
    async apply(operations, doc) {
      let next = doc;
      for (const op of operations) {
        if (op.kind === "boom") throw new Error("boom");
        next += op.text;
      }
      return next;
    },
    async load(bytes) {
      return decoder.decode(bytes);
    },
    async save(doc) {
      return encoder.encode(doc);
    },
    refsFromSnapshot() {
      return {};
    },
    refsFromOp(op) {
      return op.kind === "append" ? (op.refs ?? {}) : {};
    },
    contentType: "text/plain",
    tools: {},
    instructions: "",
  };
}

// --------------------------------------------------------------------------
// A fake CAS gateway.
// --------------------------------------------------------------------------

class FakeCas implements CasGateway {
  leased: string[] = [];
  rootRefUpdates: { requestId: string; changes: CasReferences }[] = [];
  stored: { bytes: Uint8Array; contentType: string }[] = [];
  failLease: Error | null = null;
  failRootRefs: Error | null = null;

  async read(_ref: CasRef): Promise<Uint8Array> {
    throw new Error("not used");
  }

  // Present => this is the editor-side, write-capable context. A doc type's
  // save() branches on `ctx.cas.store` (PSD emits IR + uploads layer blobs);
  // its mere presence is what the ctx-aware save test below observes.
  async store(bytes: Uint8Array, contentType: string): Promise<string> {
    this.stored.push({ bytes, contentType });
    return await computeHash(bytes);
  }

  async metadata(_ref: CasRef) {
    throw new Error("not used");
    return { hash: "", size: 0, contentType: "", refs: [] as readonly string[] };
  }

  async leaseExisting(hash: string): Promise<unknown> {
    if (this.failLease) throw this.failLease;
    this.leased.push(hash);
    return { hash, ready: true };
  }

  async updateRootRefs(update: { requestId: string; changes: CasReferences }): Promise<void> {
    if (this.failRootRefs) throw this.failRootRefs;
    this.rootRefUpdates.push(update);
  }
}

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

/**
 * Delegating spy over DocIndex. Pure observation — it records which methods
 * were called and delegates everything to the real index. What the index
 * actually KEPT is read back through `DocIndexQuery.snapshots()`, never
 * reconstructed here: a spy that reimplements the index's semantics can
 * drift from it and go green on a bug the real implementation has.
 */
class SpyDocIndex implements DocIndex {
  calls: string[] = [];
  registered: DocRecord[] = [];
  touched: number[] = [];

  #inner: DocIndex;

  constructor(inner: DocIndex) {
    this.#inner = inner;
  }

  async register(rec: DocRecord): Promise<void> {
    this.calls.push("register");
    this.registered.push(rec);
    await this.#inner.register(rec);
  }

  async touch(at: number): Promise<void> {
    this.calls.push("touch");
    this.touched.push(at);
    await this.#inner.touch(at);
  }

  async recordSnapshot(version: number, hash: string, timestamp: number): Promise<void> {
    this.calls.push("recordSnapshot");
    await this.#inner.recordSnapshot(version, hash, timestamp);
  }
}

function makeHarness(
  startTime = 1_000,
  deltaLog?: DeltaLog,
  docType: DocumentType<string, TextQuery, TextOp> = makeTextDocType(),
) {
  const ports = createMemoryPorts();
  const cas = new FakeCas();
  const index = new SpyDocIndex(ports.index);
  let clock = startTime;
  const deps: SessionDeps = {
    deltas: deltaLog ?? ports.deltas,
    snapshots: ports.snapshots,
    blobs: ports.blobs,
    index,
    cas,
    identity: { docType: "text", docId: "doc-1", userId: "user-1" },
    now: () => clock++,
  };
  const session = new DocumentSession(docType, deps);
  return { ports, cas, deps, session, index };
}

/**
 * The text doc type, wrapped so a test can prove `config.apply` was never
 * reached. Counting calls is the only way to observe the fast-fail: a session
 * that ran `apply` and then threw a conflict looks identical from the outside.
 */
function makeCountingTextDocType(): {
  docType: DocumentType<string, TextQuery, TextOp>;
  applyCalls: () => number;
} {
  const inner = makeTextDocType();
  let calls = 0;
  return {
    docType: {
      ...inner,
      async apply(operations, doc, context) {
        calls += 1;
        return inner.apply(operations, doc, context);
      },
    },
    applyCalls: () => calls,
  };
}

async function deltaCount(deps: SessionDeps): Promise<number> {
  return (await deps.deltas.range()).length;
}

/**
 * A PSD-shaped doc type: save() branches on whether it was handed a
 * store-capable context. WITH one it returns the cheap IR snapshot
 * (`IR:<doc>`); WITHOUT one it returns the real document bytes
 * (`8BPS:<doc>`). This is exactly the fork the CAS-IR feature depends on —
 * a save called without ctx silently takes the legacy (real-bytes) path.
 */
function makeCtxAwareDocType(): DocumentType<string, TextQuery, TextOp> {
  const inner = makeTextDocType();
  return {
    ...inner,
    async save(doc, ctx) {
      return ctx?.cas?.store
        ? encoder.encode(`IR:${doc}`)
        : encoder.encode(`8BPS:${doc}`);
    },
  };
}

// --------------------------------------------------------------------------
// Step 1: apply() failure paths
// --------------------------------------------------------------------------

describe("DocumentSession.apply — failure paths", () => {
  it("1. rejects a stale baseVersion with VersionConflictError and writes no delta", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const before = await deltaCount(deps);
    expect(session.version).toBe(2);

    let caught: unknown;
    try {
      await session.apply([{ kind: "append", text: "b" }], "b", 1);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VersionConflictError);
    expect((caught as VersionConflictError).currentVersion).toBe(await deps.deltas.head());
    expect(await deltaCount(deps)).toBe(before);
  });

  it("2. wraps a config.apply throw in DeltaRejectedError leaving version and document untouched", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "hello" }], "hello", 1);

    const before = await deltaCount(deps);
    const versionBefore = session.version;
    const docBefore = (await session.query({ kind: "text" })).data;

    await expect(
      session.apply(
        [
          { kind: "append", text: " world" },
          { kind: "boom" },
        ],
        "half-broken batch",
        versionBefore,
      ),
    ).rejects.toBeInstanceOf(DeltaRejectedError);

    expect(await deltaCount(deps)).toBe(before);
    expect(session.version).toBe(versionBefore);
    expect((await session.query({ kind: "text" })).data).toBe(docBefore);
  });

  it("3. removes the just-written delta when updateRootRefs fails", async () => {
    const { session, deps, cas } = makeHarness();
    await session.load();
    await session.create();

    const headBefore = await deps.deltas.head();
    cas.failRootRefs = new Error("cas down");

    await expect(
      session.apply(
        [{ kind: "append", text: "x", refs: { ["f".repeat(64)]: 1 } }],
        "with refs",
        headBefore,
      ),
    ).rejects.toBeInstanceOf(RootRefsError);

    expect(await deps.deltas.head()).toBe(headBefore);
    expect(await deps.deltas.range(headBefore + 1, headBefore + 1)).toEqual([]);
    expect(session.version).toBe(headBefore);
  });

  it("10. rejects a baseVersion ahead of the log rather than leaving a version gap", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const before = await deltaCount(deps);
    const headBefore = await deps.deltas.head();
    expect(session.version).toBe(2);

    let caught: unknown;
    try {
      await session.apply([{ kind: "append", text: "b" }], "b", 5);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VersionConflictError);
    expect((caught as VersionConflictError).currentVersion).toBe(headBefore);
    expect((caught as VersionConflictError).attempted).toBe(6);
    expect(await deltaCount(deps)).toBe(before);
    expect(await deps.deltas.head()).toBe(headBefore);
    expect(session.version).toBe(2);
  });

  it("14. fast-fails a stale baseVersion before config.apply runs, even for a batch that would itself throw", async () => {
    // Two things are asserted together on purpose, because they are the same
    // bug seen from two sides. Without the fast-fail, a stale write whose ops
    // also happen to be invalid gets rejected by config.apply first and comes
    // back as DeltaRejectedError -> 400 "Delta failed", which tells the client
    // its write is permanently broken when all it needs is to re-read the
    // version and retry. And getting there costs a full document parse
    // (an unzip, for docx) for a write that could never have landed.
    const { docType, applyCalls } = makeCountingTextDocType();
    const { session, deps } = makeHarness(1_000, undefined, docType);
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const callsBefore = applyCalls();
    const deltasBefore = await deltaCount(deps);
    expect(session.version).toBe(2);

    let caught: unknown;
    try {
      // baseVersion 1 is stale (head is 2) AND `boom` throws in config.apply.
      await session.apply([{ kind: "boom" }], "doomed and stale", 1);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VersionConflictError);
    expect(caught).not.toBeInstanceOf(DeltaRejectedError);
    expect((caught as VersionConflictError).currentVersion).toBe(2);
    expect((caught as VersionConflictError).attempted).toBe(2);

    // The point of the fast path: the document was never parsed.
    expect(applyCalls()).toBe(callsBefore);

    expect(await deltaCount(deps)).toBe(deltasBefore);
    expect(session.version).toBe(2);
  });

  it("15. a non-CasClientError raised while leasing refs is a rejected delta, not a server fault", async () => {
    // `refsFromOp` is a doc-type pure function over caller-supplied operations,
    // so a malformed op makes it throw (TypeError and friends). The
    // pre-refactor `#leaseFailure` had a branch for exactly this and answered
    // 400. Letting it fall through to a generic 500 tells the client to retry
    // an operation that can never succeed.
    const inner = makeTextDocType();
    const exploding: DocumentType<string, TextQuery, TextOp> = {
      ...inner,
      refsFromOp() {
        throw new TypeError("Cannot read properties of undefined (reading 'hash')");
      },
    };
    const { session, deps } = makeHarness(1_000, undefined, exploding);
    await session.create();

    const before = await deltaCount(deps);

    let caught: unknown;
    try {
      await session.apply([{ kind: "append", text: "a" }], "a", 1);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DeltaRejectedError);
    expect((caught as Error).message).toContain("Delta failed");
    expect(await deltaCount(deps)).toBe(before);
    expect(session.version).toBe(1);
  });

  it("16. a CasClientError raised while leasing refs still propagates verbatim", async () => {
    // The other half of the same branch: CasClientError carries the status the
    // adapter splits into 409/400/502, so it must NOT be swallowed into
    // DeltaRejectedError.
    const { session, deps, cas } = makeHarness();
    await session.create();

    const failure = new CasClientError(409, "Conflict", "leaseExisting");
    cas.failLease = failure;

    const before = await deltaCount(deps);

    let caught: unknown;
    try {
      await session.apply(
        [{ kind: "append", text: "a", refs: { ["f".repeat(64)]: 1 } }],
        "a",
        1,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(failure);
    expect(caught).not.toBeInstanceOf(DeltaRejectedError);
    expect(await deltaCount(deps)).toBe(before);
    expect(session.version).toBe(1);
  });

  it("4. serializes concurrent applies sharing a baseVersion: exactly one wins", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();

    const base = session.version;
    const results = await Promise.allSettled([
      session.apply([{ kind: "append", text: "A" }], "A", base),
      session.apply([{ kind: "append", text: "B" }], "B", base),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);
    expect(await deps.deltas.head()).toBe(base + 1);
    expect(await deltaCount(deps)).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Step 4: normal paths
// --------------------------------------------------------------------------

describe("DocumentSession — normal paths", () => {
  it("5. create() writes version 1, an empty delta, a durable snapshot and an index row", async () => {
    const { session, deps, ports } = makeHarness();
    await session.load();

    const result = await session.create();

    expect(result).toEqual({ docId: "doc-1", version: 1 });
    expect(session.version).toBe(1);
    expect(session.initialized).toBe(true);

    const history = await session.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      version: 1,
      description: "Document created",
      operations: [],
    });

    // Durable snapshot written at creation time (this is the leading `1` in
    // the phase-0 characterization's [1, 21] snapshot versions).
    const ref = await deps.deltas.latestSnapshotRef();
    expect(ref?.version).toBe(1);
    expect(await deps.blobs.get(ref!.hash)).toEqual(encoder.encode(""));
    expect(ref!.hash).toBe(await computeHash(encoder.encode("")));

    // ...and the SAME snapshot must reach the global index. The delta log and
    // the global index are two independent writes; asserting only the log let
    // a regression through once already, because DocIndex.recordSnapshot
    // drops records filed against a document it has not been told about.
    // Read what the index KEPT, not what it was asked to keep.
    expect(await ports.indexQuery.snapshots("text", "doc-1")).toEqual([
      { version: 1, hash: ref!.hash },
    ]);

    // Snapshot cache refreshed too.
    expect(await deps.snapshots.get()).toEqual({ version: 1, bytes: encoder.encode("") });

    // Registered in the global index.
    const docs = await ports.indexQuery.list("user-1", "text");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ docId: "doc-1", docType: "text", ownerId: "user-1" });
  });

  it("6. snapshots every 20 deltas: after 21 applies the latest snapshot is version 21", async () => {
    const { session, deps, ports } = makeHarness();
    await session.load();
    await session.create();

    for (let i = 0; i < 21; i++) {
      await session.apply([{ kind: "append", text: "x" }], `op ${i}`, session.version);
    }

    expect(session.version).toBe(22);
    const ref = await deps.deltas.latestSnapshotRef();
    expect(ref?.version).toBe(21);
    // Both snapshot sides agree — this is the phase-0 [1, 21] assertion, which
    // reads the global index, reproduced as a pure unit test.
    expect((await ports.indexQuery.snapshots("text", "doc-1")).map((r) => r.version)).toEqual([
      1, 21,
    ]);
  });

  it("7. rollback() replays from the nearest snapshot and moves the version forward", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", session.version);
    await session.apply([{ kind: "append", text: "b" }], "b", session.version);
    expect((await session.query({ kind: "text" })).data).toBe("ab");

    const result = await session.rollback(2);

    expect(result).toEqual({ version: 4 });
    expect(session.version).toBe(4);
    expect((await session.query({ kind: "text" })).data).toBe("a");

    // History is preserved in full; the rollback is a synthetic delta.
    const history = await session.history();
    expect(history.map((h) => h.version)).toEqual([1, 2, 3, 4]);
    expect(history[3]).toMatchObject({
      version: 4,
      description: "Rollback to version 2",
      operations: [],
    });
    expect(await deps.deltas.head()).toBe(4);
  });

  it("8. load() rebuilds from the cached snapshot plus delta replay", async () => {
    const { session, deps } = makeHarness();

    await deps.snapshots.put(3, encoder.encode("abc"));
    // Versions 1-3 are already folded into the cached snapshot; they only
    // exist here because the log contract requires contiguous versions.
    for (const version of [1, 2, 3]) {
      await deps.deltas.append({
        version,
        timestamp: version,
        description: `seed ${version}`,
        operations: [],
      });
    }
    await deps.deltas.append({
      version: 4,
      timestamp: 10,
      description: "d",
      operations: [{ kind: "append", text: "d" }],
    });
    await deps.deltas.append({
      version: 5,
      timestamp: 11,
      description: "e",
      operations: [{ kind: "append", text: "e" }],
    });

    await session.load();

    expect(session.version).toBe(5);
    expect(session.initialized).toBe(true);
    expect((await session.query({ kind: "text" })).data).toBe("abcde");
    // The replayed state is written back to the cache.
    expect(await deps.snapshots.get()).toEqual({ version: 5, bytes: encoder.encode("abcde") });

    // Idempotent: a second load() is a no-op.
    await session.load();
    expect(session.version).toBe(5);
  });

  it("11. load() rebuilds from an empty snapshot cache by replaying the whole log", async () => {
    // The snapshot cache (KV/Redis) is a droppable layer; the delta log is the
    // database. When the cache is gone the log alone must be enough.
    const { session, deps } = makeHarness();

    await deps.deltas.append({
      version: 1,
      timestamp: 1,
      description: "Document created",
      operations: [],
    });
    await deps.deltas.append({
      version: 2,
      timestamp: 2,
      description: "a",
      operations: [{ kind: "append", text: "a" }],
    });
    await deps.deltas.append({
      version: 3,
      timestamp: 3,
      description: "b",
      operations: [{ kind: "append", text: "b" }],
    });
    expect(await deps.snapshots.get()).toBeNull();

    await session.load();

    expect(session.initialized).toBe(true);
    expect(session.version).toBe(3);
    expect((await session.query({ kind: "text" })).data).toBe("ab");
    // The rebuilt state is written back into the empty cache.
    expect(await deps.snapshots.get()).toEqual({ version: 3, bytes: encoder.encode("ab") });
  });

  it("11b. load() on a completely empty store leaves the session uninitialized", async () => {
    // Guard for the fix above: replaying from init() must not make a document
    // that was never created look like it exists — create() checks this.
    const { session, deps } = makeHarness();
    await session.load();
    expect(session.initialized).toBe(false);
    expect(session.version).toBe(0);
    expect(await deps.snapshots.get()).toBeNull();
    await expect(session.create()).resolves.toEqual({ docId: "doc-1", version: 1 });
  });

  it("13. public methods load themselves — no caller-side load() required", async () => {
    // The DO original loaded once at the top of its request handler. Nothing
    // in the type system forces an adapter to do the same, so the session
    // carries the obligation itself.
    const { session, deps } = makeHarness();
    await deps.deltas.append({
      version: 1,
      timestamp: 1,
      description: "Document created",
      operations: [],
    });
    await deps.deltas.append({
      version: 2,
      timestamp: 2,
      description: "hi",
      operations: [{ kind: "append", text: "hi" }],
    });

    // No session.load() anywhere below.
    expect((await session.query({ kind: "text" })).version).toBe(2);
    expect((await session.query({ kind: "text" })).data).toBe("hi");
    expect(await session.history()).toHaveLength(2);
    expect((await session.exportBytes()).bytes).toEqual(encoder.encode("hi"));
    await expect(session.create()).rejects.toBeInstanceOf(DocExistsError);
    expect((await session.apply([{ kind: "append", text: "!" }], "bang", 2)).version).toBe(3);
  });

  it("12. create() leaves no in-memory state behind when the conditional write loses", async () => {
    // A racing replica committed version 1 between our load() and our append.
    const ports = createMemoryPorts();
    const racing: DeltaLog = {
      ...ports.deltas,
      append: async (d: Delta) => {
        throw new VersionConflictError(1, d.version);
      },
      head: () => ports.deltas.head(),
      since: (v: number) => ports.deltas.since(v),
      range: (from?: number, to?: number) => ports.deltas.range(from, to),
      remove: (v: number) => ports.deltas.remove(v),
      latestSnapshotRef: (at?: number) => ports.deltas.latestSnapshotRef(at),
      recordSnapshot: (v: number, h: string, t: number) => ports.deltas.recordSnapshot(v, h, t),
      countSince: (v: number) => ports.deltas.countSince(v),
    };
    const { session, index } = makeHarness(1_000, racing);

    await expect(session.create()).rejects.toBeInstanceOf(VersionConflictError);

    // Nothing was committed: no document, no version, no index row.
    expect(session.initialized).toBe(false);
    expect(session.version).toBe(0);
    expect(index.calls).toEqual([]);
  });

  it("17. create() saves the snapshot cache before register(), so a register() failure doesn't lose the uploaded bytes", async () => {
    // register() is a D1 network call — the step in create() most likely to
    // fail. If #saveSnapshotCache() ran AFTER register() (the old, reverted
    // ordering), a register() throw here would leave version 1's delta
    // landed but the cache empty: a later load() would replay onto an
    // init()-produced empty document instead of the uploaded bytes, and
    // #doc being non-null would then block any retry with DocExistsError —
    // the upload permanently lost. Assert the cache directly KEPT the bytes,
    // not merely that create() rejected.
    const ports = createMemoryPorts();
    const failingIndex: DocIndex = {
      register: async () => {
        throw new Error("D1 unavailable");
      },
      touch: (at: number) => ports.index.touch(at),
      recordSnapshot: (v: number, h: string, t: number) => ports.index.recordSnapshot(v, h, t),
    };
    const deps: SessionDeps = {
      deltas: ports.deltas,
      snapshots: ports.snapshots,
      blobs: ports.blobs,
      index: failingIndex,
      cas: new FakeCas(),
      identity: { docType: "text", docId: "doc-1", userId: "user-1" },
      now: () => 1_000,
    };
    const session = new DocumentSession(makeTextDocType(), deps);
    await session.load();

    const bytes = encoder.encode("uploaded content");
    await expect(session.create({ bytes })).rejects.toThrow("D1 unavailable");

    // The delta landed...
    expect(await deps.deltas.head()).toBe(1);
    // ...and the uploaded bytes are already in the snapshot cache — not lost.
    expect(await deps.snapshots.get()).toEqual({ version: 1, bytes });
  });

  // ------------------------------------------------------------------
  // Snapshot root-refs: refsFromSnapshot GC pinning (Phase 3, Task 2)
  // ------------------------------------------------------------------

  /**
   * Fold a batch of root-ref updates into effective per-hash counts using the
   * SAME idempotency rule the CAS worker enforces: dedupe by requestId (a
   * repeat of a requestId is a no-op — see cloudflare-cas handleUpdateRootRefs).
   * This proves the session hands the worker a key that collapses re-runs.
   */
  function foldRootRefs(
    updates: { requestId: string; changes: CasReferences }[],
  ): Record<string, number> {
    const seen = new Set<string>();
    const counts: Record<string, number> = {};
    for (const u of updates) {
      if (seen.has(u.requestId)) continue;
      seen.add(u.requestId);
      for (const [hash, delta] of Object.entries(u.changes)) {
        counts[hash] = (counts[hash] ?? 0) + delta;
      }
    }
    return counts;
  }

  it("18. commits refsFromSnapshot hashes as root-refs when writing a durable snapshot", async () => {
    const refs: CasReferences = { h1: 1, h2: 1 };
    const docType = { ...makeTextDocType(), refsFromSnapshot: () => refs };
    const { session, cas } = makeHarness(1_000, undefined, docType);
    await session.load();

    // create() writes the durable v1 snapshot.
    await session.create();

    const snapCommits = cas.rootRefUpdates.filter((u) =>
      u.requestId.startsWith("snapshot:"),
    );
    expect(snapCommits).toHaveLength(1);
    expect(snapCommits[0]).toEqual({
      requestId: "snapshot:user-1:doc-1:1",
      changes: { h1: 1, h2: 1 },
    });
  });

  it("19. commits nothing to root-refs when refsFromSnapshot returns {} (markdown/docx unchanged)", async () => {
    // The default text doc type returns {} from refsFromSnapshot — exactly
    // like markdown/docx. The new pin path must be skipped entirely.
    const { session, cas } = makeHarness();
    await session.load();
    await session.create();

    expect(cas.rootRefUpdates).toEqual([]);
  });

  it("20. re-writing a snapshot at the same version reuses one deterministic, idempotent requestId (no double-count)", async () => {
    const refs: CasReferences = { h1: 1, h2: 1 };
    const docType = { ...makeTextDocType(), refsFromSnapshot: () => refs };
    const { session, cas } = makeHarness(1_000, undefined, docType);
    await session.load();

    await session.create(); // snapshot at v1
    await session.snapshot(); // force another durable snapshot, still at v1

    const snapCommits = cas.rootRefUpdates.filter((u) =>
      u.requestId.startsWith("snapshot:"),
    );
    // Two physical commits reached the (dumb) fake...
    expect(snapCommits.length).toBeGreaterThanOrEqual(2);
    // ...but under ONE deterministic requestId, so the CAS worker's
    // (requestId, payload) idempotency collapses them to a single application.
    expect(new Set(snapCommits.map((u) => u.requestId))).toEqual(
      new Set(["snapshot:user-1:doc-1:1"]),
    );
    // Folded with the worker's real dedupe rule, each blob is pinned once.
    expect(foldRootRefs(snapCommits)).toEqual({ h1: 1, h2: 1 });
  });

  it("9. initFromHash() adopts an existing blob as version 1", async () => {
    const { session, deps, ports } = makeHarness();
    const bytes = encoder.encode("cloned content");
    const hash = await computeHash(bytes);
    await deps.blobs.putIfAbsent(hash, bytes);

    await session.load();
    const result = await session.initFromHash(hash, 7);

    expect(result).toEqual({ docId: "doc-1", version: 1 });
    expect((await session.query({ kind: "text" })).data).toBe("cloned content");

    const history = await session.history();
    expect(history).toHaveLength(1);
    expect(history[0].description).toBe(
      `Cloned from snapshot ${hash} (source version 7)`,
    );
    expect(history[0].operations).toEqual([]);

    // The snapshot reference points at the adopted blob — no new blob written.
    expect(await deps.deltas.latestSnapshotRef()).toEqual({ version: 1, hash });
    // The global index gets it too, and only because register ran first.
    expect(await ports.indexQuery.snapshots("text", "doc-1")).toEqual([{ version: 1, hash }]);
  });

  // ------------------------------------------------------------------
  // CAS-IR snapshots: internal snapshot writes must pass the context
  // (Phase 3, Task 3b). Regression guard for the dead-code bug where
  // #saveSnapshotCache / #writeSnapshot called save(doc) WITHOUT ctx, so a
  // PSD-shaped save always took its legacy (real-bytes) branch.
  // ------------------------------------------------------------------

  it("21. internal snapshot writes (cache + durable) hand save() a store-capable ctx (the IR branch), while exportBytes() gets none (real bytes)", async () => {
    const { session, deps } = makeHarness(1_000, undefined, makeCtxAwareDocType());
    await session.load();

    // create() writes the durable v1 snapshot (doc == "") and the cache.
    await session.create();
    // apply() refreshes the cache at v2 (doc == "a").
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    // 1. The fast (non-durable) snapshot cache got the IR branch.
    expect(await deps.snapshots.get()).toEqual({
      version: 2,
      bytes: encoder.encode("IR:a"),
    });

    // 2. The durable, content-addressed snapshot (written at create, v1, doc "")
    //    also got the IR branch — the blob under its ref is IR bytes.
    const ref = await deps.deltas.latestSnapshotRef();
    expect(ref?.version).toBe(1);
    expect(await deps.blobs.get(ref!.hash)).toEqual(encoder.encode("IR:"));
    // And the ref hash is the hash of the IR bytes, proving putIfAbsent stored them.
    expect(ref!.hash).toBe(await computeHash(encoder.encode("IR:")));

    // 3. A user-facing export/download must be the REAL bytes, never the CAS-IR
    //    snapshot — exportBytes() calls save(doc) with NO ctx.
    const exported = await session.exportBytes();
    expect(exported.bytes).toEqual(encoder.encode("8BPS:a"));
  });

  it("22. a save() that ignores ctx (markdown/docx-like) is unaffected: cache, durable and export bytes all match", async () => {
    // The default text doc type ignores ctx entirely, exactly like markdown/docx.
    // Passing the context to the internal writes must not change its behaviour.
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    // Cache == plain save(doc), context or not.
    expect(await deps.snapshots.get()).toEqual({ version: 2, bytes: encoder.encode("a") });
    // Durable v1 snapshot == plain save("").
    const ref = await deps.deltas.latestSnapshotRef();
    expect(await deps.blobs.get(ref!.hash)).toEqual(encoder.encode(""));
    // Export == plain save(doc). All three agree.
    expect((await session.exportBytes()).bytes).toEqual(encoder.encode("a"));
  });

  it("23. snapshot() returns the hash actually persisted (ctx-aware IR bytes), so clone-from-snapshot round-trips", async () => {
    // Regression for the divergence bug: snapshot() used to recompute the hash
    // via a SECOND save(doc) with NO ctx. For a ctx-aware doc type (PSD) that
    // second save yields the real (8BPS) bytes, whose hash no blob was stored
    // under — #writeSnapshot had already persisted the IR bytes under a
    // different hash. The returned hash is the clone hash, so this broke
    // clone-from-snapshot (initFromHash -> blobs.get -> DocNotFoundError).
    const { session, deps } = makeHarness(1_000, undefined, makeCtxAwareDocType());
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const snap = await session.snapshot();
    expect(snap.version).toBe(2);

    // (a) The returned hash resolves to a blob ACTUALLY in the store — the IR
    //     bytes. Before the fix this was the real-bytes hash and get() was null.
    const stored = await deps.blobs.get(snap.hash);
    expect(stored).not.toBeNull();
    expect(stored).toEqual(encoder.encode("IR:a"));
    expect(snap.hash).toBe(await computeHash(encoder.encode("IR:a")));

    // (b) Clone round-trips: a fresh session (its own deltas/snapshots/index and
    //     a new docId) sharing the global blob store adopts the snapshot without
    //     DocNotFoundError.
    const clonePorts = createMemoryPorts();
    const cloneDeps: SessionDeps = {
      deltas: clonePorts.deltas,
      snapshots: clonePorts.snapshots,
      blobs: deps.blobs, // shared global CAS
      index: clonePorts.index,
      cas: new FakeCas(),
      identity: { docType: "text", docId: "doc-2", userId: "user-1" },
      now: () => 2_000,
    };
    const clone = new DocumentSession(makeCtxAwareDocType(), cloneDeps);
    const result = await clone.initFromHash(snap.hash, snap.version);
    expect(result).toEqual({ docId: "doc-2", version: 1 });
    expect((await clone.query({ kind: "text" })).data).toBe("IR:a");
  });

  it("24. snapshot() with a ctx-ignoring doc type (markdown/docx-like) is byte-identical to before: plain-bytes hash", async () => {
    // save ignores ctx, so IR-hash == real-hash; reusing #writeSnapshot's hash
    // must equal what the old recompute produced.
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const snap = await session.snapshot();
    expect(snap.version).toBe(2);
    expect(snap.hash).toBe(await computeHash(encoder.encode("a")));
    expect(await deps.blobs.get(snap.hash)).toEqual(encoder.encode("a"));
  });

  // ------------------------------------------------------------------
  // C1: exportBytes() must materialize a lazy document before save().
  // A cold-reloaded PSD is lazy (PixelRef layers); save() WITHOUT ctx would
  // hit the writePsd fallback and throw. The optional resolve() hook faults
  // the lazy refs resident first, then save() (still no ctx) emits real bytes.
  // ------------------------------------------------------------------

  it("25. exportBytes() calls resolve() before save() (resolve gets ctx, save gets none)", async () => {
    const resolveCtx: ({ cas?: unknown } | undefined)[] = [];
    const calls: string[] = [];
    // A lazy-aware doc type: resolve() materializes the doc (LAZY -> resident)
    // and records the ctx it received; save() records whether it saw a ctx and,
    // WITHOUT one, would "throw" on a still-lazy doc — mirroring PSD writePsd.
    const docType: DocumentType<string, TextQuery, TextOp> = {
      ...makeCtxAwareDocType(),
      async resolve(doc, ctx) {
        calls.push("resolve");
        resolveCtx.push(ctx);
        // Materialize: strip the LAZY marker so save() sees a resident doc.
        return doc.startsWith("LAZY:") ? doc.slice("LAZY:".length) : doc;
      },
      async save(doc, ctx) {
        calls.push("save");
        // A save without ctx on a still-lazy doc is the failure C1 fixes.
        if (!ctx?.cas?.store && doc.startsWith("LAZY:")) {
          throw new Error("writePsd fallback on a lazy PixelRef doc");
        }
        return ctx?.cas?.store ? encoder.encode(`IR:${doc}`) : encoder.encode(`8BPS:${doc}`);
      },
    };

    const { session } = makeHarness(1_000, undefined, docType);
    await session.load();
    await session.create();
    // Simulate a cold-reloaded lazy document.
    await session.apply([{ kind: "append", text: "LAZY:pixels" }], "lazy", 1);

    // Ignore the internal snapshot save()s from create()/apply(); observe only
    // what exportBytes() does.
    calls.length = 0;
    const exported = await session.exportBytes();
    // resolve ran, then save; save produced REAL (non-IR) bytes off the
    // materialized doc — never threw.
    expect(calls).toEqual(["resolve", "save"]);
    expect(exported.bytes).toEqual(encoder.encode("8BPS:pixels"));
    // resolve() received a real context (carrying cas); save() did not.
    expect(resolveCtx[0]?.cas).toBeDefined();
  });

  it("26. exportBytes() on a doc type WITHOUT resolve is unchanged (no call, real bytes)", async () => {
    // markdown/docx have no resolve — export must be byte-identical to before.
    const { session } = makeHarness(1_000, undefined, makeCtxAwareDocType());
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const exported = await session.exportBytes();
    expect(exported.bytes).toEqual(encoder.encode("8BPS:a"));
  });

  // ------------------------------------------------------------------
  // I2: a clone must independently pin the blobs its snapshot references.
  // initFromHash adopts the source IR snapshot as v1; it must commit the
  // snapshot's refs to root-refs under the CLONE's own requestId so the blobs
  // survive independently of the source doc's root-refs.
  // ------------------------------------------------------------------

  it("27. initFromHash() pins the cloned snapshot's referenced blobs under the clone's own requestId", async () => {
    const refs: CasReferences = { h1: 1, h2: 1 };
    const docType = { ...makeTextDocType(), refsFromSnapshot: () => refs };

    // Clone identity differs from any source: user-9 / doc-clone.
    const ports = createMemoryPorts();
    const cas = new FakeCas();
    const deps: SessionDeps = {
      deltas: ports.deltas,
      snapshots: ports.snapshots,
      blobs: ports.blobs,
      index: ports.index,
      cas,
      identity: { docType: "text", docId: "doc-clone", userId: "user-9" },
      now: () => 5_000,
    };
    const bytes = encoder.encode("cloned snapshot");
    const hash = await computeHash(bytes);
    await deps.blobs.putIfAbsent(hash, bytes);

    const session = new DocumentSession(docType, deps);
    await session.load();
    await session.initFromHash(hash, 3);

    const snapCommits = cas.rootRefUpdates.filter((u) => u.requestId.startsWith("snapshot:"));
    expect(snapCommits).toHaveLength(1);
    expect(snapCommits[0]).toEqual({
      requestId: "snapshot:user-9:doc-clone:1",
      changes: { h1: 1, h2: 1 },
    });
  });

  it("28. initFromHash() pins nothing when refsFromSnapshot returns {} (markdown/docx unchanged)", async () => {
    const { session, deps, cas } = makeHarness();
    const bytes = encoder.encode("plain clone");
    const hash = await computeHash(bytes);
    await deps.blobs.putIfAbsent(hash, bytes);

    await session.load();
    await session.initFromHash(hash, 2);

    expect(cas.rootRefUpdates).toEqual([]);
  });
});
