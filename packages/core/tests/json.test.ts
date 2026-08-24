import { describe, expect, it } from "vitest";
import { toJsonValue } from "../src/index.js";
import { createSBlob } from "../src/internal.js";

describe("toJsonValue", () => {
  it("preserves nested JSON data and prototype-sensitive keys", () => {
    const value = Object.create(null) as Record<string, string | readonly number[]>;
    Object.defineProperty(value, "__proto__", { enumerable: true, value: "data" });
    value.items = [1, 2];

    const json = toJsonValue(value);

    expect(Object.getPrototypeOf(json)).toBeNull();
    expect((json as Record<string, unknown>).__proto__).toBe("data");
    expect((json as Record<string, unknown>).items).toEqual([1, 2]);
  });

  it("rejects SBlob instead of degrading it to a hash object", () => {
    const blob = createSBlob("a".repeat(64));
    expect(() => toJsonValue({ blob })).toThrow(/cannot be represented as JSON/);
  });

  it("rejects non-JSON objects, accessors, sparse arrays, and cycles", () => {
    expect(() => toJsonValue(new Date(0))).toThrow(/Object.prototype/);
    expect(() => toJsonValue({ value: undefined })).toThrow(/unsupported undefined/);
    expect(() => toJsonValue(
      Object.defineProperty({}, "value", { enumerable: true, get: () => 1 }),
    )).toThrow(/data properties/);

    const sparse = new Array(2);
    sparse[1] = "x";
    expect(() => toJsonValue(sparse)).toThrow(/dense/);

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => toJsonValue(cycle)).toThrow(/circular/);
  });
});