import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { boundedBytes, validateBundlePath } from "./ingress.js";

export const BUNDLE_ZIP_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  entries: 512,
  fileBytes: 4 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  compressionRatio: 100,
});

export class BundleZipError extends Error {
  readonly code = "bundle_invalid";
  constructor() {
    super("Invalid or oversized bundle ZIP");
    this.name = "BundleZipError";
  }
}

export interface BundleZipFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export async function inspectBundleZip(source: ReadableStream<Uint8Array>, budgets: Partial<Record<keyof typeof BUNDLE_ZIP_LIMITS, number>> = {}): Promise<readonly BundleZipFile[]> {
  return scanBundleZip(source, budgets);
}

export async function scanBundleZip(
  source: ReadableStream<Uint8Array>,
  budgets: Partial<Record<keyof typeof BUNDLE_ZIP_LIMITS, number>> = {},
  inspectFile?: (file: BundleZipFile, content: Uint8Array) => void | Promise<void>,
): Promise<readonly BundleZipFile[]> {
  const limits = { ...BUNDLE_ZIP_LIMITS, ...budgets };
  for (const key of Object.keys(BUNDLE_ZIP_LIMITS) as (keyof typeof BUNDLE_ZIP_LIMITS)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > BUNDLE_ZIP_LIMITS[key]) throw new RangeError("Invalid ZIP limit");
  }
  let reader: ZipReader<Uint8Array> | undefined;
  try {
    const archive = new Uint8Array(limits.archiveBytes);
    let archiveSize = 0;
    for await (const chunk of boundedBytes(source, limits.archiveBytes)) {
      archive.set(chunk, archiveSize);
      archiveSize += chunk.byteLength;
    }
    reader = new ZipReader(new Uint8ArrayReader(archive.subarray(0, archiveSize)), {
      useWebWorkers: false,
      useCompressionStream: true,
      checkSignature: true,
      checkOverlappingEntry: true,
      strictness: "strict",
    });
    const paths = new Map<string, boolean>();
    const files: BundleZipFile[] = [];
    let entryCount = 0;
    let expandedBytes = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (++entryCount > limits.entries) throw new BundleZipError();
      const rawPath = new TextDecoder("utf-8", { fatal: true }).decode(entry.rawFilename);
      if (rawPath !== entry.filename || entry.encrypted || entry.symlink || entry.diskNumberStart !== 0 || ![0, 8].includes(entry.compressionMethod)) throw new BundleZipError();
      const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (unixType !== 0 && unixType !== (entry.directory ? 0x4000 : 0x8000)) throw new BundleZipError();
      const path = validateBundlePath(entry.directory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath);
      if (paths.has(path)) throw new BundleZipError();
      const segments = path.split("/");
      for (let depth = 1; depth < segments.length; depth++) {
        if (paths.get(segments.slice(0, depth).join("/")) === false) throw new BundleZipError();
      }
      if (!entry.directory && [...paths.keys()].some(existing => existing.startsWith(`${path}/`))) throw new BundleZipError();
      paths.set(path, entry.directory);
      if (!Number.isSafeInteger(entry.uncompressedSize) || !Number.isSafeInteger(entry.compressedSize) || entry.uncompressedSize < 0 || entry.compressedSize < 0 || entry.compressedSize > archiveSize) throw new BundleZipError();
      if (entry.directory) {
        if (entry.uncompressedSize !== 0 || entry.compressedSize !== 0) throw new BundleZipError();
        continue;
      }
      if (entry.uncompressedSize > limits.fileBytes || entry.uncompressedSize > Math.max(1, entry.compressedSize) * limits.compressionRatio || expandedBytes + entry.uncompressedSize > limits.expandedBytes) throw new BundleZipError();
      const content = new Uint8Array(entry.uncompressedSize);
      let size = 0;
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.byteLength;
          expandedBytes += chunk.byteLength;
          if (size > content.byteLength || size > limits.fileBytes || expandedBytes > limits.expandedBytes || size > Math.max(1, entry.compressedSize) * limits.compressionRatio) throw new BundleZipError();
          content.set(chunk, size - chunk.byteLength);
        },
      }));
      if (size !== entry.uncompressedSize || entry.warnings?.length) throw new BundleZipError();
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
      const file = { path, size, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") };
      await inspectFile?.(file, content);
      files.push(file);
    }
    if (files.length === 0 || reader.warnings?.length) throw new BundleZipError();
    return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  } catch {
    throw new BundleZipError();
  } finally {
    await reader?.close();
  }
}