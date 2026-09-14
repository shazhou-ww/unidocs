import { expect, test } from "vitest";
import { inspectTypeCardAsset } from "../src/bundles/type-card-assets.js";

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number) {
  const chunk = (type: string, data: Uint8Array) => {
    const bytes = new Uint8Array(12 + data.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(data, 8);
    view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
    return bytes;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6;
  const chunks = [chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())];
  const result = new Uint8Array(8 + chunks.reduce((size, value) => size + value.length, 0));
  result.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8; for (const value of chunks) { result.set(value, offset); offset += value.length; }
  return result;
}

test("parses valid PNG dimensions and rejects corrupt or oversized images", () => {
  expect(inspectTypeCardAsset("icon.png", png(32, 32))).toEqual({ contentType: "image/png", width: 32, height: 32 });
  const corrupt = png(32, 32); corrupt[30] ^= 1;
  expect(() => inspectTypeCardAsset("icon.png", corrupt)).toThrow();
  expect(() => inspectTypeCardAsset("icon.png", png(5000, 1))).toThrow();
});

test("accepts a restricted SVG and rejects active or external content", () => {
  const valid = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Icon</title><path fill="#123" d="M0 0h1v1z"/></svg>');
  expect(inspectTypeCardAsset("icon.svg", valid)).toEqual({ contentType: "image/svg+xml", width: null, height: null });
  for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/x"/></svg>', '<!DOCTYPE svg><svg/>', '<svg style="color:red"/>']) {
    expect(() => inspectTypeCardAsset("icon.svg", new TextEncoder().encode(text))).toThrow();
  }
});

test("parses minimal JPEG and WebP dimensions", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 10, 0, 20, 3, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
  expect(inspectTypeCardAsset("sample.jpg", jpeg)).toEqual({ contentType: "image/jpeg", width: 20, height: 10 });
  const headerOnly = new Uint8Array(30); headerOnly.set(new TextEncoder().encode("RIFF")); new DataView(headerOnly.buffer).setUint32(4, 22, true); headerOnly.set(new TextEncoder().encode("WEBPVP8X"), 8); new DataView(headerOnly.buffer).setUint32(16, 10, true); headerOnly[24] = 19; headerOnly[27] = 9;
  expect(() => inspectTypeCardAsset("sample.webp", headerOnly)).toThrow();
  const webp = Uint8Array.from(Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));
  expect(inspectTypeCardAsset("sample.webp", webp)).toEqual({ contentType: "image/webp", width: 1, height: 1 });
});