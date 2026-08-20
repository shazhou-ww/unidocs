/**
 * Snapshot codec — pure routing helpers for document snapshot bytes.
 *
 * A snapshot on disk is either:
 *   - legacy PSD binary (produced by `config.save`; starts with '8BPS'), or
 *   - IR JSON (produced by `config.serialize`; starts with '{'), whose large
 *     binary payloads (per-layer pixels) live separately in the CAS BlobStore.
 *
 * The branching lives here (not in editor-do) so it is unit-testable without a
 * DurableObject/D1 harness. editor-do simply calls encodeSnapshot on write and
 * decodeSnapshot on read.
 */
import type { BlobStore } from "@unidocs/core";

/** Config surface encodeSnapshot needs. */
export interface SnapshotEncodeConfig<TDoc> {
  serialize?: (doc: TDoc, store: BlobStore) => Promise<Uint8Array>;
  save: (doc: TDoc) => Promise<Uint8Array>;
}

/** Config surface decodeSnapshot needs. */
export interface SnapshotDecodeConfig<TDoc> {
  deserialize?: (bytes: Uint8Array, store: BlobStore) => Promise<TDoc>;
  load: (bytes: Uint8Array) => Promise<TDoc>;
}

/**
 * True when `bytes` is a legacy PSD-binary snapshot ('8BPS' = 0x38 0x42 0x50
 * 0x53). IR JSON snapshots start with '{' (0x7B) and return false.
 */
export function isPsdBytes(bytes: Uint8Array): boolean {
  return bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53;
}

/**
 * Serialize a document to snapshot bytes. Prefers IR (`serialize`, which
 * side-effect-writes per-layer blobs into `store`) when the doctype supports
 * it; otherwise falls back to a full binary `save`.
 */
export async function encodeSnapshot<TDoc>(
  doc: TDoc,
  store: BlobStore,
  config: SnapshotEncodeConfig<TDoc>,
): Promise<Uint8Array> {
  return config.serialize ? config.serialize(doc, store) : config.save(doc);
}

/**
 * Decode snapshot bytes back to a document. Routes by magic byte so legacy
 * PSD-binary snapshots always go through `config.load` (never fed to
 * `deserialize`); IR JSON goes through `deserialize` when available, else
 * `load`.
 */
export async function decodeSnapshot<TDoc>(
  bytes: Uint8Array,
  store: BlobStore,
  config: SnapshotDecodeConfig<TDoc>,
): Promise<TDoc> {
  return !isPsdBytes(bytes) && config.deserialize
    ? config.deserialize(bytes, store)
    : config.load(bytes);
}
