import { describe, expect, it } from "vitest";
import { createSBlob, encodeSValue } from "@unidocs/svalue-codec";
import type { CasRef, CasReferences, DocumentType, SBlob, SValue } from "@unidocs/protocol";
import type {
  Delta,
  DeltaLog,
  SnapshotCache,
} from "../src/ports.js";
import {
  createMemoryPorts,
  createMemoryUnitOfWork,
} from "../src/memory-ports.js";
import { computeHash } from "../src/hash.js";
import {
  DeltaRejectedError,
  DocExistsError,
  RootRefsError,
  StorageCorruptError,
  VersionConflictError,
} from "@unidocs/protocol-doc";
import { CasClientError } from "@unicas/tenant-client";
import { DocumentSession, type CasGateway, type SessionDeps } from "../src/session.js";
import { createSessionHandler } from "../src/session-handler.js";

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

  async leaseNode(hash: string): Promise<unknown> {
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

function makeHarness(
  startTime = 1_000,
  deltaLog?: DeltaLog,
  docType: DocumentType<any, TextQuery, TextOp> = makeTextDocType(),
) {
  const ports = createMemoryPorts();
  const cas = new FakeCas();
  const deltas = deltaLog ?? ports.deltas;
  let clock = startTime;
  const deps: SessionDeps = {
    deltas,
    snapshots: ports.snapshots,
    blobs: ports.blobs,
    // Built over the ports this harness actually injects, not over the raw
    // memory ports — a transaction that rolled back a different delta log
    // than the session writes to would prove nothing.
    unitOfWork: createMemoryUnitOfWork({ deltas }),
    cas,
    identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
    now: () => clock++,
  };
  const session = new DocumentSession(docType, deps);
  return { ports, cas, deps, session };
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

    const failure = new CasClientError(409, "Conflict", "lease");
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
  it("5. create() writes version 1, an empty delta and a durable snapshot", async () => {
    const { session, deps } = makeHarness();
    await session.load();

    const result = await session.create();

    expect(result).toEqual({ sessionId: "session-1", version: 1 });
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

    // Snapshot cache refreshed too.
    expect(await deps.snapshots.get()).toEqual({ version: 1, bytes: snapshotBytes("") });
  });

  it("6. snapshots every 20 deltas: after 21 applies the latest snapshot is version 21", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();

    for (let i = 0; i < 21; i++) {
      await session.apply([{ kind: "append", text: "x" }], `op ${i}`, session.version);
    }

    expect(session.version).toBe(22);
    const ref = await deps.deltas.latestSnapshotRef();
    expect(ref?.version).toBe(21);
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
    await expect(session.create()).resolves.toEqual({ sessionId: "session-1", version: 1 });
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
    const { session } = makeHarness(1_000, racing);

    await expect(session.create()).rejects.toBeInstanceOf(VersionConflictError);

    // Nothing was committed: no document and no version.
    expect(session.initialized).toBe(false);
    expect(session.version).toBe(0);
  });

  it("21. create() commits blob, delta snapshot and snapshot cache", async () => {
    const { session, deps } = makeHarness();
    const bytes = encoder.encode("hello");

    await session.create({ bytes });

    const persisted = snapshotBytes("hello");
    const hash = await computeHash(persisted);

    // 1. blob
    expect(await deps.blobs.get(hash)).toEqual(persisted);
    // 2. delta log: version 1 plus its snapshot ref
    expect(await deps.deltas.head()).toBe(1);
    expect(await deps.deltas.latestSnapshotRef()).toEqual({ version: 1, hash });
    // 3. snapshot cache
    expect(await deps.snapshots.get()).toEqual({ version: 1, bytes: persisted });
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
      unitOfWork: createMemoryUnitOfWork({ deltas: ports.deltas }),
      cas: new FakeCas(),
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
      now: () => 1_000,
    };

    const bytes = encoder.encode("uploaded content");
    const session = new DocumentSession(makeTextDocType(), deps);

    // Resolves — this is the whole assertion.
    expect(await session.create({ bytes })).toEqual({ sessionId: "session-1", version: 1 });
    expect(session.version).toBe(1);

    // Everything durable is committed, and the cache is simply empty.
    expect(await deps.deltas.head()).toBe(1);
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
      requestId: "snapshot:session-1:1",
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
      new Set(["snapshot:session-1:1"]),
    );
    // Folded with the worker's real dedupe rule, each blob is pinned once.
    expect(foldRootRefs(snapCommits)).toEqual({ [HASH_1]: 1, [HASH_2]: 1 });
  });

  it("9. initFromHash() adopts an existing blob as version 1", async () => {
    const { session, deps } = makeHarness();
    const bytes = snapshotBytes("cloned content");
    const hash = await computeHash(bytes);
    await deps.blobs.putIfAbsent(hash, bytes);

    await session.load();
    const result = await session.initFromHash(hash, 7);

    expect(result).toEqual({ sessionId: "session-1", version: 1 });
    expect((await session.query({ kind: "text" })).data).toBe("cloned content");

    const history = await session.history();
    expect(history).toHaveLength(1);
    expect(history[0].description).toBe(
      `Cloned from snapshot ${hash} (source version 7)`,
    );
    expect(history[0].operations).toEqual([]);

    // The snapshot reference points at the adopted blob — no new blob written.
    expect(await deps.deltas.latestSnapshotRef()).toEqual({ version: 1, hash });
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
    //     a new sessionId) sharing the global blob store adopts the snapshot without
    //     DocNotFoundError.
    const clonePorts = createMemoryPorts();
    const cloneDeps: SessionDeps = {
      deltas: clonePorts.deltas,
      snapshots: clonePorts.snapshots,
      blobs: deps.blobs, // shared global CAS
      unitOfWork: createMemoryUnitOfWork({
        deltas: clonePorts.deltas,
      }),
      cas: new FakeCas(),
      identity: { docType: "text", sessionId: "session-2", tenantId: "tenant-1" },
      now: () => 2_000,
    };
    const clone = new DocumentSession(makeDistinctFormatDocType(), cloneDeps);
    const result = await clone.initFromHash(snap.hash, snap.version);
    expect(result).toEqual({ sessionId: "session-2", version: 1 });
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

  it("24b. ir() returns canonical current-TDoc bytes without calling a format", async () => {
    const { session } = makeHarness(1_000, undefined, makeDistinctFormatDocType());
    await session.load();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "a", 1);

    const ir = await session.ir();
    expect(ir.version).toBe(2);
    expect(ir.bytes).toEqual(snapshotBytes("a"));
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
      unitOfWork: createMemoryUnitOfWork({
        deltas: ports.deltas,
      }),
      cas,
      identity: { docType: "text", sessionId: "session-clone", tenantId: "tenant-9" },
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
      requestId: "snapshot:session-clone:1",
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

// --------------------------------------------------------------------------
// opId idempotency (Task 4, plan 2026-08-22-psd-docsession-sync)
// --------------------------------------------------------------------------

describe("DocumentSession.apply — opId idempotency", () => {
  it("P0: a reused opId does not validate a different payload in the same instance", async () => {
    const { session } = makeHarness();
    await session.create();
    await session.apply([{ kind: "append", text: "a" }], "first", 1, "op-fixed");

    const result = await session.apply([{ kind: "append", text: "different" }], "changed", 2, "op-fixed");

    expect(result.version).toBe(2);
    expect((await session.query({ kind: "text" })).data).toBe("a");
  });

  it("P0: a fresh instance cannot confirm a committed opId after a lost acknowledgement", async () => {
    const { session, deps } = makeHarness();
    await session.create();
    const operations: TextOp[] = [{ kind: "append", text: "a" }];
    await session.apply(operations, "first", 1, "op-fixed");

    const restored = new DocumentSession(makeTextDocType(), deps);
    await expect(restored.apply(operations, "first", 1, "op-fixed")).rejects.toBeInstanceOf(VersionConflictError);
    expect((await restored.query({ kind: "text" })).data).toBe("a");
    expect(await deps.deltas.head()).toBe(2);
  });

  it("P0: snapshot cache failure can reject apply after the delta committed", async () => {
    const { session, deps } = makeHarness();
    await session.create();
    deps.snapshots = {
      get: () => Promise.resolve(null),
      put: async () => { throw new Error("cache unavailable"); },
    };
    const operations: TextOp[] = [{ kind: "append", text: "a" }];

    await expect(session.apply(operations, "first", 1, "op-fixed")).rejects.toThrow("cache unavailable");
    expect(await deps.deltas.head()).toBe(2);
    expect((await session.query({ kind: "text" })).data).toBe("a");
    await expect(session.apply(operations, "first", 1, "op-fixed")).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("29. the same opId applied twice does not double-apply — second call returns the first call's version and the doc is unchanged", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();

    const first = await session.apply(
      [{ kind: "append", text: "a" }],
      "a",
      1,
      "op-1",
    );
    expect(first.version).toBe(2);

    const before = await deltaCount(deps);
    const docBefore = (await session.query({ kind: "text" })).data;

    const second = await session.apply(
      [{ kind: "append", text: "a" }],
      "a",
      1,
      "op-1",
    );

    expect(second.version).toBe(2);
    expect(session.version).toBe(2);
    expect(await deltaCount(deps)).toBe(before);
    expect((await session.query({ kind: "text" })).data).toBe(docBefore);
    expect((await session.query({ kind: "text" })).data).toBe("a");
  });

  it("30. a retried op with a stale baseVersion but a seen opId returns success instead of 409", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();

    const first = await session.apply(
      [{ kind: "append", text: "a" }],
      "a",
      1,
      "op-1",
    );
    expect(first.version).toBe(2);

    // A second, unrelated apply advances the doc/version further, so op-1's
    // original baseVersion (1) is now stale against the log head.
    await session.apply([{ kind: "append", text: "b" }], "b", 2);
    expect(session.version).toBe(3);

    const before = await deltaCount(deps);

    // The client retries op-1 with its original (now-stale) baseVersion.
    const retried = await session.apply(
      [{ kind: "append", text: "a" }],
      "a",
      1,
      "op-1",
    );

    expect(retried.version).toBe(2);
    expect(session.version).toBe(3);
    expect(await deltaCount(deps)).toBe(before);
  });

  it("31. two different opIds both apply normally and each advances the version", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    const afterCreate = await deltaCount(deps);

    const first = await session.apply(
      [{ kind: "append", text: "a" }],
      "a",
      1,
      "op-1",
    );
    expect(first.version).toBe(2);

    const second = await session.apply(
      [{ kind: "append", text: "b" }],
      "b",
      2,
      "op-2",
    );
    expect(second.version).toBe(3);

    expect(session.version).toBe(3);
    expect(await deltaCount(deps)).toBe(afterCreate + 2);
    expect((await session.query({ kind: "text" })).data).toBe("ab");
  });

  it("32. an absent opId behaves exactly as before — no dedup, normal apply every time", async () => {
    const { session, deps } = makeHarness();
    await session.load();
    await session.create();
    const afterCreate = await deltaCount(deps);

    const first = await session.apply([{ kind: "append", text: "a" }], "a", 1);
    expect(first.version).toBe(2);

    const second = await session.apply([{ kind: "append", text: "a" }], "a", 2);
    expect(second.version).toBe(3);

    expect(session.version).toBe(3);
    expect(await deltaCount(deps)).toBe(afterCreate + 2);
    expect((await session.query({ kind: "text" })).data).toBe("aa");
  });
});

// --------------------------------------------------------------------------
// 格式选择:导入与导出
// --------------------------------------------------------------------------

/** 在文本 doctype 上再挂一个 "upper" 格式,用来观察到底选中了哪一个。
 *  两个格式的 mediaTypes / extensions 不重叠,所以不会触发歧义。
 *  基础那一项沿用 makeTextDocType 的 `text`,连 defaultFormat 一起不动——
 *  这几条断言要证的正是"默认路径没变"。
 *
 *  顶层 contentType 故意覆盖成一个跟 formats.text.mediaTypes[0]
 *  ("text/plain")不一样的值。护栏 2 要区分的正是"顶层 config.contentType"
 *  和"所选格式的 mediaTypes[0]"这两个值——沿用 makeTextDocType 的
 *  contentType("text/plain"恰好和 defaultFormat 的 mediaTypes[0] 相同)会让
 *  这两个值永远相等,任何断言都观察不到 exportBytes/session-handler 到底
 *  用了哪一个,测试因此恒绿钉不住任何东西。 */
function makeTwoFormatDocType(): DocumentType<string, TextQuery, TextOp> {
  const inner = makeTextDocType();
  return {
    ...inner,
    formats: {
      ...inner.formats,
      upper: {
        mediaTypes: ["text/x-upper"],
        extensions: [".upper"],
        async load(bytes: Uint8Array) { return decoder.decode(bytes).toUpperCase(); },
        async save(doc: string) { return encoder.encode(doc.toUpperCase()); },
      },
    },
    contentType: "text/x-session-top-level",
  };
}

describe("DocumentSession.create — 格式选择", () => {
  it("给了 format 就用那个格式 load", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi"), format: "upper" });
    expect(await session.query({ kind: "text" })).toMatchObject({ data: "HI" });
  });

  // 回归护栏:不传 format 必须与今天逐字节一致。这条比上面那条更重要——
  // 今天所有的上传走的都是这条路。
  it("不传 format 就用 defaultFormat,与今天一致", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });
    expect(await session.query({ kind: "text" })).toMatchObject({ data: "hi" });
  });

  it("给了没注册过的 format 就抛错", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await expect(session.create({ bytes: encoder.encode("hi"), format: "jpeg" }))
      .rejects.toThrow("Unknown format: jpeg");
  });
});

describe("DocumentSession.exportBytes — 格式选择", () => {
  it("给了格式名就用那个格式 save,contentType 取该格式的 mediaTypes[0]", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });

    const exported = await session.exportBytes("upper");
    expect(decoder.decode(exported.bytes)).toBe("HI");
    expect(exported.contentType).toBe("text/x-upper");
  });

  // 回归护栏:不带参数必须与今天完全一致——defaultFormat 的 save,
  // 加上**顶层的 config.contentType**(不是格式自己的 mediaTypes[0])。
  // fixture 的顶层 contentType 被覆盖成 "text/x-session-top-level",跟
  // defaultFormat("text")自己的 mediaTypes[0]("text/plain")不同——两者
  // 不相等,这条断言才有区分力。
  it("不带参数时用 defaultFormat 与顶层 contentType", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });

    const exported = await session.exportBytes();
    expect(decoder.decode(exported.bytes)).toBe("hi");
    expect(exported.contentType).toBe("text/x-session-top-level");
  });

  // 配对断言:显式指定 defaultFormat 自己的名字("text")时,即使字节结果和
  // "不带参数"完全一样,contentType 也必须切到 format.mediaTypes[0]
  // ("text/plain"),而不是顶层的 "text/x-session-top-level"。这条和上面
  // 那条一起,才把"顶层 contentType" vs "所选格式的 mediaTypes[0]"这两条
  // 分支真正分开验证。
  it("显式指定 defaultFormat 自己的名字时,contentType 切到该格式的 mediaTypes[0]", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });

    const exported = await session.exportBytes("text");
    expect(decoder.decode(exported.bytes)).toBe("hi");
    expect(exported.contentType).toBe("text/plain");
  });

  it("给了没注册过的格式名就抛错", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });
    await expect(session.exportBytes("jpeg")).rejects.toThrow("Unknown format: jpeg");
  });
});

describe("session-handler historical read compatibility", () => {
  it("P0: an unsupported version parameter on ir still returns the current version", async () => {
    const { session, deps } = makeHarness();
    await session.create({ bytes: encoder.encode("original") });
    await session.apply([{ kind: "append", text: " updated" }], "update", 1);
    const handle = createSessionHandler({ session, identity: deps.identity });

    const response = await handle(new Request("https://svc/_internal/ir?version=1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Doc-Version")).toBe("2");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(snapshotBytes("original updated"));
    expect(await deps.deltas.head()).toBe(2);
  });
});

describe("session-handler GET /_internal/export — 空 ?format= 护栏", () => {
  // `url.searchParams.get("format")` 对 `?format=`(等号后面是空的)给出 ""
  // 而不是 null——`??` 挡不住它,只有 `||` 才行。这条钉住:带一个空的
  // `?format=` 必须和完全不带该参数的响应逐字节等价,不能因为 "" 被当成
  // 「显式指定了格式」而切到 format.mediaTypes[0] 当 Content-Type。
  //
  // 这条必须走真正的 HTTP handler(createSessionHandler),不能只在
  // session.exportBytes() 层面断言——bug 出在 session-handler.ts 解析
  // query string 的那一行,session.exportBytes() 本身的行为在两种调用方式
  // 下都是"忠实执行调用方传来的 formatName",看不出 handler 有没有把 ""
  // 错当成"指定了格式"传进去。
  //
  // 断言值必须是 fixture 里刻意覆盖的顶层 contentType
  // ("text/x-session-top-level"),而不是 defaultFormat 的 mediaTypes[0]
  // ("text/plain")——两者不同,断言才有区分力:如果 handler 把 "" 误当成
  // 显式格式名传给 exportBytes,Content-Type 会变成 "text/plain",而不是
  // 期望的顶层值,断言会失败而不是巧合地通过。
  it("?format=(空值)与完全不带该参数的响应等价", async () => {
    const { session } = makeHarness(1_000, undefined, makeTwoFormatDocType());
    await session.load();
    await session.create({ bytes: encoder.encode("hi") });

    const handle = createSessionHandler({
      session,
      identity: { docType: "text", sessionId: "session-1", tenantId: "tenant-1" },
    });

    const withoutParam = await handle(new Request("https://svc/_internal/export"));
    const withEmptyParam = await handle(new Request("https://svc/_internal/export?format="));

    expect(withEmptyParam.headers.get("Content-Type")).toBe("text/x-session-top-level");
    expect(withEmptyParam.headers.get("Content-Type"))
      .toBe(withoutParam.headers.get("Content-Type"));
    expect(withEmptyParam.headers.get("Content-Disposition"))
      .toBe(withoutParam.headers.get("Content-Disposition"));
  });
});
