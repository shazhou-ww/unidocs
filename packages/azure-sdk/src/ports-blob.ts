/**
 * Azure Blob Storage implementations of the two byte-oriented server-core
 * ports: the content-addressed store (`BlobCas`) and the snapshot cache
 * (`SnapshotCache`).
 *
 * Neither takes part in `withTransaction`, by design — see the note on
 * `TransactionalPorts`: a CAS blob is content-addressed (an orphan is harmless
 * and collectable) and the snapshot cache is droppable.
 *
 * Both classes create their container lazily on first use and remember the
 * promise, so the `createIfNotExists()` round trip happens once per process
 * rather than once per operation.
 */

import type { BlobCas, DocIdentity, SnapshotCache } from "@unidocs/server-core";
import type { BlobServiceClient, ContainerClient } from "@azure/storage-blob";

/** Container holding the content-addressed blobs; blob name is the hash. */
const CAS_CONTAINER = "cas";
/** Container holding one "latest snapshot" blob per document. */
const SNAPSHOT_CONTAINER = "snapshots";
/** Blob metadata key carrying the snapshot's version. Azure lower-cases keys. */
const VERSION_METADATA_KEY = "version";

interface StorageErrorish {
  statusCode?: number;
  code?: string;
  details?: { errorCode?: string };
}

function errorShape(err: unknown): StorageErrorish {
  return (err ?? {}) as StorageErrorish;
}

function errorCodeOf(err: unknown): string | undefined {
  const shape = errorShape(err);
  return shape.details?.errorCode ?? shape.code;
}

function isNotFound(err: unknown): boolean {
  const code = errorCodeOf(err);
  return (
    errorShape(err).statusCode === 404 ||
    code === "BlobNotFound" ||
    code === "ContainerNotFound"
  );
}

/**
 * The blob was already there. With `ifNoneMatch: "*"` Azure answers 409
 * `BlobAlreadyExists`; some emulators/paths answer 412 `ConditionNotMet`
 * instead. Both mean the same thing for a content-addressed put: the bytes are
 * already stored (same hash implies same bytes), so this is success.
 */
function isAlreadyExists(err: unknown): boolean {
  const status = errorShape(err).statusCode;
  const code = errorCodeOf(err);
  return (
    status === 409 ||
    status === 412 ||
    code === "BlobAlreadyExists" ||
    code === "ConditionNotMet"
  );
}

/** Lazily `createIfNotExists()` a container, at most once per instance. */
function containerReady(container: ContainerClient): () => Promise<void> {
  let pending: Promise<unknown> | null = null;
  return async () => {
    pending ??= container.createIfNotExists();
    await pending;
  };
}

/**
 * `BlobCas` over the `cas` container. Blob name == content hash.
 */
export class BlobCasStore implements BlobCas {
  #container: ContainerClient;
  #ensure: () => Promise<void>;

  constructor(svc: BlobServiceClient) {
    this.#container = svc.getContainerClient(CAS_CONTAINER);
    this.#ensure = containerReady(this.#container);
  }

  /**
   * Conditional upload: `ifNoneMatch: "*"` means "only if this blob does not
   * exist yet". Losing that race is the normal case for a CAS — two writers
   * storing the same content — and is reported as success, not an error,
   * because the stored bytes are by definition identical.
   */
  async putIfAbsent(hash: string, bytes: Uint8Array): Promise<void> {
    await this.#ensure();
    const blob = this.#container.getBlockBlobClient(hash);
    try {
      await blob.upload(bytes, bytes.byteLength, {
        conditions: { ifNoneMatch: "*" },
      });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  async get(hash: string): Promise<Uint8Array | null> {
    await this.#ensure();
    const blob = this.#container.getBlockBlobClient(hash);
    try {
      const buffer = await blob.downloadToBuffer();
      // Copy into a plain Uint8Array: the port's type is cloud-neutral, and a
      // Buffer view would leak the pooled allocation it was carved from.
      return new Uint8Array(buffer);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

/**
 * `SnapshotCache` over the `snapshots` container, one blob per document at
 * `{docType}/{docId}/latest`.
 *
 * Writes are unconditional overwrites: this is a cache of the newest snapshot,
 * so the newest writer wins and a lost write only costs a replay. The version
 * travels in blob metadata rather than in the payload, so the bytes stay
 * byte-identical to what the CAS holds.
 */
export class BlobSnapshotCache implements SnapshotCache {
  #container: ContainerClient;
  #ensure: () => Promise<void>;
  #blobName: string;

  constructor(svc: BlobServiceClient, identity: DocIdentity) {
    this.#container = svc.getContainerClient(SNAPSHOT_CONTAINER);
    this.#ensure = containerReady(this.#container);
    this.#blobName = `${identity.docType}/${identity.docId}/latest`;
  }

  async get(): Promise<{ version: number; bytes: Uint8Array } | null> {
    await this.#ensure();
    const blob = this.#container.getBlockBlobClient(this.#blobName);
    try {
      // Properties first: it is the cheap call, so a cache miss costs one
      // round trip instead of a download.
      const props = await blob.getProperties();
      const raw = props.metadata?.[VERSION_METADATA_KEY];
      const buffer = await blob.downloadToBuffer();
      return { version: Number(raw ?? 0), bytes: new Uint8Array(buffer) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(v: number, bytes: Uint8Array): Promise<void> {
    await this.#ensure();
    const blob = this.#container.getBlockBlobClient(this.#blobName);
    await blob.upload(bytes, bytes.byteLength, {
      metadata: { [VERSION_METADATA_KEY]: String(v) },
    });
  }
}
