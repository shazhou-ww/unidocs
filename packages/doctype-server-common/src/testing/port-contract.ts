import { describe, expect, test } from "vitest";
import type {
  BlobCas,
  Delta,
  DeltaLog,
  SnapshotCache,
  UnitOfWork,
} from "../ports.js";
import { VersionConflictError } from "@unidocs/http-protocol";

function makeDelta(version: number, description = `delta ${version}`): Delta {
  return { version, timestamp: Date.now(), description, operations: [] };
}

export interface ConcurrencyReadiness {
  /** How many writers this harness can genuinely issue statements from at
   * the same time. The contract requires >= 2. */
  concurrentWriters: number;
  /** What the harness did to satisfy that precondition. Printed verbatim in
   * the sentinel's failure message. */
  how: string;
}

export interface PortContractOptions {
  /**
  * Whether `unitOfWork.withTransaction` really rolls back delta writes.
   *
   * `false` skips the two rollback assertions — and nothing else. This is
   * the single sanctioned behavioural fork between backends; every other
   * test in this file must pass everywhere.
   */
  transactional: boolean;
  /**
   * Required, with no default — same reasoning as `transactional`: a
   * precondition that CAN be omitted is a precondition that WILL be omitted.
   *
   * The concurrency sentinel only observes anything if two writers can
   * genuinely issue statements at the same time. On Postgres this needs a
   * warmed connection pool (`pg.Pool` opens connections lazily, so after a
   * run of sequential statements it holds exactly one, and the second writer
   * then waits ~4ms for a TCP connect + auth handshake, reading the head
   * only after the first writer has already committed). That precondition
   * used to live only inside `azure-sdk/tests/ports.test.ts`, invisible to
   * the contract. The contract now asks the harness to prove it.
   */
  prepareConcurrency: () => Promise<ConcurrencyReadiness>;
}

export function runPortContract(
  label: string,
  factory: () => Promise<{
    deltas: DeltaLog;
    snapshots: SnapshotCache;
    blobs: BlobCas;
    unitOfWork: UnitOfWork;
  }>,
  // Required, with no default. A default of `false` would let a backend that
  // CAN roll back — the Postgres adapter this suite exists to guard — skip
  // the two most important tests here by omission, and the skip would even
  // print "backend has no cross-store transaction" as its justification. An
  // author who must type the answer has to know it.
  options: PortContractOptions,
): void {
  // Named in the test title so a skipped run reads as "this backend cannot
  // do it", not as "someone forgot to write it".
  const txTest = test.skipIf(!options.transactional);
  const txNote = options.transactional
    ? ""
    : " [skipped: backend has no cross-store transaction]";

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
      const readiness = await options.prepareConcurrency();
      expect(
        readiness.concurrentWriters,
        `This backend's harness reported only ${readiness.concurrentWriters} concurrent writer(s) ` +
          `("${readiness.how}"). The sentinel below cannot observe a race with fewer than 2, ` +
          `and would pass without testing anything.`,
      ).toBeGreaterThanOrEqual(2);

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

    // remove() is the root-refs-failure compensation for `apply()`. It must
    // be conditional on `v` still being the head: once a concurrent writer
    // has appended on top of it, deleting `v` would tear a hole in the log
    // that replay silently skips over — see the contract note on
    // DeltaLog.remove. This is the race from the design doc: A appends v,
    // B appends v+1 on top of A's (still uncommitted) delta, A's root-refs
    // commit then fails and tries to remove(v) — that must be a no-op, not
    // a deletion of a delta B's version now depends on.
    test("remove(v) is a no-op once a later delta has been appended on top of v", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2)); // "v" — the one that will be removed
      await deltas.append(makeDelta(3)); // committed on top of v before the remove

      await deltas.remove(2);

      // No gap: head is unchanged and version 2 is still in the log.
      expect(await deltas.head()).toBe(3);
      expect((await deltas.range(2, 2)).map((d) => d.version)).toEqual([2]);
      expect((await deltas.range()).map((d) => d.version)).toEqual([1, 2, 3]);
    });

    // The other half of the same compensation path: when remove() DOES apply
    // (v is still head, nothing landed on top of it), a caller must be able
    // to retry — append the same version again — and have it succeed. This
    // is exactly what a failed root-refs commit does next.
    test("append(v) after remove(v) succeeds when v was the head that got removed", async () => {
      const { deltas } = await factory();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));
      await deltas.remove(2);
      expect(await deltas.head()).toBe(1);

      await expect(deltas.append(makeDelta(2, "retry"))).resolves.toBeUndefined();
      expect(await deltas.head()).toBe(2);
      expect((await deltas.range(2, 2))[0]?.description).toBe("retry");
    });

    /**
     * remove() and append() have a **known, deliberately accepted** window
     * (see design doc section 9): remove(v) confirms v is still head, then
     * deletes; between those two steps another writer can append(v+1),
     * leaving a hole behind.
     *
     * This case does not fix that window — it pins it in the open. Three
     * outcomes are legitimate:
     *   - remove loses entirely (append(3) commits before remove(2) even
     *     starts): the hole is missed -> [1, 2, 3], append(3) fulfilled.
     *   - remove wins entirely (remove(2) completes — check AND delete —
     *     before append(3) starts): head drops to 1, and append(3) then
     *     correctly conflicts because head + 1 is 2, not 3 -> [1], append(3)
     *     rejected with VersionConflictError. This is plain serialization,
     *     not a race outcome at all, but it is the ONLY thing that can
     *     happen on a backend whose remove() has no await between its check
     *     and its delete (this contract's in-memory ports; a Durable
     *     Object, which serialises every call so remove and append can
     *     never overlap) — Promise.allSettled's array literal still invokes
     *     remove() first, and a synchronous body runs to completion before
     *     the second element is even evaluated.
     *   - both see the pre-removal head and both proceed: the accepted hole
     *     -> [1, 3], append(3) fulfilled.
     *
     * `[1]` only earns its place in the allowed set by having its cause
     * checked, not merely its shape: append(3) must have been REJECTED, and
     * rejected specifically with VersionConflictError. Without that check,
     * `[1]` would also match a strictly worse shape this test exists to
     * rule out — append(3) reporting success while its own delta silently
     * vanishes — which the original two-outcome set caught only by
     * accident (that shape wasn't in `[[1,2,3],[1,3]]` either, but for the
     * wrong reason: because the set was too narrow, not because the shape
     * was checked for). Symmetrically, whenever append(3) DOES fulfill,
     * the assertion demands version 3 actually be present in the log,
     * ruling out "reported success but didn't stick" there too.
     *
     * What this case does NOT prove: whether remove()'s own guard is
     * conditional on v still being head. remove()'s outcome is never
     * inspected here — the contract does not currently promise anything
     * about how a no-op remove reports itself, so both a clean no-op and a
     * throw are tolerated equally. Concretely, this test cannot tell a
     * correctly conditional remove from a naive, unconditional
     * `DELETE ... WHERE version = v`: an unconditional remove that deletes
     * v after append(3) has already committed produces exactly [1, 3] —
     * indistinguishable from the accepted hole. Coverage for "remove only
     * touches v when v is still head" comes from the earlier, non-racing
     * "remove(v) is a no-op once a later delta has been appended on top of
     * v" case above, not from this one.
     */
    test("remove(v) racing append(v+1): the accepted window is visible, nothing worse happens", async () => {
      const { deltas } = await factory();
      await options.prepareConcurrency();
      await deltas.append(makeDelta(1));
      await deltas.append(makeDelta(2));

      // remove()'s own settlement is deliberately not inspected — see the
      // comment above on what this case does and does not prove.
      const [, appendResult] = await Promise.allSettled([
        deltas.remove(2),
        deltas.append(makeDelta(3)),
      ]);

      const versions = (await deltas.range()).map((d) => d.version);
      expect([[1, 2, 3], [1, 3], [1]]).toContainEqual(versions);
      expect(await deltas.head()).toBe(Math.max(...versions));
      expect(versions).toEqual([...versions].sort((a, b) => a - b));

      if (appendResult.status === "fulfilled") {
        // append(3) landed: version 3 must actually be present, not merely
        // reported as written.
        expect(versions).toContain(3);
      } else {
        // append(3) was rejected: it must be rejected for the specific
        // reason that makes [1] safe rather than silent data loss — a
        // stale-head conflict, not some other failure.
        expect(appendResult.reason).toBeInstanceOf(VersionConflictError);
      }
    });

    /**
     * Document-scope predicates. On dedicated storage (Cloudflare: one
     * private sqlite per DO) this is nearly impossible to get wrong; on a
     * shared-table backend (Postgres: every document in one `deltas` table)
     * a missing `WHERE doc_id = ...` is the easiest mistake to make and the
     * hardest to catch by reading the code — it looks correct until it runs.
     */
    test("DeltaLog: operating on one document neither affects nor reads another", async () => {
      const a = await factory();
      const b = await factory();

      await a.deltas.append(makeDelta(1, "doc-a-v1"));
      await a.deltas.append(makeDelta(2, "doc-a-v2"));
      await b.deltas.append(makeDelta(1, "doc-b-v1"));
      // `b` gets a version 2 too, matching the version `a.deltas.remove(2)`
      // below removes: on a shared-table backend, a `remove()` missing
      // `WHERE doc_id = ...` (or whose "is this the head" subquery is
      // missing it) would delete *any* row at version 2, `b`'s included —
      // not just `a`'s. Without this second delta, `b` only ever holds
      // version 1, so a doc-id-blind `remove(2)` has nothing of `b`'s to
      // delete and the test passes regardless of whether the SQL is scoped.
      await b.deltas.append(makeDelta(2, "doc-b-v2"));

      expect(await a.deltas.head()).toBe(2);
      expect(await b.deltas.head()).toBe(2);
      expect((await b.deltas.range()).map((d) => d.description)).toEqual([
        "doc-b-v1",
        "doc-b-v2",
      ]);

      await a.deltas.remove(2);
      expect(await b.deltas.head()).toBe(2);
      expect((await b.deltas.range()).map((d) => d.description)).toEqual([
        "doc-b-v1",
        "doc-b-v2",
      ]);
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

    test("BlobCas: putIfAbsent is idempotent, get roundtrips, unknown hash is null", async () => {
      const { blobs } = await factory();
      const bytes = new Uint8Array([9, 8, 7]);
      await blobs.putIfAbsent("hash-a", bytes);
      await blobs.putIfAbsent("hash-a", bytes);
      expect(await blobs.get("hash-a")).toEqual(bytes);
      expect(await blobs.get("unknown-hash")).toBeNull();
    });

    // ------------------------------------------------------------------
    // UnitOfWork
    //
    // Session creation appends the version-1 delta and its durable snapshot
    // record through this one transaction-local DeltaLog.
    // ------------------------------------------------------------------

    txTest(
      `withTransaction: a throw inside the callback rolls back everything it wrote${txNote}`,
      async () => {
        const { deltas, unitOfWork } = await factory();
        await deltas.append(makeDelta(1));
        const headBefore = await deltas.head();

        const boom = new Error("callback failed");
        await expect(
          unitOfWork.withTransaction(async (tx) => {
            await tx.deltas.append(makeDelta(headBefore + 1, "doomed"));
            throw boom;
          }),
        ).rejects.toBe(boom);

        expect(await deltas.head()).toBe(headBefore);
        expect(await deltas.range(headBefore + 1, headBefore + 1)).toEqual([]);
      },
    );

    txTest(
      `withTransaction: a normal return commits every write in the callback${txNote}`,
      async () => {
        const { deltas, unitOfWork } = await factory();

        const result = await unitOfWork.withTransaction(async (tx) => {
          await tx.deltas.append(makeDelta(1, "committed"));
          return "returned";
        });

        expect(result).toBe("returned");
        expect(await deltas.head()).toBe(1);
        expect((await deltas.range(1, 1))[0]?.description).toBe("committed");
      },
    );
  });
}
