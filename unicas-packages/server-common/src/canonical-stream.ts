import {
  HASH_SIZE,
  HEADER_SIZE,
  decodeHeader,
} from "./binary.js";
import { hashToHex } from "./digest.js";
import {
  validateCanonicalNodeSize,
  validateContentType,
  validateDecodedHeader,
} from "./validation.js";

export const CanonicalNodeContentType = "application/vnd.unidocs.cas-node.v1";

export interface ParsedCanonicalNodeStream {
  readonly contentSize: number;
  readonly contentType: string;
  readonly refs: readonly string[];
  readonly canonicalSize: number;
  readonly body: ReadableStream<Uint8Array>;
}

class StreamCursor {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #remainder: Uint8Array | undefined;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async readExactly(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.#remainder ?? (await this.#reader.read()).value;
      this.#remainder = undefined;
      if (chunk === undefined) {
        throw new Error(`Canonical node ended at ${offset} bytes while reading ${length} bytes`);
      }
      const take = Math.min(chunk.length, length - offset);
      result.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take < chunk.length) this.#remainder = chunk.subarray(take);
    }
    return result;
  }

  replay(prefix: Uint8Array, expectedLength: number): ReadableStream<Uint8Array> {
    const reader = this.#reader;
    let remainder = this.#remainder;
    let emitted = 0;
    let prefixPending = true;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: Uint8Array | undefined;
        if (prefixPending) {
          prefixPending = false;
          chunk = prefix;
        } else if (remainder !== undefined) {
          chunk = remainder;
          remainder = undefined;
        } else {
          const next = await reader.read();
          if (next.done) {
            if (emitted !== expectedLength) {
              controller.error(new Error(
                `Canonical node length mismatch: expected ${expectedLength}, got ${emitted}`,
              ));
            } else {
              controller.close();
            }
            return;
          }
          chunk = next.value;
        }

        emitted += chunk.length;
        if (emitted > expectedLength) {
          await reader.cancel("Canonical node exceeds declared length");
          controller.error(new Error(
            `Canonical node length exceeds declared ${expectedLength} bytes`,
          ));
          return;
        }
        controller.enqueue(chunk);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }
}

/** Parse and validate the bounded canonical prefix, then replay the exact full node. */
export async function parseCanonicalNodeStream(
  source: ReadableStream<Uint8Array>,
  declaredLength?: number,
): Promise<ParsedCanonicalNodeStream> {
  const cursor = new StreamCursor(source);
  const header = await cursor.readExactly(HEADER_SIZE);
  const decoded = decodeHeader(header);
  validateDecodedHeader(decoded);
  const canonicalSize = validateCanonicalNodeSize(
    decoded.contentSize,
    decoded.contentTypeLength,
    decoded.refCount,
  );
  if (declaredLength !== undefined && declaredLength !== canonicalSize) {
    throw new Error(
      `Canonical node length mismatch: header says ${canonicalSize}, Content-Length says ${declaredLength}`,
    );
  }

  const contentTypeBytes = await cursor.readExactly(decoded.contentTypeLength);
  if (contentTypeBytes.some(byte => byte < 0x20 || byte > 0x7e)) {
    throw new Error("Content type must be printable ASCII (0x20-0x7e)");
  }
  const contentType = new TextDecoder().decode(contentTypeBytes);
  validateContentType(contentType);

  const refsBytes = await cursor.readExactly(decoded.refCount * HASH_SIZE);
  const refs: string[] = [];
  for (let offset = 0; offset < refsBytes.length; offset += HASH_SIZE) {
    refs.push(hashToHex(refsBytes.subarray(offset, offset + HASH_SIZE)));
  }

  const prefix = new Uint8Array(header.length + contentTypeBytes.length + refsBytes.length);
  prefix.set(header, 0);
  prefix.set(contentTypeBytes, header.length);
  prefix.set(refsBytes, header.length + contentTypeBytes.length);

  return {
    contentSize: decoded.contentSize,
    contentType,
    refs,
    canonicalSize,
    body: cursor.replay(prefix, canonicalSize),
  };
}