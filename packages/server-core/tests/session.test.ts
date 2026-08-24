import { describe, expect, it } from "vitest";
import { createSBlob, encodeSValue } from "@unidocs/core";
import type { CasRef, CasReferences, DocumentType, SBlob, SValue } from "@unidocs/core";
import type {
  Delta,
  DeltaLog,
  DocIndex,
  DocRecord,
  SnapshotCache,
  TransactionalPorts,
  UnitOfWork,
} from "../src/ports.js";
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
  | { kind: "append"; text: string; blob?: SBlob }
  | { kind: "boom" };

type TextQuery = { kind: "text" };

type BlobDoc = { text: string; blobs: SBlob[] };

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const HASH_F = "f".repeat(64);
const HASH_1 = "11".repeat(32);
const HASH_2 = "22".repeat(32);

function snapshotBytes(value: SValue): Uint8Array {
  return encodeSValue(value);
}

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
    formats: {
      text: {
        mediaTypes: ["text/plain"],
        extensions: [".txt"],
        async load(bytes) {
          return decoder.decode(bytes);
        },
        async save(doc) {
          return encoder.encode(doc);
        },
      },
    },
    defaultFormat: "text",
    contentType: "text/plain",
    tools: {},
    instructions: "",
  };
}

/** TDoc carries branded SBlobs so snapshot/clone pinning does not need refsFromSnapshot. */
function makeBlobDocType(): DocumentType<BlobDoc, TextQuery, TextOp> {
  return {
    async init() {
      return { text: "", blobs: [createSBlob(HASH_1), createSBlob(HASH_2)] };
    },
    async query(_q, doc) {
      return doc.text;
    },
    async apply(operations, doc) {
      let text = doc.text;
      for (const op of operations) {
        if (op.kind === "boom") throw new Error("boom");
        text += op.text;
      }
      return { text, blobs: doc.blobs };
    },
    formats: {
      json: {
        mediaTypes: ["application/json"],
        extensions: [".json"],
        async load(bytes) {
          const parsed = JSON.parse(decoder.decode(bytes)) as { text: string; hashes: string[] };
          return { text: parsed.text, blobs: parsed.hashes.map(createSBlob) };
        },
        async save(doc) {
          return encoder.encode(
            JSON.stringify({ text: doc.text, hashes: doc.blobs.map((b) => b.hash) }),
          );
        },
      },
    },
    defaultFormat: "json",
    contentType: "application/json",
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

  // Present because production document types may store content through the
  // write-capable context while importing, applying operations, or exporting.
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

/**
 * The non-transactional UnitOfWork, mirroring `DirectUnitOfWork` in
 * cloudflare-sdk (which server-core must not import). It runs the callback
 * and rolls nothing back, so a failure part-way through leaves exactly what
 * it wrote — which is how the tests below observe the write ORDER inside the
 * transaction. Under a real transaction the order is invisible by
 * construction: everything lands or nothing does.
 */
class PassThroughUnitOfWork implements UnitOfWork {
  #ports: TransactionalPorts;

  constructor(ports: TransactionalPorts) {
    this.#ports = ports;
  }

  withTransaction<T>(fn: (tx: TransactionalPorts) => Promise<T>): Promise<T> {
    return fn(this.#ports);
  }
}

function makeHarness(
  startTime = 1_000,
  deltaLog?: DeltaLog,
  docType: DocumentType<any, TextQuery, TextOp> = makeTextDocType(),
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
      async apply(operations, doc) {
        calls += 1;
        return inner.apply(operations, doc);
      },
    },
    applyCalls: () => calls,
  };
}

async function deltaCount(deps: SessionDeps): Promise<number> {
  return (await deps.deltas.range()).length;
}

/**
 * A doc type whose external format deliberately differs from its TDoc. This
 * proves snapshots never call a format adapter.
 */
function makeDistinctFormatDocType(): DocumentType<string, TextQuery, TextOp> {
  const inner = makeTextDocType();
  return {
    ...inner,
    formats: {
      text: {
        ...inner.formats.text,
        async save(doc) {
          return encoder.encode(`IR:${doc}`);
        },
      },
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
        [{ kind: "append", text: "x", blob: createSBlob(HASH_F) }],
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
    // Lease walks ops as SValue. A circular structure cannot be encoded, so
    // leaseOpRefs throws a TypeError. That must surface as DeltaRejectedError
    // (400), not a generic 500 that tells the client to retry forever.
    const { session, deps } = makeHarness();
    await session.create();

    const before = await deltaCount(deps);

    const cyclic: { kind: "append"; text: string; cycle?: unknown } = { kind: "append", text: "a" };
    cyclic.cycle = cyclic;

    let caught: unknown;
    try {
      await session.apply([cyclic as TextOp], "a", 1);
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
        [{ kind: "append", text: "a", blob: createSBlob(HASH_F) }],
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
    expect(await deps.blobs.get(ref!.hash)).toEqual(snapshotBytes(""));
    expect(ref!.hash).toBe(await computeHash(snapshotBytes("")));

    // ...and the SAME snapshot must reach the global index. The delta log and
    // the global index are two independent writes; asserting only the log let
    // a regression through once already, because DocIndex.recordSnapshot
    // drops records filed against a document it has not been told about.
    // Read what the index KEPT, not what it was asked to keep.
    expect(await ports.indexQuery.snapshots("text", "doc-1")).toEqual([
      { version: 1, hash: ref!.hash },
    ]);

    // Snapshot cache refreshed too.
    expect(await deps.snapshots.get()).toEqual({ version: 1, bytes: snapshotBytes("") });

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

    await deps.snapshots.put(3, snapshotBytes("abc"));
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
    expect(await deps.snapshots.get()).toEqual({ version: 5, bytes: snapshotBytes("abcde") });

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
    expect(await deps.snapshots.get()).toEqual({ version: 3, bytes: snapshotBytes("ab") });
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

    const bytes = snapshotBytes("durable content");
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

  it("19. a freshly created document has updatedAt === createdAt", async () => {
    // b7c153a folded create()'s snapshot write into the same
    // tx.index.recordSnapshot() call that register() uses, so both rows are
    // stamped from the same `timestamp` local — createdAt/updatedAt landing
    // together is now a guarantee, not a coincidence of a slow clock. Uses
    // makeHarness()'s incrementing clock (`now: () => clock++`), not a
    // constant, because a constant clock can't distinguish "one timestamp
    // read twice" from "two separate #deps.now() calls that happened to
    // land in the same tick" — and #writeSnapshot() (used by apply() and
    // rollback()) calls now() again on every invocation, so a regression
    // that made create() do the same would only show up against a clock
    // that actually advances.
    const { session, ports } = makeHarness();

    await session.create({ bytes: encoder.encode("hello") });

    const [row] = await ports.indexQuery.list("user-1", "text");
    expect(row.updatedAt).toBe(row.createdAt);
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

    const bytes = snapshotBytes("durable content");
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
    const persisted = snapshotBytes("uploaded content");
    expect(await deps.blobs.get(await computeHash(persisted))).toEqual(persisted);

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

    const persisted = snapshotBytes("hello");
    const hash = await computeHash(persisted);

    // 1. blob
    expect(await deps.blobs.get(hash)).toEqual(persisted);
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
    expect(await deps.snapshots.get()).toEqual({ version: 1, bytes: persisted });

    // register() ran before recordSnapshot() — the DocIndex contract. The
    // assertion above already proves the index KEPT the snapshot, which is
    // the outcome that matters; this pins the order that produces it.
    expect(index.calls).toEqual(["register", "recordSnapshot"]);
  });

  it("22. on a backend without rollback, an index failure still leaves the content recoverable", async () => {
    // The write order INSIDE the transaction only becomes observable on a
    // backend whose withTransaction cannot roll back — Cloudflare, where the
    // delta log is a Durable Object's sqlite and the index is D1. There, the
    // two DO-local writes (the v1 delta and the delta log's snapshot record)
    // must land before either index write, or a failing D1 call leaves a v1
    // delta whose snapshot hash NOTHING records. load() would then take the
    // `latestSnapshotRef() === null` branch, replay the empty v1 delta onto
    // init(), and hand back a BLANK document — no error anywhere — while the
    // uploaded bytes sit unreachable in the blob store.
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
      // No rollback — the whole point of this test.
      unitOfWork: new PassThroughUnitOfWork({ deltas: ports.deltas, index: failingIndex }),
      cas: new FakeCas(),
      identity: { docType: "text", docId: "doc-1", userId: "user-1" },
      now: () => 1_000,
    };

    const bytes = encoder.encode("uploaded content");
    await expect(
      new DocumentSession(makeTextDocType(), deps).create({ bytes }),
    ).rejects.toThrow("D1 unavailable");

    // The delta landed and so did the reference to its snapshot — the two
    // writes that share a store went in together.
    expect(await deps.deltas.head()).toBe(1);
    expect(await deps.deltas.latestSnapshotRef()).toEqual({
      version: 1,
      hash: await computeHash(snapshotBytes("uploaded content")),
    });
    // The index never learned about the document: this is the accepted
    // residue on a non-transactional backend — missing from the listing.
    expect(await ports.indexQuery.list("user-1", "text")).toEqual([]);

    // And the payoff: a fresh session recovers the CONTENT, not a blank
    // document, even with an empty snapshot cache.
    expect(await deps.snapshots.get()).toBeNull();
    const reopened = new DocumentSession(makeTextDocType(), deps);
    expect((await reopened.query({ kind: "text" })).data).toBe("uploaded content");
    expect(reopened.version).toBe(1);
  });

  it("23. a failing snapshot cache does not fail create() — the cache is best-effort", async () => {
    // Step 4 of create() is a cache write over already-committed durable
    // state. Letting its throw out would turn a creation that SUCCEEDED into
    // an error response, and the caller's retry would then hit 409
    // DocExists — a healthy document the client believes is broken. Safe to
    // swallow only because load() falls back to the durable snapshot.
    const ports = createMemoryPorts();
    const failingCache: SnapshotCache = {
      get: () => ports.snapshots.get(),
      put: async () => {
        throw new Error("KV unavailable");
      },
    };
    const deps: SessionDeps = {
      deltas: ports.deltas,
      snapshots: failingCache,
      blobs: ports.blobs,
      index: ports.index,
      unitOfWork: createMemoryUnitOfWork({ deltas: ports.deltas, index: ports.index }),
      cas: new FakeCas(),
      identity: { docType: "text", docId: "doc-1", userId: "user-1" },
      now: () => 1_000,
    };

    const bytes = encoder.encode("uploaded content");
    const session = new DocumentSession(makeTextDocType(), deps);

    // Resolves — this is the whole assertion.
    expect(await session.create({ bytes })).toEqual({ docId: "doc-1", version: 1 });
    expect(session.version).toBe(1);

    // Everything durable is committed, and the cache is simply empty.
    expect(await deps.deltas.head()).toBe(1);
    expect(await ports.indexQuery.list("user-1", "text")).toHaveLength(1);
    expect(await ports.snapshots.get()).toBeNull();

    // A later load() reconstructs from the durable snapshot, so nothing was
    // lost by swallowing.
    const reopened = new DocumentSession(makeTextDocType(), deps);
    expect((await reopened.query({ kind: "text" })).data).toBe("uploaded content");
  });

  // ------------------------------------------------------------------
  // Snapshot root-refs: generic TDoc SBlob traversal
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

  it("18. commits TDoc SBlob hashes as root-refs when writing a durable snapshot", async () => {
    const { session, cas } = makeHarness(1_000, undefined, makeBlobDocType());
    await session.load();

    // create() writes the durable v1 snapshot.
    await session.create();

    const snapCommits = cas.rootRefUpdates.filter((u) =>
      u.requestId.startsWith("snapshot:"),
    );
    expect(snapCommits).toHaveLength(1);
    expect(snapCommits[0]).toEqual({
      requestId: "snapshot:user-1:doc-1:1",
      changes: { [HASH_1]: 1, [HASH_2]: 1 },
    });
  });

  it("19. commits nothing to root-refs when TDoc contains no SBlob", async () => {
    const { session, cas } = makeHarness();
    await session.load();
    await session.create();

    expect(cas.rootRefUpdates).toEqual([]);
  });

  it("20. re-writing a snapshot at the same version reuses one deterministic, idempotent requestId (no double-count)", async () => {
    const { session, cas } = makeHarness(1_000, undefined, makeBlobDocType());
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
    expect(foldRootRefs(snapCommits)).toEqual({ [HASH_1]: 1, [HASH_2]: 1 });
  });

  it("9. initFromHash() adopts an existing blob as version 1", async () => {
    const { session, deps, ports } = makeHarness();
    const bytes = snapshotBytes("cloned content");
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
  // Snapshot bytes are the deterministic SValue encoding of TDoc. External
  // format adapters are used only for import/export.
  // ------------------------------------------------------------------

  it("21. internal snapshot writes bypass external formats while export uses defaultFormat", async () => {
    const { session, deps } = makeHarness(1_000, undefined, makeDistinctFormatDocType());
    await session.load();

    // create() writes the durable v1 snapshot (doc == "") and the cache.
    await session.create();
    // apply() refreshes the cache at v2 (doc == "a").
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    // 1. Cache is the SValue TDoc, not the format's deliberately different bytes.
    expect(await deps.snapshots.get()).toEqual({
      version: 2,
      bytes: snapshotBytes("a"),
    });

    // 2. Durable snapshot follows the same codec.
    const ref = await deps.deltas.latestSnapshotRef();
    expect(ref?.version).toBe(1);
    expect(await deps.blobs.get(ref!.hash)).toEqual(snapshotBytes(""));
    expect(ref!.hash).toBe(await computeHash(snapshotBytes("")));

    // 3. Export alone uses the configured external format.
    const exported = await session.exportBytes();
    expect(exported.bytes).toEqual(encoder.encode("IR:a"));
  });

  it("22. ordinary text snapshots use SValue while export remains text/plain", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    expect(await deps.snapshots.get()).toEqual({ version: 2, bytes: snapshotBytes("a") });
    const ref = await deps.deltas.latestSnapshotRef();
    expect(await deps.blobs.get(ref!.hash)).toEqual(snapshotBytes(""));
    expect((await session.exportBytes()).bytes).toEqual(encoder.encode("a"));
  });

  it("23. snapshot() returns the persisted SValue hash and clone round-trips TDoc", async () => {
    const { session, deps } = makeHarness(1_000, undefined, makeDistinctFormatDocType());
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const snap = await session.snapshot();
    expect(snap.version).toBe(2);

    const stored = await deps.blobs.get(snap.hash);
    expect(stored).not.toBeNull();
    expect(stored).toEqual(snapshotBytes("a"));
    expect(snap.hash).toBe(await computeHash(snapshotBytes("a")));

    // (b) Clone round-trips: a fresh session (its own deltas/snapshots/index and
    //     a new docId) sharing the global blob store adopts the snapshot without
    //     DocNotFoundError.
    const clonePorts = createMemoryPorts();
    const cloneDeps: SessionDeps = {
      deltas: clonePorts.deltas,
      snapshots: clonePorts.snapshots,
      blobs: deps.blobs, // shared global CAS
      index: clonePorts.index,
      unitOfWork: createMemoryUnitOfWork({
        deltas: clonePorts.deltas,
        index: clonePorts.index,
      }),
      cas: new FakeCas(),
      identity: { docType: "text", docId: "doc-2", userId: "user-1" },
      now: () => 2_000,
    };
    const clone = new DocumentSession(makeDistinctFormatDocType(), cloneDeps);
    const result = await clone.initFromHash(snap.hash, snap.version);
    expect(result).toEqual({ docId: "doc-2", version: 1 });
    expect((await clone.query({ kind: "text" })).data).toBe("a");
  });

  it("24. snapshot() hashes the canonical SValue bytes", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const snap = await session.snapshot();
    expect(snap.version).toBe(2);
    expect(snap.hash).toBe(await computeHash(snapshotBytes("a")));
    expect(await deps.blobs.get(snap.hash)).toEqual(snapshotBytes("a"));
  });

  // ------------------------------------------------------------------
  // C1: exportBytes() uses defaultFormat.save. Lazy materialization is the
  // format adapter's job (e.g. PSD's .psd save resolves PixelRefs), not a
  // DocumentType.resolve hook.
  // ------------------------------------------------------------------

  it("25. exportBytes() uses defaultFormat.save independently of snapshot encoding", async () => {
    const calls: string[] = [];
    const docType: DocumentType<string, TextQuery, TextOp> = {
      ...makeDistinctFormatDocType(),
      defaultFormat: "psd",
      formats: {
        ir: {
          mediaTypes: ["application/json"],
          extensions: [".json"],
          async load(bytes) {
            return decoder.decode(bytes);
          },
          async save(doc) {
            calls.push("ir");
            return encoder.encode(`IR:${doc}`);
          },
        },
        psd: {
          mediaTypes: ["image/vnd.adobe.photoshop"],
          extensions: [".psd"],
          async load(bytes) {
            return decoder.decode(bytes);
          },
          async save(doc) {
            calls.push("psd");
            return encoder.encode(`8BPS:${doc}`);
          },
        },
      },
    };

    const { session } = makeHarness(1_000, undefined, docType);
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "pixels" }], "pixels", 1);

    expect(calls).toEqual([]);
    const exported = await session.exportBytes();
    expect(calls).toEqual(["psd"]);
    expect(exported.bytes).toEqual(encoder.encode("8BPS:pixels"));
  });

  it("26. exportBytes() is defaultFormat.save with no DocumentType.resolve", async () => {
    const { session } = makeHarness(1_000, undefined, makeDistinctFormatDocType());
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const exported = await session.exportBytes();
    expect(exported.bytes).toEqual(encoder.encode("IR:a"));
  });

  // ------------------------------------------------------------------
  // I2: a clone must independently pin the blobs its snapshot references.
  // initFromHash adopts the source SValue snapshot as v1; it must commit the
  // snapshot's refs to root-refs under the CLONE's own requestId so the blobs
  // survive independently of the source doc's root-refs.
  // ------------------------------------------------------------------

  it("27. initFromHash() pins the cloned snapshot's referenced blobs under the clone's own requestId", async () => {
    const docType = makeBlobDocType();

    // Clone identity differs from any source: user-9 / doc-clone.
    const ports = createMemoryPorts();
    const cas = new FakeCas();
    const deps: SessionDeps = {
      deltas: ports.deltas,
      snapshots: ports.snapshots,
      blobs: ports.blobs,
      index: ports.index,
      unitOfWork: createMemoryUnitOfWork({
        deltas: ports.deltas,
        index: ports.index,
      }),
      cas,
      identity: { docType: "text", docId: "doc-clone", userId: "user-9" },
      now: () => 5_000,
    };
    const bytes = snapshotBytes({
      text: "cloned snapshot",
      blobs: [createSBlob(HASH_1), createSBlob(HASH_2)],
    });
    const hash = await computeHash(bytes);
    await deps.blobs.putIfAbsent(hash, bytes);

    const session = new DocumentSession(docType, deps);
    await session.load();
    await session.initFromHash(hash, 3);

    const snapCommits = cas.rootRefUpdates.filter((u) => u.requestId.startsWith("snapshot:"));
    expect(snapCommits).toHaveLength(1);
    expect(snapCommits[0]).toEqual({
      requestId: "snapshot:user-9:doc-clone:1",
      changes: { [HASH_1]: 1, [HASH_2]: 1 },
    });
  });

  it("28. initFromHash() pins nothing when the decoded TDoc has no SBlob", async () => {
    const { session, deps, cas } = makeHarness();
    const bytes = snapshotBytes("plain clone");
    const hash = await computeHash(bytes);
    await deps.blobs.putIfAbsent(hash, bytes);

    await session.load();
    await session.initFromHash(hash, 2);

    expect(cas.rootRefUpdates).toEqual([]);
  });
});
