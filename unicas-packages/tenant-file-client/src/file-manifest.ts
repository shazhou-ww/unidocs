import { decode, encode, rfc8949EncodeOptions } from "cborg";
import {
  FileManifestMaxEntries,
  FileManifestMaxFiles,
  FileManifestMaxPathBytes,
  FileManifestVersion,
  type TenantFileEntry,
  type TenantFileManifestEntry,
  type TenantFileManifestV1,
} from "./file-protocol.js";

type WireEntry = readonly ["d", string] | readonly ["f", string, number, number, string];

export function validateFileManifest(value: TenantFileManifestV1): void {
  if (value.version !== FileManifestVersion) throw new TypeError("File manifest version must be 1");
  if (!Array.isArray(value.entries) || value.entries.length > FileManifestMaxEntries) {
    throw new TypeError(`File manifest must contain at most ${FileManifestMaxEntries} entries`);
  }
  let previousPath = "";
  let fileCount = 0;
  const filePaths = new Set<string>();
  for (const entry of value.entries) {
    validatePath(entry.path);
    if (entry.path <= previousPath) throw new TypeError("File manifest entries must be uniquely sorted by path");
    previousPath = entry.path;
    for (const filePath of filePaths) {
      if (entry.path.startsWith(`${filePath}/`)) {
        throw new TypeError(`File manifest path descends from file: ${filePath}`);
      }
    }
    if (entry.type === "directory") continue;
    if (entry.type !== "file") throw new TypeError("File manifest entry type is invalid");
    if (entry.ref !== fileCount) throw new TypeError("File manifest file refs must be contiguous in path order");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new TypeError("File size must be a non-negative safe integer");
    if (!/^[\x20-\x7e]+$/.test(entry.mediaType) || entry.mediaType.length > 1024) {
      throw new TypeError("File media type must be 1-1024 printable ASCII characters");
    }
    filePaths.add(entry.path);
    fileCount += 1;
  }
  if (fileCount > FileManifestMaxFiles) {
    throw new TypeError(`File manifest must contain at most ${FileManifestMaxFiles} files`);
  }
}

export function createFileManifest(entries: readonly TenantFileManifestEntry[]): TenantFileManifestV1 {
  const sorted = entries.map((entry) => ({ ...entry })).sort((left, right) => left.path.localeCompare(right.path));
  let ref = 0;
  const normalized = sorted.map((entry): TenantFileManifestEntry =>
    entry.type === "directory" ? entry : { ...entry, ref: ref++ });
  const manifest = { version: FileManifestVersion, entries: normalized } as const;
  validateFileManifest(manifest);
  return freezeManifest(manifest);
}

export function encodeFileManifest(value: TenantFileManifestV1): Uint8Array {
  validateFileManifest(value);
  const entries: WireEntry[] = value.entries.map((entry) => entry.type === "directory"
    ? ["d", entry.path]
    : ["f", entry.path, entry.ref, entry.size, entry.mediaType]);
  return Uint8Array.from(encode({ v: value.version, e: entries }, rfc8949EncodeOptions));
}

export function decodeFileManifest(bytes: Uint8Array): TenantFileManifestV1 {
  const decoded = decode(bytes) as { v?: unknown; e?: unknown } | null;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("File manifest must be a CBOR map");
  }
  if (Object.keys(decoded).sort().join(",") !== "e,v" || !Array.isArray(decoded.e)) {
    throw new TypeError("File manifest contains unknown or missing fields");
  }
  const entries = decoded.e.map(decodeEntry);
  const manifest = { version: decoded.v, entries } as TenantFileManifestV1;
  validateFileManifest(manifest);
  if (!equalBytes(bytes, encodeFileManifest(manifest))) throw new TypeError("File manifest encoding is not canonical");
  return freezeManifest(manifest);
}

export function fileManifestRefs(manifest: TenantFileManifestV1, refs: readonly string[]): ReadonlyMap<string, string> {
  validateFileManifest(manifest);
  const files = manifest.entries.filter((entry): entry is TenantFileEntry => entry.type === "file");
  if (files.length !== refs.length) throw new TypeError("File manifest refs do not match its file entries");
  return new Map(files.map((entry) => [entry.path, refs[entry.ref]!]));
}

function decodeEntry(value: unknown): TenantFileManifestEntry {
  if (!Array.isArray(value)) throw new TypeError("File manifest entry must be an array");
  if (value.length === 2 && value[0] === "d" && typeof value[1] === "string") {
    return { type: "directory", path: value[1] };
  }
  if (value.length === 5 && value[0] === "f" && typeof value[1] === "string"
    && typeof value[2] === "number" && typeof value[3] === "number" && typeof value[4] === "string") {
    return { type: "file", path: value[1], ref: value[2], size: value[3], mediaType: value[4] };
  }
  throw new TypeError("File manifest entry is invalid");
}

function validatePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || new TextEncoder().encode(path).length > FileManifestMaxPathBytes) {
    throw new TypeError(`File path must be 1-${FileManifestMaxPathBytes} UTF-8 bytes`);
  }
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new TypeError(`Invalid file path: ${path}`);
  }
  if (path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`Invalid file path: ${path}`);
  }
}

function freezeManifest(value: TenantFileManifestV1): TenantFileManifestV1 {
  return Object.freeze({
    version: FileManifestVersion,
    entries: Object.freeze(value.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}