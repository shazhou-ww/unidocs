import {
  decode,
  encode,
  rfc8949EncodeOptions,
  Tagged,
  Tokenizer,
  Type,
} from "cborg";
import type { DecodeOptions, Token } from "cborg";
import {
  sBlobSignature,
  SValueContentType,
} from "./types.js";
import type { CasReferences, SBlob, SValue } from "./types.js";

export { SValueContentType };

export const SBlobTag = 65_536;

export interface SValueCodecLimits {
  readonly maxArrayLength: number;
  readonly maxByteStringBytes: number;
  readonly maxDepth: number;
  readonly maxEncodedBytes: number;
  readonly maxMapEntries: number;
  readonly maxRefs: number;
  readonly maxStringBytes: number;
  readonly maxValues: number;
}

export interface SValueCodecOptions {
  readonly limits?: Partial<SValueCodecLimits>;
}

export interface EncodedSValue {
  readonly data: Uint8Array;
  readonly refs: readonly string[];
}

export interface DecodedSValue {
  readonly value: SValue;
  readonly refs: readonly string[];
}

const DEFAULT_LIMITS: SValueCodecLimits = Object.freeze({
  maxArrayLength: 100_000,
  maxByteStringBytes: 32,
  maxDepth: 100,
  maxEncodedBytes: 16 * 1024 * 1024,
  maxMapEntries: 100_000,
  maxRefs: 100_000,
  maxStringBytes: 1024 * 1024,
  maxValues: 1_000_000,
});

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const textEncoder = new TextEncoder();

interface PrepareState {
  readonly ancestors: Set<object>;
  readonly limits: SValueCodecLimits;
  readonly refs: string[];
  values: number;
}

class BoundedTokenizer extends Tokenizer {
  readonly #limits: SValueCodecLimits;
  readonly #remaining: number[] = [];
  #values = 0;

  constructor(data: Uint8Array, options: DecodeOptions, limits: SValueCodecLimits) {
    super(data, options);
    this.#limits = limits;
  }

  override next(): Token {
    this.#preflightHead();
    this.#values++;
    if (this.#values > this.#limits.maxValues) {
      fail("$", `value count exceeds ${this.#limits.maxValues}`);
    }

    while (this.#remaining.at(-1) === 0) this.#remaining.pop();
    if (this.#remaining.length > 0) {
      this.#remaining[this.#remaining.length - 1]--;
    }

    const token = super.next();
    let children = 0;
    if (Type.equals(token.type, Type.array)) children = token.value as number;
    else if (Type.equals(token.type, Type.map)) children = (token.value as number) * 2;
    else if (Type.equals(token.type, Type.tag)) children = 1;
    if (children > 0) {
      if (this.#remaining.length >= this.#limits.maxDepth) {
        fail("$", `nesting exceeds ${this.#limits.maxDepth}`);
      }
      this.#remaining.push(children);
    }
    return token;
  }

  #preflightHead(): void {
    const offset = this.pos();
    const initial = this.data[offset];
    if (initial === undefined) return;
    const major = initial >>> 5;
    if (major < 2 || major > 5) return;
    const argument = readCborArgument(this.data, offset, initial & 0x1f);
    if (argument === null) return;
    if (major === 2 && argument > this.#limits.maxByteStringBytes) {
      fail("$", `byte string exceeds ${this.#limits.maxByteStringBytes} bytes`);
    }
    if (major === 3 && argument > this.#limits.maxStringBytes) {
      fail("$", `string exceeds ${this.#limits.maxStringBytes} UTF-8 bytes`);
    }
    if (major === 4 && argument > this.#limits.maxArrayLength) {
      fail("$", `array exceeds ${this.#limits.maxArrayLength} entries`);
    }
    if (major === 5 && argument > this.#limits.maxMapEntries) {
      fail("$", `map exceeds ${this.#limits.maxMapEntries} entries`);
    }
  }
}

function readCborArgument(
  data: Uint8Array,
  offset: number,
  additional: number,
): number | null {
  if (additional < 24) return additional;
  const width = additional === 24 ? 1
    : additional === 25 ? 2
      : additional === 26 ? 4
        : additional === 27 ? 8
          : 0;
  if (width === 0 || offset + 1 + width > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset + offset + 1, width);
  if (width === 1) return view.getUint8(0);
  if (width === 2) return view.getUint16(0);
  if (width === 4) return view.getUint32(0);
  const value = view.getBigUint64(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("$", "declared length exceeds the safe integer range");
  }
  return Number(value);
}

function codecLimits(options?: SValueCodecOptions): SValueCodecLimits {
  const limits = { ...DEFAULT_LIMITS, ...options?.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return limits;
}

function fail(path: string, message: string): never {
  throw new TypeError(`Invalid SValue at ${path}: ${message}`);
}

function validateHash(hash: unknown, path: string): asserts hash is string {
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
    fail(path, "SBlob hash must be 64 lowercase hexadecimal characters");
  }
}

export function isSBlob(value: unknown): value is SBlob {
  return typeof value === "object"
    && value !== null
    && (value as Partial<SBlob>)[sBlobSignature] === true
    && typeof (value as Partial<SBlob>).hash === "string"
    && HASH_PATTERN.test((value as Partial<SBlob>).hash as string);
}

export function createSBlob(hash: string): SBlob {
  validateHash(hash, "$sblob");
  const blob = { hash } as { hash: string } & Partial<SBlob>;
  Object.defineProperty(blob, sBlobSignature, { value: true });
  return Object.freeze(blob) as SBlob;
}

function hasIsolatedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateString(value: string, path: string, limits: SValueCodecLimits): void {
  if (hasIsolatedSurrogate(value)) {
    fail(path, "strings must contain only Unicode scalar values");
  }
  if (textEncoder.encode(value).length > limits.maxStringBytes) {
    fail(path, `string exceeds ${limits.maxStringBytes} UTF-8 bytes`);
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function sortedKeys(
  descriptors: Record<string, PropertyDescriptor>,
  path: string,
  limits: SValueCodecLimits,
): string[] {
  const keys = Object.keys(descriptors);
  if (keys.length > limits.maxMapEntries) {
    fail(path, `map exceeds ${limits.maxMapEntries} entries`);
  }

  const encoded = new Map<string, Uint8Array>();
  for (const key of keys) {
    validateString(key, `${path}.[key]`, limits);
    encoded.set(key, encode(key, rfc8949EncodeOptions));
  }
  return keys.sort((left, right) => compareBytes(encoded.get(left)!, encoded.get(right)!));
}

function prepareValue(
  value: unknown,
  path: string,
  depth: number,
  state: PrepareState,
): unknown {
  if (depth > state.limits.maxDepth) {
    fail(path, `nesting exceeds ${state.limits.maxDepth}`);
  }
  state.values++;
  if (state.values > state.limits.maxValues) {
    fail(path, `value count exceeds ${state.limits.maxValues}`);
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    validateString(value, path, state.limits);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "numbers must be finite");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail(path, "integral numbers must be safe integers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (isSBlob(value)) {
    state.refs.push(value.hash);
    if (state.refs.length > state.limits.maxRefs) {
      fail(path, `reference count exceeds ${state.limits.maxRefs}`);
    }
    return new Tagged(SBlobTag, hexToBytes(value.hash));
  }
  if (typeof value !== "object" || value === null) {
    fail(path, `unsupported ${typeof value}`);
  }
  if (state.ancestors.has(value)) fail(path, "circular references are not supported");

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > state.limits.maxArrayLength) {
        fail(path, `array exceeds ${state.limits.maxArrayLength} entries`);
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
        fail(path, "arrays must be dense and have no extra properties");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail(`${path}[${index}]`, "arrays must contain enumerable data elements");
        }
        result.push(prepareValue(descriptor.value, `${path}[${index}]`, depth + 1, state));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, "objects must have Object.prototype or null prototype");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      fail(path, "objects must not contain symbol properties");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of sortedKeys(descriptors, path, state.limits)) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || !descriptor.enumerable) {
        fail(`${path}.${JSON.stringify(key)}`, "object properties must be enumerable data properties");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: prepareValue(
          descriptor.value,
          `${path}.${JSON.stringify(key)}`,
          depth + 1,
          state,
        ),
        writable: true,
      });
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function encodeDetailed(value: unknown, limits: SValueCodecLimits): EncodedSValue {
  const state: PrepareState = {
    ancestors: new Set(),
    limits,
    refs: [],
    values: 0,
  };
  const prepared = prepareValue(value, "$", 0, state);
  const data = Uint8Array.from(encode(prepared, rfc8949EncodeOptions));
  if (data.length > limits.maxEncodedBytes) {
    fail("$", `encoding exceeds ${limits.maxEncodedBytes} bytes`);
  }
  return Object.freeze({ data, refs: Object.freeze(state.refs.slice()) });
}

export function encodeSValue(value: SValue, options?: SValueCodecOptions): Uint8Array {
  return encodeDetailed(value, codecLimits(options)).data;
}

export function encodeSValueWithRefs(
  value: SValue,
  options?: SValueCodecOptions,
): EncodedSValue {
  return encodeDetailed(value, codecLimits(options));
}

/** Count each SBlob occurrence produced by a canonical SValue encode. */
export function refsFromSValue(value: SValue, options?: SValueCodecOptions): CasReferences {
  const counts: Record<string, number> = {};
  for (const hash of encodeSValueWithRefs(value, options).refs) {
    counts[hash] = (counts[hash] ?? 0) + 1;
  }
  return counts;
}

/**
 * Collect branded SBlobs from an arbitrary object tree. This diagnostic helper
 * skips cycles, typed arrays, and class instances; durable SValue reference
 * counts should use `refsFromSValue` so they follow canonical codec semantics.
 */
export function collectSBlobRefs(value: unknown): CasReferences {
  const counts: Record<string, number> = {};
  walkSBlobs(value, counts, new Set());
  return counts;
}

function walkSBlobs(
  value: unknown,
  counts: Record<string, number>,
  seen: Set<object>,
): void {
  if (isSBlob(value)) {
    counts[value.hash] = (counts[value.hash] ?? 0) + 1;
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkSBlobs(item, counts, seen);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    walkSBlobs(child, counts, seen);
  }
}

function normalizeDecoded(
  value: unknown,
  path: string,
  depth: number,
  state: PrepareState,
): SValue {
  if (isSBlob(value)) return value;
  if (value instanceof Map) {
    if (depth > state.limits.maxDepth) fail(path, `nesting exceeds ${state.limits.maxDepth}`);
    state.values++;
    if (state.values > state.limits.maxValues) fail(path, `value count exceeds ${state.limits.maxValues}`);
    if (value.size > state.limits.maxMapEntries) {
      fail(path, `map exceeds ${state.limits.maxMapEntries} entries`);
    }
    const result = Object.create(null) as Record<string, SValue>;
    for (const [key, child] of value) {
      if (typeof key !== "string") fail(path, "map keys must be strings");
      validateString(key, `${path}.[key]`, state.limits);
      Object.defineProperty(result, key, {
        enumerable: true,
        value: normalizeDecoded(child, `${path}.${JSON.stringify(key)}`, depth + 1, state),
      });
    }
    return Object.freeze(result);
  }
  if (Array.isArray(value)) {
    if (depth > state.limits.maxDepth) fail(path, `nesting exceeds ${state.limits.maxDepth}`);
    state.values++;
    if (state.values > state.limits.maxValues) fail(path, `value count exceeds ${state.limits.maxValues}`);
    if (value.length > state.limits.maxArrayLength) {
      fail(path, `array exceeds ${state.limits.maxArrayLength} entries`);
    }
    return Object.freeze(value.map((child, index) =>
      normalizeDecoded(child, `${path}[${index}]`, depth + 1, state)));
  }
  return prepareValue(value, path, depth, state) as SValue;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

export function decodeSValueWithRefs(
  data: Uint8Array,
  options?: SValueCodecOptions,
): DecodedSValue {
  if (!(data instanceof Uint8Array)) throw new TypeError("SValue input must be a Uint8Array");
  const limits = codecLimits(options);
  if (data.length > limits.maxEncodedBytes) {
    fail("$", `encoding exceeds ${limits.maxEncodedBytes} bytes`);
  }

  const refs: string[] = [];
  const decodeOptions: DecodeOptions = {
    allowBigInt: false,
    allowIndefinite: false,
    allowInfinity: false,
    allowNaN: false,
    allowUndefined: false,
    rejectDuplicateMapKeys: true,
    strict: true,
    tags: {
      [SBlobTag]: decodeTagged => {
        const hashBytes = decodeTagged();
        if (!(hashBytes instanceof Uint8Array) || hashBytes.length !== 32) {
          fail("$", "SBlob tag must contain exactly 32 bytes");
        }
        const hash = bytesToHex(hashBytes);
        refs.push(hash);
        if (refs.length > limits.maxRefs) {
          fail("$", `reference count exceeds ${limits.maxRefs}`);
        }
        return createSBlob(hash);
      },
    },
    useMaps: true,
  };
  decodeOptions.tokenizer = new BoundedTokenizer(data, decodeOptions, limits);

  const decoded = decode(data, decodeOptions);
  const state: PrepareState = {
    ancestors: new Set(),
    limits,
    refs: [],
    values: 0,
  };
  const value = normalizeDecoded(decoded, "$", 0, state);
  const canonical = encodeDetailed(value, limits);
  if (!equalBytes(data, canonical.data)) {
    fail("$", "encoding is not canonical SValue version 1");
  }
  if (canonical.refs.length !== refs.length
    || canonical.refs.some((hash, index) => hash !== refs[index])) {
    fail("$", "decoded reference order is inconsistent");
  }
  return Object.freeze({ value, refs: Object.freeze(refs.slice()) });
}

export function decodeSValue(data: Uint8Array, options?: SValueCodecOptions): SValue {
  return decodeSValueWithRefs(data, options).value;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function hexToBytes(hash: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}