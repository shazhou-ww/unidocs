import { describe, expect, test } from "vitest";
import type { BlobCas, Delta, DeltaLog, SnapshotCache } from "./ports.js";
import { VersionConflictError } from "./errors.js";

function makeDelta(version: number, description = `delta ${version}`): Delta {
  return { version, timestamp: Date.now(), description, operations: [] };
}

export function runPortContract(
  label: string,
  factory: () => Promise<{ deltas: DeltaLog; snapshots: SnapshotCache; blobs: BlobCas }>,
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
