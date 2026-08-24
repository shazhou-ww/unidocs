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
 * promise, so the `createIfNotExists()` round trip happens once per
 * `BlobServiceClient` rather than once per operation — see `containerReady`
 * below for why it is keyed that way rather than per-instance.
 */

import type { BlobCas, DocIdentity, SnapshotCache } from "@unidocs/doctype-server-common";
import type { BlobServiceClient, ContainerClient } from "@azure/storage-blob";

/** Container holding the content-addressed blobs; blob name is the hash. */
const CAS_CONTAINER = "cas";
/** Container holding one "latest snapshot" blob per document. */
const SNAPSHOT_CONTAINER = "snapshots";
/** Blob metadata key carrying the snapshot's version. Azure lower-cases keys. */
const VERSION_METADATA_KEY = "version";
/**
 * How many times `BlobSnapshotCache.get()` re-reads a blob that was overwritten
 * between its properties call and its download. Bounded because each retry only
 * helps if the writer has stopped, and the caller can always fall back to the
 * durable snapshot.
 */
const GET_ATTEMPTS = 3;

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
 *
 * The error code is checked FIRST and the status code is only a fallback for
 * responses that carry no code, because 409 on Blob Storage is not exclusively
 * "already exists": `ContainerBeingDeleted`, `LeaseIdMissing` and
 * `SnapshotOperationRateExceeded` are all 409 too. Treating those as success
 * would have `putIfAbsent()` report a write that never happened, and the
 * matching `get(hash)` would then answer `null` — silent data loss in the store
 * every root-refs commit is built on.
 */
function isAlreadyExists(err: unknown): boolean {
  const code = errorCodeOf(err);
  if (code) return code === "BlobAlreadyExists" || code === "ConditionNotMet";
  const status = errorShape(err).statusCode;
  return status === 409 || status === 412;
}

/** The `ifMatch` / `ifNoneMatch` condition did not hold. */
function isPreconditionFailed(err: unknown): boolean {
  const code = errorCodeOf(err);
  if (code) return code === "ConditionNotMet";
  return errorShape(err).statusCode === 412;
}

/**
 * A snapshot blob's version, or `null` when the blob carries no usable one.
 *
 * `null` must mean "cache miss", never "version 0": a blob whose metadata is
 * missing or unparseable tells us nothing about which deltas its bytes already
 * contain, and calling that 0 would have the session replay the entire log on
 * top of an already-advanced document.
 */
function parseVersion(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const version = Number(raw);
  return Number.isFinite(version) ? version : null;
}

/**
 * Lazily `createIfNotExists()` a container, at most once per
 * `(BlobServiceClient, containerName)` pair — NOT once per `BlobCasStore` /
 * `BlobSnapshotCache` instance.
 *
 * That distinction matters here specifically: `@unidocs/azure-markdown`
 * builds a fresh `DocumentSession` (and with it, fresh port instances,
 * including these two) on every single request — see
 * `azure-markdown/src/local-editor.ts` for why no session is cached across
 * requests. A per-instance memo would silently turn back into a per-request
 * one under that call pattern, costing an extra `createIfNotExists()` round
 * trip to Blob Storage on every query/apply. Keying by the long-lived
 * `BlobServiceClient` (constructed once in `main.ts`) instead restores the
 * "once per process" intent the memo is actually for; `getContainerClient()`
 * returns a fresh `ContainerClient` object per call even for the same name,
 * so the `ContainerClient` itself is not a usable cache key.
 *
 * The memo is cleared when the call fails, so a single transient error (the
 * storage account briefly unreachable, a throttled request) does not hand the
 * same rejected promise to every later operation for the lifetime of the
 * process. Only a success is remembered.
 */
const containerReadyByService = new WeakMap<BlobServiceClient, Map<string, () => Promise<void>>>();

function containerReady(
  svc: BlobServiceClient,
  containerName: string,
  container: ContainerClient,
): () => Promise<void> {
  let byContainer = containerReadyByService.get(svc);
  if (!byContainer) {
    byContainer = new Map();
    containerReadyByService.set(svc, byContainer);
  }

  const cached = byContainer.get(containerName);
  if (cached) return cached;

  let pending: Promise<unknown> | null = null;
  const ensure = async (): Promise<void> => {
    if (pending === null) {
      pending = container.createIfNotExists().catch((err: unknown) => {
        pending = null;
        throw err;
      });
    }
    await pending;
  };
  byContainer.set(containerName, ensure);
  return ensure;
}

/**
 * `BlobCas` over the `cas` container. Blob name == content hash.
 */
export class BlobCasStore implements BlobCas {
  #container: ContainerClient;
  #ensure: () => Promise<void>;

  constructor(svc: BlobServiceClient) {
    this.#container = svc.getContainerClient(CAS_CONTAINER);
    this.#ensure = containerReady(svc, CAS_CONTAINER, this.#container);
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
    this.#ensure = containerReady(svc, SNAPSHOT_CONTAINER, this.#container);
    this.#blobName = `${identity.docType}/${identity.docId}/latest`;
  }

  /**
   * Reads the version and the bytes as ONE consistent snapshot.
   *
   * It takes two round trips — properties carry the version, the download
   * carries the bytes — and another replica's `put()` can land between them.
   * Returning the version from before that write next to the bytes from after
   * it is not a stale cache, it is a corrupt one: the session would replay the
   * deltas above `v` onto content that already contains them, applying the same
   * operations twice. So the download is conditioned on the ETag the properties
   * call observed; if the blob moved underneath us the download fails the
   * precondition and the whole read is retried.
   *
   * Exhausting the retries answers `null` (a miss) rather than throwing. This
   * is a droppable cache — a miss costs a replay from the durable snapshot,
   * which is always correct — so failing soft is right here, while returning a
   * mismatched pair never is.
   */
  async get(): Promise<{ version: number; bytes: Uint8Array } | null> {
    await this.#ensure();
    const blob = this.#container.getBlockBlobClient(this.#blobName);

    for (let attempt = 0; attempt < GET_ATTEMPTS; attempt += 1) {
      try {
        // Properties first: it is the cheap call, so a cache miss costs one
        // round trip instead of a download.
        const props = await blob.getProperties();
        const version = parseVersion(props.metadata?.[VERSION_METADATA_KEY]);
        // No usable version means the bytes cannot be placed in the delta
        // history, which makes them useless as a cache entry.
        if (version === null) return null;
        const buffer = await blob.downloadToBuffer(0, undefined, {
          conditions: { ifMatch: props.etag },
        });
        return { version, bytes: new Uint8Array(buffer) };
      } catch (err) {
        if (isNotFound(err)) return null;
        if (!isPreconditionFailed(err)) throw err;
        // Overwritten mid-read: go around and read the newer blob instead.
      }
    }
    return null;
  }

  async put(v: number, bytes: Uint8Array): Promise<void> {
    await this.#ensure();
    const blob = this.#container.getBlockBlobClient(this.#blobName);
    await blob.upload(bytes, bytes.byteLength, {
      metadata: { [VERSION_METADATA_KEY]: String(v) },
    });
  }
}
