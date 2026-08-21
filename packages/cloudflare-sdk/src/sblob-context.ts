import {
  computeNodeDigest,
  encodeHeader,
  hashToHex,
  hexToHash,
  validateContentType,
  validateHash,
} from "@unidocs/cas";
import type { CasNodeMetadata } from "@unidocs/cas";
import {
  isSBlob,
  SValueContentType,
} from "@unidocs/core";
import type {
  DocumentTypeContext,
  MakeSBlob,
  SBlob,
  SBlobData,
} from "@unidocs/core";
import {
  createSBlob,
  decodeSValueWithRefs,
} from "@unidocs/core/internal";
import { CasClientError } from "./cas-client.js";

export interface SBlobCasAdapter {
  ensureNode(
    hash: string,
    content: Uint8Array,
    contentType: string,
    refs?: readonly string[],
  ): Promise<unknown>;
  leaseExisting(hash: string): Promise<unknown>;
  metadata(hash: string): Promise<CasNodeMetadata>;
  read(hash: string): Promise<Uint8Array>;
  readNode?(hash: string): Promise<{
    readonly metadata: CasNodeMetadata;
    readonly content: Uint8Array;
  }>;
}

export interface SBlobContextOptions {
  readonly maxCacheBytes?: number;
  readonly maxCacheEntries?: number;
}

interface PreparedBlob extends SBlobData {
  readonly hash: string;
  readonly refs: readonly string[];
}

interface CacheEntry {
  readonly promise: Promise<SBlobData>;
  size: number;
}

export class SBlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SBlobIntegrityError";
  }
}

class SBlobRuntime {
  readonly #cas: SBlobCasAdapter;
  readonly #maxCacheBytes: number;
  readonly #maxCacheEntries: number;
  readonly #pendingMakes = new Map<string, Promise<SBlob>>();
  readonly #readCache = new Map<string, CacheEntry>();
  #cacheBytes = 0;

  constructor(cas: SBlobCasAdapter, options: SBlobContextOptions) {
    this.#cas = cas;
    this.#maxCacheBytes = validLimit(options.maxCacheBytes, 32 * 1024 * 1024, "maxCacheBytes");
    this.#maxCacheEntries = validLimit(options.maxCacheEntries, 256, "maxCacheEntries");
  }

  makeExpected(hash: string, loadData: () => Promise<SBlobData>): Promise<SBlob> {
    validateHash(hash);
    return this.#coalesceMake(hash, async () => this.#prepare(await loadData()));
  }

  async makeData(data: SBlobData): Promise<SBlob> {
    const prepared = await this.#prepare(data);
    return this.#coalesceMake(prepared.hash, async () => prepared);
  }

  async read(blob: SBlob): Promise<SBlobData> {
    if (!isSBlob(blob)) throw new TypeError("readSBlob requires a branded SBlob");
    let entry = this.#readCache.get(blob.hash);
    if (entry) {
      this.#readCache.delete(blob.hash);
      this.#readCache.set(blob.hash, entry);
    } else {
      entry = { promise: this.#loadVerified(blob.hash), size: 0 };
      this.#readCache.set(blob.hash, entry);
      void entry.promise.then(
        data => {
          entry!.size = data.data.length;
          this.#cacheBytes += entry!.size;
          this.#evict();
        },
        () => {
          if (this.#readCache.get(blob.hash) === entry) this.#readCache.delete(blob.hash);
        },
      );
    }
    const data = await entry.promise;
    return Object.freeze({ data: data.data.slice(), contentType: data.contentType });
  }

  #coalesceMake(hash: string, loadPrepared: () => Promise<PreparedBlob>): Promise<SBlob> {
    const pending = this.#pendingMakes.get(hash);
    if (pending) return pending;

    const created = this.#ensure(hash, loadPrepared);
    this.#pendingMakes.set(hash, created);
    void created.finally(() => {
      if (this.#pendingMakes.get(hash) === created) this.#pendingMakes.delete(hash);
    }).catch(() => undefined);
    return created;
  }

  async #ensure(hash: string, loadPrepared: () => Promise<PreparedBlob>): Promise<SBlob> {
    try {
      await this.#cas.leaseExisting(hash);
      return createSBlob(hash);
    } catch (err) {
      if (!(err instanceof CasClientError) || (err.status !== 404 && err.status !== 409)) {
        throw err;
      }
    }

    const prepared = await loadPrepared();
    if (prepared.hash !== hash) {
      throw new SBlobIntegrityError(`SBlob digest mismatch: expected ${hash}, got ${prepared.hash}`);
    }
    await Promise.all([...new Set(prepared.refs)].map(ref => this.#cas.leaseExisting(ref)));
    await this.#cas.ensureNode(hash, prepared.data, prepared.contentType, prepared.refs);
    this.#cacheResolved(hash, prepared);
    return createSBlob(hash);
  }

  async #prepare(source: SBlobData): Promise<PreparedBlob> {
    if (!source || typeof source !== "object" || !(source.data instanceof Uint8Array)) {
      throw new TypeError("SBlobData.data must be a Uint8Array");
    }
    validateContentType(source.contentType);
    const data = Uint8Array.from(source.data);
    const refs = source.contentType === SValueContentType
      ? decodeSValueWithRefs(data).refs
      : [];
    const hash = await computeHash(data, source.contentType, refs);
    return Object.freeze({ data, contentType: source.contentType, hash, refs });
  }

  async #loadVerified(hash: string): Promise<SBlobData> {
    validateHash(hash);
    const node = this.#cas.readNode
      ? await this.#cas.readNode(hash)
      : {
        metadata: await this.#cas.metadata(hash),
        content: await this.#cas.read(hash),
      };
    const metadata = node.metadata;
    const bytes = node.content;
    if (metadata.hash !== hash) {
      throw new SBlobIntegrityError(`CAS metadata hash mismatch for ${hash}`);
    }
    if (metadata.size !== bytes.length) {
      throw new SBlobIntegrityError(
        `CAS content length mismatch for ${hash}: expected ${metadata.size}, got ${bytes.length}`,
      );
    }
    if (metadata.contentType === SValueContentType) {
      const refs = decodeSValueWithRefs(bytes).refs;
      if (!sameRefs(metadata.refs, refs)) {
        throw new SBlobIntegrityError(`CAS SValue refs mismatch for ${hash}`);
      }
    }
    const actualHash = await computeHash(bytes, metadata.contentType, metadata.refs);
    if (actualHash !== hash) {
      throw new SBlobIntegrityError(`CAS content digest mismatch for ${hash}: got ${actualHash}`);
    }
    return Object.freeze({ data: bytes.slice(), contentType: metadata.contentType });
  }

  #cacheResolved(hash: string, data: SBlobData): void {
    const existing = this.#readCache.get(hash);
    if (existing) {
      this.#cacheBytes -= existing.size;
      this.#readCache.delete(hash);
    }
    const stored = Object.freeze({
      data: Uint8Array.from(data.data),
      contentType: data.contentType,
    });
    const entry: CacheEntry = { promise: Promise.resolve(stored), size: stored.data.length };
    this.#readCache.set(hash, entry);
    this.#cacheBytes += entry.size;
    this.#evict();
  }

  #evict(): void {
    while (
      this.#readCache.size > this.#maxCacheEntries
      || this.#cacheBytes > this.#maxCacheBytes
    ) {
      const oldest = this.#readCache.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.#readCache.delete(oldest[0]);
      this.#cacheBytes -= oldest[1].size;
    }
  }
}

export function createSBlobContext(
  cas: SBlobCasAdapter,
  options: SBlobContextOptions = {},
): DocumentTypeContext {
  const runtime = new SBlobRuntime(cas, options);
  const makeSBlob = ((
    input: string | SBlobData,
    loadData?: () => Promise<SBlobData>,
  ): Promise<SBlob> => {
    if (typeof input === "string") {
      if (typeof loadData !== "function") {
        throw new TypeError("hash-first makeSBlob requires a loadData callback");
      }
      return runtime.makeExpected(input, loadData);
    }
    if (loadData !== undefined) {
      throw new TypeError("data-first makeSBlob does not accept a callback");
    }
    return runtime.makeData(input);
  }) as MakeSBlob;

  return Object.freeze({
    makeSBlob,
    readSBlob: (blob: SBlob) => runtime.read(blob),
  });
}

async function computeHash(
  data: Uint8Array,
  contentType: string,
  refs: readonly string[],
): Promise<string> {
  const childHashes = refs.map(hexToHash);
  const header = encodeHeader(data.length, contentType, childHashes.length);
  return hashToHex(await computeNodeDigest(header, contentType, childHashes, data));
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

function validLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return result;
}