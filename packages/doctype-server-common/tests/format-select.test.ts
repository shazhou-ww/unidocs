import { describe, expect, it } from "vitest";
import type { DocumentFormat } from "@unidocs/protocol";
import { selectFormat } from "../src/format-select.js";

const fmt = (mediaTypes: string[], extensions: string[]): DocumentFormat<string> => ({
  mediaTypes,
  extensions,
  load: async () => "",
  save: async () => new Uint8Array(),
});

const CONFIG = {
  formats: {
    psd: fmt(["image/vnd.adobe.photoshop"], [".psd"]),
    png: fmt(["image/png"], [".png"]),
  },
  defaultFormat: "psd",
};

describe("selectFormat", () => {
  it("显式 name 命中就用它,不看 mediaType 和文件名", () => {
    // 三个提示互相矛盾:name 说 png,另外两个说 psd。name 优先。
    const chosen = selectFormat(CONFIG, {
      name: "png", mediaType: "image/vnd.adobe.photoshop", filename: "a.psd",
    });
    expect(chosen.name).toBe("png");
    expect(chosen.format).toBe(CONFIG.formats.png);
  });

  it("显式 name 没注册过就抛错,不悄悄回落", () => {
    // 回落会让"我明确要 jpeg"变成"给你一个 psd",而调用方以为成功了。
    expect(() => selectFormat(CONFIG, { name: "jpeg" })).toThrow("Unknown format: jpeg");
  });

  it("mediaType 唯一命中", () => {
    expect(selectFormat(CONFIG, { mediaType: "image/png" }).name).toBe("png");
  });

  it("扩展名唯一命中", () => {
    expect(selectFormat(CONFIG, { filename: "holiday.png" }).name).toBe("png");
  });

  it("mediaType 与扩展名的比较都不分大小写", () => {
    expect(selectFormat(CONFIG, { mediaType: "IMAGE/PNG" }).name).toBe("png");
    expect(selectFormat(CONFIG, { filename: "HOLIDAY.PNG" }).name).toBe("png");
  });

  it("命中多于一个就抛歧义,而不是取第一个", () => {
    const overlapping = {
      formats: { a: fmt(["image/png"], [".png"]), b: fmt(["image/png"], [".png"]) },
      defaultFormat: "a",
    };
    expect(() => selectFormat(overlapping, { mediaType: "image/png" }))
      .toThrow("Ambiguous document format");
    expect(() => selectFormat(overlapping, { filename: "x.png" }))
      .toThrow("Ambiguous document format");
  });

  // 落空链的关键分支:mediaType 撞了两个,但扩展名能唯一裁决 —— 现有行为是
  // 用扩展名的结果,**不报歧义**。写成并列规则会在这里错误地抛错。
  it("mediaType 撞车但扩展名能唯一裁决时,用扩展名的结果而不是报歧义", () => {
    const config = {
      formats: {
        a: fmt(["image/png"], [".png"]),
        b: fmt(["image/png"], [".foo"]),
      },
      defaultFormat: "a",
    };
    expect(selectFormat(config, { mediaType: "image/png", filename: "x.png" }).name).toBe("a");
    expect(selectFormat(config, { mediaType: "image/png", filename: "x.foo" }).name).toBe("b");
  });

  // 两个维度都无法唯一裁决,才轮到歧义。
  it("两个维度都撞车才抛歧义", () => {
    const config = {
      formats: { a: fmt(["image/png"], [".png"]), b: fmt(["image/png"], [".png"]) },
      defaultFormat: "a",
    };
    expect(() => selectFormat(config, { mediaType: "image/png", filename: "x.png" }))
      .toThrow("Ambiguous document format");
  });

  it("全不命中就回落 defaultFormat", () => {
    // 这是**回归护栏**:不带文件名、或者带着奇怪文件名的 PSD 上传今天就是
    // 这样的,必须继续能用。真正不是 PSD 的字节会在 load() 里报错,
    // 那才是正确的报错位置。
    expect(selectFormat(CONFIG, {}).name).toBe("psd");
    expect(selectFormat(CONFIG, { mediaType: "application/octet-stream" }).name).toBe("psd");
    expect(selectFormat(CONFIG, { filename: "blob" }).name).toBe("psd");
  });

  it("defaultFormat 没注册过就抛错", () => {
    expect(() => selectFormat({ formats: {}, defaultFormat: "psd" }, {}))
      .toThrow("Default format psd is not configured");
  });
});
