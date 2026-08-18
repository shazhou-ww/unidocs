import { describe, expect, it } from "vitest";
import { encodeQueryValue } from "../src/query-value.js";

describe("encodeQueryValue", () => {
  it("encodes nested byte arrays as tagged base64", () => {
    expect(encodeQueryValue({
      title: "image",
      data: new Uint8Array([0, 1, 2, 253, 254, 255]),
      items: [true, null, new Uint8Array([102, 111, 111])],
    })).toEqual({
      title: "image",
      data: { $unidocs: { type: "bytes", base64: "AAEC/f7/" } },
      items: [true, null, { $unidocs: { type: "bytes", base64: "Zm9v" } }],
    });
  });

  it("escapes ordinary objects that use the reserved tag", () => {
    expect(encodeQueryValue({ $unidocs: "user value", count: 1 })).toEqual({
      $unidocs: {
        type: "object",
        value: { $unidocs: "user value", count: 1 },
      },
    });
  });

  it("rejects values that JSON cannot faithfully represent", () => {
    expect(() => encodeQueryValue(Number.NaN)).toThrow(/non-finite/);

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => encodeQueryValue(circular as never)).toThrow(/circular/);
  });
});