import { isSBlob } from "./svalue.js";
import type { JsonValue } from "./types.js";

/** Validate and copy an unknown value into the strict JSON agent model. */
export function toJsonValue(value: unknown): JsonValue {
  return convert(value, "$", new Set());
}

function convert(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(path, "numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (isSBlob(value)) throw invalid(path, "SBlob cannot be represented as JSON");
  if (typeof value !== "object" || value === null) {
    throw invalid(path, `unsupported ${typeof value}`);
  }
  if (ancestors.has(value)) throw invalid(path, "circular references are not supported");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) {
        throw invalid(path, "arrays must be dense and have no extra properties");
      }
      return value.map((child, index) => convert(child, `${path}[${index}]`, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid(path, "objects must have Object.prototype or null prototype");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw invalid(path, "objects must not contain symbol properties");
    }

    const result = Object.create(null) as Record<string, JsonValue>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw invalid(`${path}.${JSON.stringify(key)}`, "properties must be enumerable data properties");
      }
      Object.defineProperty(result, key, {
        enumerable: true,
        value: convert(descriptor.value, `${path}.${JSON.stringify(key)}`, ancestors),
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function invalid(path: string, message: string): TypeError {
  return new TypeError(`Invalid JSON agent value at ${path}: ${message}`);
}
