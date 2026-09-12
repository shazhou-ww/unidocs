import { TextReader, Uint8ArrayWriter, ZipWriter, type ZipWriterAddDataOptions } from "@zip.js/zip.js";
import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { BUNDLE_ZIP_LIMITS, BundleZipError, inspectBundleZip } from "../src/index.js";
import { ADMIN_MCP_ZIP_MAX_BYTES } from "@unidocs/protocol-admin-portal";
import { adminMcpZipStream } from "../src/mcp/input.js";

async function zip(entries: { path: string; text?: string; options?: ZipWriterAddDataOptions }[]) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  for (const entry of entries) await writer.add(entry.path, entry.options?.directory ? undefined : new TextReader(entry.text ?? "content"), entry.options);
  return writer.close();
}

function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function replaceName(bytes: Uint8Array, before: string, after: string) {
  const original = new TextEncoder().encode(before);
  const replacement = new TextEncoder().encode(after);
  expect(original.length).toBe(replacement.length);
  const changed = bytes.slice();
  for (let offset = 0; offset <= changed.length - original.length; offset++) {
    if (original.every((byte, index) => changed[offset + index] === byte)) changed.set(replacement, offset);
  }
  return changed;
}

describe("real ZIP security fixtures", () => {
  test("MCP base64 uploads use the same ZIP validation and reject bombs", async () => {
    const bytes = await zip([{ path: "file.js", text: "export {};" }]);
    expect(await inspectBundleZip(adminMcpZipStream(Buffer.from(bytes).toString("base64")))).toEqual(await inspectBundleZip(stream(bytes)));
    const bomb = await zip([{ path: "bomb.js", text: "A".repeat(200_000), options: { level: 9 } }]);
    await expect(inspectBundleZip(adminMcpZipStream(Buffer.from(bomb).toString("base64")))).rejects.toBeInstanceOf(BundleZipError);
  });

  test("MCP decoding is bounded, byte-exact, lazy and cancellable", async () => {
    expect(ADMIN_MCP_ZIP_MAX_BYTES).toBe(BUNDLE_ZIP_LIMITS.archiveBytes);
    const bytes = Buffer.alloc(BUNDLE_ZIP_LIMITS.archiveBytes, 123);
    const decode = vi.spyOn(globalThis, "atob");
    try {
      const input = adminMcpZipStream(bytes.toString("base64"));
      expect(decode).not.toHaveBeenCalled();
      const reader = input.getReader();
      const first = await reader.read();
      expect(first.value).toBeDefined();
      expect(Buffer.from(first.value!).equals(bytes.subarray(0, 48 * 1024))).toBe(true);
      expect(decode).toHaveBeenCalledTimes(1);
      await reader.cancel();
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      expect(decode).toHaveBeenCalledTimes(1);
      const decoded = new Uint8Array(await new Response(adminMcpZipStream(bytes.toString("base64"))).arrayBuffer());
      expect(Buffer.from(decoded).equals(bytes)).toBe(true);
      expect(decode.mock.calls.every(([chunk]) => chunk.length <= 64 * 1024)).toBe(true);
    } finally {
      decode.mockRestore();
    }
  });

  test("MCP rejects malformed base64 before decoding without echoing input", () => {
    const decode = vi.spyOn(globalThis, "atob");
    try {
      expect(() => adminMcpZipStream("data:secret-private-filename.zip")).toThrow("The MCP tool input or confirmation is invalid");
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  test("validates stored and deflated files, returning sorted verified content digests", async () => {
    const bytes = await zip([{ path: "assets/", options: { directory: true } }, { path: "view.html", text: "<html>View</html>", options: { level: 6 } }, { path: "assets/app.js", text: "export {};" }]);
    expect(await inspectBundleZip(stream(bytes))).toEqual([
      { path: "assets/app.js", size: 10, sha256: createHash("sha256").update("export {};").digest("hex") },
      { path: "view.html", size: 17, sha256: createHash("sha256").update("<html>View</html>").digest("hex") },
    ]);
  });

  test.each(["../bad.js", "/bad.html", "a\\bad.js", "%2ebad.js"])("rejects raw malicious filename %s", async path => {
    const safe = "x".repeat(path.length);
    const bytes = replaceName(await zip([{ path: safe }]), safe, path);
    await expect(inspectBundleZip(stream(bytes))).rejects.toBeInstanceOf(BundleZipError);
  });

  test("rejects duplicate paths in the central directory", async () => {
    const bytes = replaceName(await zip([{ path: "one.js" }, { path: "two.js" }]), "two.js", "one.js");
    await expect(inspectBundleZip(stream(bytes))).rejects.toBeInstanceOf(BundleZipError);
  });

  test("rejects symlinks and encrypted entries", async () => {
    for (const options of [{ unixMode: 0o120777 }, { password: "fixture-password" }]) {
      await expect(inspectBundleZip(stream(await zip([{ path: "link.js", text: "../secret", options }])))).rejects.toBeInstanceOf(BundleZipError);
    }
  });

  test("rejects file/directory conflicts in either order", async () => {
    for (const entries of [[{ path: "a.js" }, { path: "b.js/file" }], [{ path: "b.js/file" }, { path: "a.js" }]]) {
      const bytes = replaceName(await zip(entries), "b.js", "a.js");
      await expect(inspectBundleZip(stream(bytes))).rejects.toBeInstanceOf(BundleZipError);
    }
  });

  test("rejects corrupted CRC and truncated archives", async () => {
    const bytes = await zip([{ path: "file.js", text: "original-content" }]);
    await expect(inspectBundleZip(stream(replaceName(bytes, "original-content", "modified-content")))).rejects.toBeInstanceOf(BundleZipError);
    await expect(inspectBundleZip(stream(bytes.slice(0, -12)))).rejects.toBeInstanceOf(BundleZipError);
  });

  test("rejects local header names that differ from the central directory", async () => {
    const bytes = await zip([{ path: "good.js" }]);
    bytes[30] = "b".charCodeAt(0);
    await expect(inspectBundleZip(stream(bytes))).rejects.toBeInstanceOf(BundleZipError);
  });

  test("rejects forged output sizes even when local and central headers agree", async () => {
    const bytes = await zip([{ path: "file.js", text: "actual-content".repeat(100), options: { level: 6, dataDescriptor: false } }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(22, 1, true);
    for (let offset = 0; offset + 46 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 1, true);
    }
    await expect(inspectBundleZip(stream(bytes))).rejects.toBeInstanceOf(BundleZipError);
  });

  test("enforces entry count, per-file, expanded and archive size budgets", async () => {
    const bytes = await zip([{ path: "one.js", text: "1234" }, { path: "two.js", text: "1234" }]);
    for (const budgets of [{ entries: 1 }, { fileBytes: 3 }, { expandedBytes: 7 }, { archiveBytes: bytes.length - 1 }]) {
      await expect(inspectBundleZip(stream(bytes), budgets)).rejects.toBeInstanceOf(BundleZipError);
    }
    expect(await inspectBundleZip(stream(bytes), { fileBytes: 4, expandedBytes: 8, archiveBytes: bytes.length })).toHaveLength(2);
  });

  test("rejects a highly compressed ZIP bomb before expanding its content", async () => {
    const bytes = await zip([{ path: "bomb.js", text: "A".repeat(200_000), options: { level: 9 } }]);
    await expect(inspectBundleZip(stream(bytes))).rejects.toBeInstanceOf(BundleZipError);
  });

  test("cancels an oversized input stream", async () => {
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(100)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await expect(inspectBundleZip(input, { archiveBytes: 99 })).rejects.toBeInstanceOf(BundleZipError);
    expect(cancelled).toBe(true);
    expect(input.locked).toBe(false);
  });

  test("rejects empty archives and cannot increase hard security ceilings", async () => {
    await expect(inspectBundleZip(stream(await zip([])))).rejects.toBeInstanceOf(BundleZipError);
    await expect(inspectBundleZip(stream(new Uint8Array()), { archiveBytes: BUNDLE_ZIP_LIMITS.archiveBytes + 1 })).rejects.toThrow(RangeError);
  });
});