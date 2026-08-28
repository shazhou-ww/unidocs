import { describe, expect, it } from "vitest";
import {
  createSBlob, requireNumber, requireNumberArray, requireRecord, requireSBlob, requireString,
} from "../src/index.js";

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

  it("requireNumberArray 不带长度时只管元素", () => {
    expect(requireNumberArray([1, 2, 3], "r")).toEqual([1, 2, 3]);
    expect(requireNumberArray([], "r")).toEqual([]);
    expect(() => requireNumberArray("no", "r")).toThrow("r must be an array of finite numbers");
    expect(() => requireNumberArray(undefined, "r")).toThrow("r must be an array of finite numbers");
    expect(() => requireNumberArray([1, "2"], "r")).toThrow("r must be an array of finite numbers");
    expect(() => requireNumberArray([1, Number.NaN], "r")).toThrow("r must be an array of finite numbers");
  });

  it("requireNumberArray 带长度时长度不对也报同一句", () => {
    expect(requireNumberArray([0, 0, 6, 8], "region", 4)).toEqual([0, 0, 6, 8]);
    expect(() => requireNumberArray([0, 0, 6], "region", 4))
      .toThrow("region must be an array of 4 finite numbers");
    expect(() => requireNumberArray([0, 0, 6, 8, 9], "region", 4))
      .toThrow("region must be an array of 4 finite numbers");
    expect(() => requireNumberArray({ a: 1 }, "region", 4))
      .toThrow("region must be an array of 4 finite numbers");
  });

  it("requireString / requireSBlob", () => {
    expect(requireString("s", "s")).toBe("s");
    expect(() => requireString(1, "s")).toThrow("s must be a string");
    const blob = createSBlob("b".repeat(64));
    expect(requireSBlob(blob, "b")).toBe(blob);
    expect(() => requireSBlob({}, "b")).toThrow("b must be an SBlob");
  });
});
