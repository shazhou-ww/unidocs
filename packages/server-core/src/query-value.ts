import type { QueryValue } from "@unidocs/protocol";

export interface BinaryQueryValue {
  $unidocs: {
    type: "bytes";
    base64: string;
  };
}

export interface EscapedQueryObject {
  $unidocs: {
    type: "object";
    value: { [key: string]: WireQueryValue };
  };
}

export type WireQueryValue =
  | string
  | number
  | boolean
  | null
  | BinaryQueryValue
  | EscapedQueryObject
  | WireQueryValue[]
  | { [key: string]: WireQueryValue };

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let result = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    result += BASE64[(value >>> 18) & 63];
    result += BASE64[(value >>> 12) & 63];
    result += second === undefined ? "=" : BASE64[(value >>> 6) & 63];
    result += third === undefined ? "=" : BASE64[value & 63];
  }

  return result;
}

/** Convert a query result to an unambiguous JSON-safe wire representation. */
export function encodeQueryValue(value: QueryValue): WireQueryValue {
  const ancestors = new Set<object>();

  const encode = (current: QueryValue): WireQueryValue => {
    if (current instanceof Uint8Array) {
      return { $unidocs: { type: "bytes", base64: encodeBase64(current) } };
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError("Query results cannot contain non-finite numbers");
      }
      return current;
    }
    if (ancestors.has(current)) {
      throw new TypeError("Query results cannot contain circular references");
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map(encode);
      }

      const encoded: { [key: string]: WireQueryValue } = {};
      for (const [key, child] of Object.entries(current)) {
        Object.defineProperty(encoded, key, {
          value: encode(child),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }

      return Object.hasOwn(current, "$unidocs")
        ? { $unidocs: { type: "object", value: encoded } }
        : encoded;
    } finally {
      ancestors.delete(current);
    }
  };

  return encode(value);
}