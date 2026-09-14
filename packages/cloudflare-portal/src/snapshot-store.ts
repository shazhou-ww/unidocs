/**
 * Snapshot bytes live in UniCAS; D1 keeps only the reference.
 *
 * The Platform reads and retains, it does not write: an Agent writes the blob
 * directly and every node it writes is leased, which is temporary. Retaining
 * converts that lease into a business root reference and must happen AFTER the
 * surrounding D1 transaction commits, or a rejected submission would leave a
 * permanently rooted blob behind.
 */
import type { CasBlobClient } from "@unicas/tenant-blob-client";
import type { CasBlobRef } from "@unidocs/protocol-platform";

export interface SnapshotStore {
  /**
   * Returns the raw canonical SValue CBOR. Validating it against the paired
   * Document Contract's snapshot schema is the submissions endpoint's job
   * (Plan 3), not this module's: the schema is a per-version fact this store
   * has no access to.
   */
  read(ref: CasBlobRef, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  retain(ref: CasBlobRef, requestId: string): Promise<void>;
  release(ref: CasBlobRef, requestId: string): Promise<void>;
}

/**
 * The blob client names the digest `hash`; the Platform contract names it
 * `blobHash`. One mapping, in one place.
 */
function toBlobHash(ref: CasBlobRef): string {
  if (!ref.blobHash) throw new TypeError("A snapshot reference needs a blob hash");
  return ref.blobHash;
}

export function createSnapshotStore(client: CasBlobClient): SnapshotStore {
  return {
    async read(ref, signal) {
      const handle = await client.openBlob(toBlobHash(ref), signal);
      if (handle.ref.size !== ref.size) {
        throw new Error(
          `Snapshot blob ${ref.blobHash} is ${handle.ref.size} bytes, but the version record declares ${ref.size}`,
        );
      }
      return handle.read(undefined, signal);
    },

    async retain(ref, requestId) {
      await client.retain({ requestId, references: { [toBlobHash(ref)]: 1 } });
    },

    async release(ref, requestId) {
      await client.release({ requestId, references: { [toBlobHash(ref)]: 1 } });
    },
  };
}
