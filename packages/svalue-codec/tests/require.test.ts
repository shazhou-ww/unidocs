import { describe, expect, it } from "vitest";
import { createSBlob, requireNumber, requireRecord, requireSBlob, requireString } from "../src/index.js";

describe("SValue 窄化 helper", () => {
  it("requireRecord 接受普通对象", () => {
    expect(requireRecord({ a: 1 }, "x")).toEqual({ a: 1 });
  });

  it("requireRecord 拒绝数组、null 和 SBlob", () => {
    expect(() => requireRecord([1] as never, "x")).toThrow("x must be an object");
    expect(() => requireRecord(null as never, "x")).toThrow("x must be an object");
    expect(() => requireRecord(createSBlob("a".repeat(64)) as never, "x")).toThrow("x must be an object");
  });

  it("requireNumber 拒绝 NaN 和 Infinity", () => {
    expect(requireNumber(1.5, "n")).toBe(1.5);
    expect(() => requireNumber(Number.NaN, "n")).toThrow("n must be a finite number");
    expect(() => requireNumber(undefined, "n")).toThrow("n must be a finite number");
  });

  it("requireString / requireSBlob", () => {
    expect(requireString("s", "s")).toBe("s");
    expect(() => requireString(1, "s")).toThrow("s must be a string");
    const blob = createSBlob("b".repeat(64));
    expect(requireSBlob(blob, "b")).toBe(blob);
    expect(() => requireSBlob({}, "b")).toThrow("b must be an SBlob");
  });
});
