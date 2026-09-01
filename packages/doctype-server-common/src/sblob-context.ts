import { CasClientError } from "@unicas/tenant-blob-client";
import type { CasBlobHandle } from "@unicas/tenant-blob-client";
import {
  computeNodeDigest,
  encodeHeader,
  hashToHex,
  hexToHash,
  validateContentType,
  validateHash,
} from "@unicas/codec";
import type {
  ByteStream,
  DocumentTypeContext,
  MakeSBlob,
  SBlob,
  SBlobHandler,
  SBlobReadRange,
  SBlobSource,
} from "@unidocs/protocol";
import { SValueContentType } from "@unidocs/protocol";
import { isSBlob } from "@unidocs/svalue-codec";
import { createSBlob, decodeSValueWithRefs } from "@unidocs/svalue-codec/internal";

export interface SBlobCasAdapter {
  leaseNodeContent(
    hash: string,
    content: Uint8Array,
    contentType: string,
    refs?: readonly string[],
  ): Promise<unknown>;
  leaseNode(hash: string): Promise<unknown>;
  storeBlob(source: SBlobSource): Promise<{ readonly hash: string }>;
  openBlob(hash: string): Promise<CasBlobHandle>;
}

export interface SBlobContextOptions {
  readonly maxReadBytes?: number;
}

export function readableStreamFromSBlobSource(source: SBlobSource): ReadableStream<Uint8Array> {
  if ("data" in source) {
    const data = Uint8Array.from(source.data);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }
  return readableStreamFromByteStream(source.body);
}

export function readableStreamFromByteStream(source: ByteStream): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export function byteStreamFromReadableStream(source: ReadableStream<Uint8Array>): ByteStream {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = source.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}

export class SBlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SBlobIntegrityError";
  }
}

class SBlobRuntime {
  readonly #cas: SBlobCasAdapter;
  readonly #maxReadBytes: number;
  readonly #pendingMakes = new Map<string, Promise<SBlob>>();

  constructor(cas: SBlobCasAdapter, options: SBlobContextOptions) {
    this.#cas = cas;
    this.#maxReadBytes = validLimit(options.maxReadBytes, 8 * 1024 * 1024, "maxReadBytes");
  }

  makeExpected(hash: string, loadSource: () => Promise<SBlobSource>): Promise<SBlob> {
    validateHash(hash);
    return this.#coalesceMake(hash, async () => {
      const actual = await this.#store(await loadSource());
      if (actual !== hash) {
        throw new SBlobIntegrityError(`SBlob digest mismatch: expected ${hash}, got ${actual}`);
      }
    });
  }

  async makeSource(source: SBlobSource): Promise<SBlob> {
    return createSBlob(await this.#store(source));
  }

  async open(blob: SBlob): Promise<SBlobHandler> {
    if (!isSBlob(blob)) throw new TypeError("openSBlob requires a branded SBlob");
    validateHash(blob.hash);
    const blobHandle = await this.#cas.openBlob(blob.hash);
    if (blobHandle.ref.hash !== blob.hash) {
      throw new SBlobIntegrityError(`CAS metadata hash mismatch for ${blob.hash}`);
    }
    const openRange = (range?: SBlobReadRange): ByteStream => {
      validateRange(range, blobHandle.ref.size);
      return byteStreamFromReadableStream(blobHandle.read(range));
    };
    return Object.freeze({
      size: blobHandle.ref.size,
      contentType: blobHandle.ref.contentType,
      read: openRange,
      readBytes: async (range: { readonly offset: number; readonly length: number }) => {
        validateRange(range, blobHandle.ref.size);
        if (range.length > this.#maxReadBytes) {
          throw new RangeError(`SBlob read exceeds ${this.#maxReadBytes}-byte materialization limit`);
        }
        return blobHandle.readBytes(range);
      },
    });
  }

  #coalesceMake(hash: string, store: () => Promise<void>): Promise<SBlob> {
    const pending = this.#pendingMakes.get(hash);
    if (pending) return pending;

    const created = this.#ensure(hash, store);
    this.#pendingMakes.set(hash, created);
    void created.finally(() => {
      if (this.#pendingMakes.get(hash) === created) this.#pendingMakes.delete(hash);
    }).catch(() => undefined);
    return created;
  }

  async #ensure(hash: string, store: () => Promise<void>): Promise<SBlob> {
    try {
      await this.#cas.leaseNode(hash);
      return createSBlob(hash);
    } catch (err) {
      if (!(err instanceof CasClientError) || (err.status !== 404 && err.status !== 409)) {
        throw err;
      }
    }

    await store();
    return createSBlob(hash);
  }

  async #store(source: SBlobSource): Promise<string> {
    validateContentType(source.contentType);
    if ("data" in source && source.contentType === SValueContentType) {
      const data = Uint8Array.from(source.data);
      const refs = decodeSValueWithRefs(data).refs;
      const hash = await computeHash(data, source.contentType, refs);
      await Promise.all([...new Set(refs)].map(ref => this.#cas.leaseNode(ref)));
      await this.#cas.leaseNodeContent(hash, data, source.contentType, refs);
      return hash;
    }
    return (await this.#cas.storeBlob(source)).hash;
  }
}

export function createSBlobContext(
  cas: SBlobCasAdapter,
  options: SBlobContextOptions = {},
): DocumentTypeContext {
  const runtime = new SBlobRuntime(cas, options);
  const makeSBlob = ((
    input: string | SBlobSource,
    loadSource?: () => Promise<SBlobSource>,
  ): Promise<SBlob> => {
    if (typeof input === "string") {
      if (typeof loadSource !== "function") {
        throw new TypeError("hash-first makeSBlob requires a source callback");
      }
      return runtime.makeExpected(input, loadSource);
    }
    if (loadSource !== undefined) {
      throw new TypeError("source-first makeSBlob does not accept a callback");
    }
    return runtime.makeSource(input);
  }) as MakeSBlob;

  return Object.freeze({
    makeSBlob,
    openSBlob: (blob: SBlob) => runtime.open(blob),
    readSBlob: async (blob: SBlob) => {
      const handler = await runtime.open(blob);
      return {
        data: await handler.readBytes({ offset: 0, length: handler.size }),
        contentType: handler.contentType,
      };
    },
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

function validateRange(range: SBlobReadRange | undefined, size: number): void {
  if (range === undefined) return;
  if (!Number.isSafeInteger(range.offset) || range.offset < 0 || range.offset > size) {
    throw new RangeError("SBlob range offset is outside the blob");
  }
  if (range.length !== undefined) {
    if (!Number.isSafeInteger(range.length) || range.length < 0 || range.offset + range.length > size) {
      throw new RangeError("SBlob range length is outside the blob");
    }
  }
}

function validLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return result;
}