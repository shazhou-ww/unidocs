import { describe, expect, it } from "vitest";
import type { CasRef, CasReferences, DocumentType } from "@unidocs/core";
import type { Delta, DeltaLog, DocIndex, DocRecord } from "../src/ports.js";
import {
  createMemoryPorts,
  createMemoryUnitOfWork,
  isMemoryTxParticipant,
} from "../src/memory-ports.js";
import { computeHash } from "../src/hash.js";
import {
  DeltaRejectedError,
  DocExistsError,
  RootRefsError,
  StorageCorruptError,
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
  failLease: Error | null = null;
  failRootRefs: Error | null = null;

  async read(_ref: CasRef): Promise<Uint8Array> {
    throw new Error("not used");
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

  // Delegated so a transaction rolls the wrapped memory index back too. The
  // recorded call list is deliberately NOT rolled back: a test that asserts
  // "register was attempted and then undone" needs to see the attempt.
  captureTxState(): unknown {
    return isMemoryTxParticipant(this.#inner) ? this.#inner.captureTxState() : null;
  }

  restoreTxState(state: unknown): void {
    if (isMemoryTxParticipant(this.#inner)) this.#inner.restoreTxState(state);
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
  const deltas = deltaLog ?? ports.deltas;
  let clock = startTime;
  const deps: SessionDeps = {
    deltas,
    snapshots: ports.snapshots,
    blobs: ports.blobs,
    index,
    // Built over the ports this harness actually injects, not over the raw
    // memory ports — a transaction that rolled back a different delta log
    // than the session writes to would prove nothing.
    unitOfWork: createMemoryUnitOfWork({ deltas, index }),
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

  it("11. load() rebuilds from an empty snapshot cache (and no durable snapshot ref) by replaying the whole log", async () => {
    // The snapshot cache (KV/Redis) is a droppable layer; the delta log is the
    // database. When the cache is gone AND the document has never had a
    // durable snapshot recorded, the log alone must be enough — this is the
    // legitimate "never snapshotted yet" case, not corruption (contrast with
    // the StorageCorruptError case below, where a ref exists but its blob is
    // missing).
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
    expect(await deps.deltas.latestSnapshotRef()).toBeNull();

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

  it("18. load() falls back to the durable snapshot when the cache is empty but a durable snapshot exists", async () => {
    // Mirrors rollback()'s fallback order: cache miss -> durable snapshot ->
    // only then init() + replay from zero. Without this fallback, create()'s
    // uploaded bytes are unrecoverable the moment the (droppable) snapshot
    // cache is evicted, because create() writes an EMPTY version-1 delta —
    // see the module doc / task-3 brief.
    const { session, deps } = makeHarness();

    const bytes = encoder.encode("durable content");
    const hash = await computeHash(bytes);
    await deps.blobs.putIfAbsent(hash, bytes);

    // A delta log that knows about the document...
    await deps.deltas.append({
      version: 1,
      timestamp: 1,
      description: "Document created",
      operations: [],
    });
    // ...and a durable snapshot recorded against it (what create()/#writeSnapshot
    // does for real) — but the snapshot CACHE was never populated/was evicted.
    await deps.deltas.recordSnapshot(1, hash, 1);
    expect(await deps.snapshots.get()).toBeNull();

    await session.load();

    expect(session.version).toBe(1);
    expect(session.initialized).toBe(true);
    expect((await session.query({ kind: "text" })).data).toBe("durable content");
    expect((await session.query({ kind: "text" })).data).not.toBe("");
  });

  it("20. load() throws StorageCorruptError when a recorded snapshot ref has no matching blob", async () => {
    // Symmetric with rollback(): the delta log recording a snapshot ref is a
    // promise that the blob exists (writeSnapshot() always writes the blob
    // BEFORE recording the ref, in both the current and the upcoming write
    // order). If the blob is gone anyway, silently falling through to
    // init() + replay would replay create()'s EMPTY version-1 delta and hand
    // back a blank document instead of surfacing the lost content as an
    // error — see task-3 Finding 1.
    const { session, deps } = makeHarness();

    const bytes = encoder.encode("durable content");
    const hash = await computeHash(bytes);
    // Deliberately never written to deps.blobs — simulates the blob store
    // (R2) losing the object the log still references.

    await deps.deltas.append({
      version: 1,
      timestamp: 1,
      description: "Document created",
      operations: [],
    });
    await deps.deltas.recordSnapshot(1, hash, 1);
    expect(await deps.snapshots.get()).toBeNull();
    expect(await deps.blobs.get(hash)).toBeNull();

    await expect(session.load()).rejects.toBeInstanceOf(StorageCorruptError);
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

  it("17. create() rolls the whole delta back when register() fails, leaving no orphan document", async () => {
    // register() is the index write most likely to fail (a network call to
    // D1/Postgres). Before create() ran inside a transaction, a failure here
    // left the worst possible residue: the version-1 delta had landed, so
    // the document answered reads and writes and #doc was non-null, but it
    // appeared in no listing and a retried create() answered 409 DocExists
    // — an orphan with no way back.
    //
    // Now the delta and the index row are one unit. Assert the durable state
    // the failure LEFT, not merely that create() rejected.
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
      // Over the FAILING index, not the memory one behind it: withTransaction
      // hands the callback the ports it was built with, and the session is
      // required to use those. Building it over ports.index instead would
      // route register() around the failure and the test would prove nothing.
      unitOfWork: createMemoryUnitOfWork({ deltas: ports.deltas, index: failingIndex }),
      cas: new FakeCas(),
      identity: { docType: "text", docId: "doc-1", userId: "user-1" },
      now: () => 1_000,
    };
    const session = new DocumentSession(makeTextDocType(), deps);
    await session.load();

    const bytes = encoder.encode("uploaded content");
    await expect(session.create({ bytes })).rejects.toThrow("D1 unavailable");

    // The delta log is back where it started — this is the transaction.
    expect(await deps.deltas.head()).toBe(0);
    expect(await deps.deltas.range()).toEqual([]);
    expect(await deps.deltas.latestSnapshotRef()).toBeNull();

    // Nothing was committed in memory or in the index either.
    expect(session.initialized).toBe(false);
    expect(session.version).toBe(0);
    expect(await ports.indexQuery.list("user-1", "text")).toEqual([]);

    // The one thing that DOES survive, by design: the content-addressed
    // blob written before the transaction. Nothing references it, so it is
    // a collectable orphan — the cheapest residue of the three, and the
    // reason blob-first is the right order.
    expect(await deps.blobs.get(await computeHash(bytes))).toEqual(bytes);

    // And because nothing was committed, a retry is a clean create() — the
    // orphan-document failure mode is gone, not merely reported.
    const retried = new DocumentSession(makeTextDocType(), {
      ...deps,
      index: ports.index,
      unitOfWork: createMemoryUnitOfWork({ deltas: ports.deltas, index: ports.index }),
    });
    expect(await retried.create({ bytes })).toEqual({ docId: "doc-1", version: 1 });
    expect(await ports.indexQuery.list("user-1", "text")).toHaveLength(1);
  });

  it("21. create() commits blob, delta, index row and snapshot cache together", async () => {
    // The four writes creating a document spreads across, asserted as a set:
    // the content-addressed blob, the version-1 delta, the global index
    // (both the docs row and the snapshot row), and the snapshot cache. The
    // cache is written LAST now and is only allowed to be last because
    // load() falls back to the durable snapshot recorded here.
    const { session, deps, ports, index } = makeHarness();
    const bytes = encoder.encode("hello");

    await session.create({ bytes });

    const hash = await computeHash(bytes);

    // 1. blob
    expect(await deps.blobs.get(hash)).toEqual(bytes);
    // 2. delta log: version 1 plus its snapshot ref
    expect(await deps.deltas.head()).toBe(1);
    expect(await deps.deltas.latestSnapshotRef()).toEqual({ version: 1, hash });
    // 3. global index: the document row and the version-1 snapshot row
    expect((await ports.indexQuery.list("user-1", "text")).map((r) => r.docId)).toEqual([
      "doc-1",
    ]);
    expect(await ports.indexQuery.snapshots("text", "doc-1")).toEqual([
      { version: 1, hash },
    ]);
    // 4. snapshot cache
    expect(await deps.snapshots.get()).toEqual({ version: 1, bytes });

    // register() ran before recordSnapshot() — the DocIndex contract. The
    // assertion above already proves the index KEPT the snapshot, which is
    // the outcome that matters; this pins the order that produces it.
    expect(index.calls).toEqual(["register", "recordSnapshot"]);
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
});
