import { describe, expect, test } from "vitest";
import { boundedBytes, validateBundlePath } from "../src/index.js";

describe("bundle ingress foundations", () => {
  test.each([
    "", "/view.html", "../view.html", "assets/../../view.html", "assets/./view.html",
    "assets//view.html", "assets/", "C:/view.html", "\\view.html", "assets\\view.html",
    "//other.example/view.html", "https://other.example/view.html", "%2e%2e/view.html",
    "%252e%252e/view.html", "view.html?raw=1", "view.html#entry", "view\0.html",
    "assets\n/view.html", "assets. /view.html", "assets./view.html", "view.html ",
    "\ud800.html", "e\u0301.html",
  ])("rejects adversarial raw entry path %j", path => {
    expect(() => validateBundlePath(path)).toThrow(TypeError);
  });

  test("preserves valid relative paths and enforces UTF-8 byte lengths", () => {
    expect(validateBundlePath("assets/view.js")).toBe("assets/view.js");
    expect(validateBundlePath("\u00e9.html", 7)).toBe("\u00e9.html");
    expect(() => validateBundlePath("\u00e9.html", 6)).toThrow("length");
    expect(validateBundlePath("a".repeat(512))).toHaveLength(512);
    expect(() => validateBundlePath("a".repeat(513))).toThrow("length");
  });

  test("streams up to the exact byte limit without buffering the body", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    } });
    const chunks = [];
    for await (const chunk of boundedBytes(stream, 3)) chunks.push([...chunk]);
    expect(chunks).toEqual([[1, 2], [3]]);
    expect(stream.locked).toBe(false);
  });

  test("cancels as soon as cumulative bytes exceed the bound", async () => {
    let cancelled = false;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; controller.enqueue(new Uint8Array(2)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const iterator = boundedBytes(stream, 3);
    expect((await iterator.next()).value).toHaveLength(2);
    await expect(iterator.next()).rejects.toThrow("byte limit");
    expect(reads).toBe(2);
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("early consumer termination cancels the upstream stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    for await (const chunk of boundedBytes(stream, 10)) {
      expect(chunk.byteLength).toBe(1);
      break;
    }
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("propagates read failures and releases the reader", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("read failed")); } });
    await expect(boundedBytes(stream, 10).next()).rejects.toThrow("read failed");
    expect(stream.locked).toBe(false);
  });

  test.each([-1, NaN, Infinity, 1.5])("rejects invalid byte budget %s before locking", async limit => {
    const stream = new ReadableStream<Uint8Array>();
    await expect(boundedBytes(stream, limit).next()).rejects.toThrow("Invalid stream byte limit");
    expect(stream.locked).toBe(false);
  });
});