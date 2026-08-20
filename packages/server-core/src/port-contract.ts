import { describe, expect, test } from "vitest";
import type {
  BlobCas,
  Delta,
  DeltaLog,
  DocIndex,
  DocIndexQuery,
  SnapshotCache,
} from "./ports.js";
import { VersionConflictError } from "./errors.js";

function makeDelta(version: number, description = `delta ${version}`): Delta {
  return { version, timestamp: Date.now(), description, operations: [] };
}

export function runPortContract(
  label: string,
  factory: () => Promise<{
    deltas: DeltaLog;
    snapshots: SnapshotCache;
    blobs: BlobCas;
    index: DocIndex;
    indexQuery: DocIndexQuery;
  }>,
): void {
  describe(label, () => {
    test("head() starts at 0, becomes the appended version after append", async () => {
      const { deltas } = await factory();
      expect(await deltas.head()).toBe(0);
      await deltas.append(makeDelta(1));
      expect(await deltas.head()).toBe(1);
    });

    test("duplicate append throws VersionConflictError carrying the current head", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await expect(deltas.append(makeDelta(1))).rejects.toThrow(VersionConflictError);
      try {
        await deltas.append(makeDelta(1));
        throw new Error("expected append to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(VersionConflictError);
        expect((err as VersionConflictError).currentVersion).toBe(await deltas.head());
        expect((err as VersionConflictError).attempted).toBe(1);
      }
    });

    test("append rejects a version ahead of head + 1, leaving no gap", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      const head = await deltas.head();

      try {
        await deltas.append(makeDelta(head + 2));
        throw new Error("expected append to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(VersionConflictError);
        expect((err as VersionConflictError).currentVersion).toBe(head);
        expect((err as VersionConflictError).attempted).toBe(head + 2);
      }

      expect(await deltas.head()).toBe(head);
      expect((await deltas.range()).length).toBe(2);
    });

    test("append rejects a version behind head + 1", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      await expect(deltas.append(makeDelta(2))).rejects.toBeInstanceOf(VersionConflictError);
      expect(await deltas.head()).toBe(2);
    });

    // This one exists because the check-and-insert in `append` MUST be a
    // single atomic operation — a primary key, a conditional insert, an ETag.
    // Any implementation that reads `SELECT MAX(version)` and then INSERTs is
    // two steps with a window in between, and two concurrent writers will both
    // clear the check and both write the same version.
    //
    // This is not hypothetical: the in-memory implementation was first written
    // as `const head = await this.head()` followed by a push, and that single
    // `await` was enough of a yield point for both concurrent appends to slip
    // through. It was only caught by a session-level concurrency test, which a
    // phase-2 backend author never runs — they run this contract. Hence the
    // sentinel lives here.
    test("concurrent appends of the same version: exactly one wins", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      const head = await deltas.head();

      const results = await Promise.allSettled([
        deltas.append(makeDelta(head + 1, "writer A")),
        deltas.append(makeDelta(head + 1, "writer B")),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        VersionConflictError,
      );

      // The loser left nothing behind: one record at that version, head moved
      // forward by exactly one.
      expect(await deltas.range(head + 1, head + 1)).toHaveLength(1);
      expect(await deltas.head()).toBe(head + 1);
    });

    test("since(v) returns only versions > v, ascending", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      await deltas.append(makeDelta(3));
      const result = await deltas.since(1);
      expect(result.map((d) => d.version)).toEqual([2, 3]);
    });

    test("range(from, to) is inclusive on both ends; omitting both returns everything", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      await deltas.append(makeDelta(3));
      await deltas.append(makeDelta(4));
      expect((await deltas.range(2, 3)).map((d) => d.version)).toEqual([2, 3]);
      expect((await deltas.range()).map((d) => d.version)).toEqual([1, 2, 3, 4]);
    });

    test("remove(v) rolls head() back to the previous version", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      expect(await deltas.head()).toBe(2);
      await deltas.remove(2);
      expect(await deltas.head()).toBe(1);
    });

    test("recordSnapshot + latestSnapshotRef: latest, atOrBefore, and null before all", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      await deltas.append(makeDelta(3));
      await deltas.recordSnapshot(1, "hash-1", 100);
      await deltas.recordSnapshot(3, "hash-3", 300);

      expect(await deltas.latestSnapshotRef()).toEqual({ version: 3, hash: "hash-3" });
      expect(await deltas.latestSnapshotRef(2)).toEqual({ version: 1, hash: "hash-1" });
      expect(await deltas.latestSnapshotRef(0)).toBeNull();
    });

    test("countSince(v) counts deltas with version > v", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      await deltas.append(makeDelta(3));
      expect(await deltas.countSince(0)).toBe(3);
      expect(await deltas.countSince(1)).toBe(2);
      expect(await deltas.countSince(3)).toBe(0);
    });

    test("SnapshotCache: get() is null when empty; put then get roundtrips", async () => {
      const { snapshots } = await factory();
      expect(await snapshots.get()).toBeNull();
      const bytes = new Uint8Array([1, 2, 3]);
      await snapshots.put(5, bytes);
      expect(await snapshots.get()).toEqual({ version: 5, bytes });
    });

    // DocIndex.register() must precede recordSnapshot()/touch() for a
    // document — the index learns the identity it keys those rows by from
    // register, and may drop calls for a document it has never seen. That is
    // exactly what happened once: a session snapshotted before registering
    // and the creation-time snapshot was silently dropped, while the delta
    // log's own copy of the same snapshot wrote fine. Assert the state the
    // index KEPT, never merely that the method was called.
    test("DocIndex: a snapshot recorded after register() is readable back", async () => {
      const { index, indexQuery } = await factory();
      const now = 1_700_000_000_000;

      await index.register({
        docId: "doc-1",
        docType: "text",
        ownerId: "user-1",
        createdAt: now,
        updatedAt: now,
      });
      await index.recordSnapshot(1, "hash-1", now);
      await index.recordSnapshot(21, "hash-21", now + 1);

      expect(await indexQuery.snapshots("text", "doc-1")).toEqual([
        { version: 1, hash: "hash-1" },
        { version: 21, hash: "hash-21" },
      ]);
    });

    test("DocIndex: snapshots() is ascending by version and empty for an unknown document", async () => {
      const { index, indexQuery } = await factory();
      const now = 1_700_000_000_000;
      await index.register({
        docId: "doc-1",
        docType: "text",
        ownerId: "user-1",
        createdAt: now,
        updatedAt: now,
      });
      await index.recordSnapshot(41, "hash-41", now);
      await index.recordSnapshot(21, "hash-21", now);
      await index.recordSnapshot(1, "hash-1", now);

      expect((await indexQuery.snapshots("text", "doc-1")).map((r) => r.version)).toEqual([
        1, 21, 41,
      ]);
      expect(await indexQuery.snapshots("text", "no-such-doc")).toEqual([]);
      expect(await indexQuery.snapshots("no-such-type", "doc-1")).toEqual([]);
    });

    test("DocIndex: register() then list() finds the document by owner and type", async () => {
      const { index, indexQuery } = await factory();
      const now = 1_700_000_000_000;
      await index.register({
        docId: "doc-1",
        docType: "text",
        ownerId: "user-1",
        createdAt: now,
        updatedAt: now,
      });
      expect(await indexQuery.list("user-1", "text")).toHaveLength(1);
      expect(await indexQuery.list("user-2", "text")).toEqual([]);
      expect(await indexQuery.list("user-1", "other")).toEqual([]);
    });

    // list() must sort by updatedAt descending, not insertion/physical order
    // — a "recently updated" list UI depends on this. Register the docs in
    // an order that does NOT match updatedAt order, so a naive
    // insertion-order implementation would fail this.
    test("DocIndex: list() is ordered by updatedAt descending", async () => {
      const { index, indexQuery } = await factory();
      const now = 1_700_000_000_000;

      await index.register({
        docId: "doc-mid",
        docType: "text",
        ownerId: "user-1",
        createdAt: now,
        updatedAt: now + 10,
      });
      await index.register({
        docId: "doc-newest",
        docType: "text",
        ownerId: "user-1",
        createdAt: now,
        updatedAt: now + 20,
      });
      await index.register({
        docId: "doc-oldest",
        docType: "text",
        ownerId: "user-1",
        createdAt: now,
        updatedAt: now,
      });

      expect((await indexQuery.list("user-1", "text")).map((r) => r.docId)).toEqual([
        "doc-newest",
        "doc-mid",
        "doc-oldest",
      ]);
    });

    test("BlobCas: putIfAbsent is idempotent, get roundtrips, unknown hash is null", async () => {
      const { blobs } = await factory();
      const bytes = new Uint8Array([9, 8, 7]);
      await blobs.putIfAbsent("hash-a", bytes);
      await blobs.putIfAbsent("hash-a", bytes);
      expect(await blobs.get("hash-a")).toEqual(bytes);
      expect(await blobs.get("unknown-hash")).toBeNull();
    });
  });
}
