/**
 * R2-backed BlobStore adapter.
 *
 * Content-addressed store for doctype-managed blobs (e.g. per-layer PNG
 * pixel data). Uses the same hash as editor-do.ts's snapshot bytes so CAS
 * keys never diverge across the two callers.
 */
import type { R2Bucket } from "@cloudflare/workers-types";
import type { BlobStore } from "@unidocs/core";
import { computeHash } from "./content-hash.js";

export function createR2BlobStore(cas: R2Bucket): BlobStore {
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const hash = await computeHash(bytes);
      // R2 is content-addressed, so this put is idempotent per unique content.
      await cas.put(hash, bytes);
      return hash;
    },

    async get(hash: string): Promise<Uint8Array | null> {
      const object = await cas.get(hash);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
  };
}
