import { Document } from "@ariadng/office/docx";
import {
  OpcPackage,
  RELATIONSHIPS_CONTENT_TYPE,
  validatePartName,
} from "@ariadng/office/opc";
import { ZipReader, ZipWriter } from "@ariadng/office/zip";

export const CONTENT_TYPES_PATH = "/[Content_Types].xml";
export const CONTENT_TYPES_CONTENT_TYPE = "application/xml";

export interface PackageFileData {
  readonly data: Uint8Array;
  readonly contentType: string;
}

export interface OpenXmlPackageLimits {
  readonly maxEntries: number;
  readonly maxPackageBytes: number;
  readonly maxPartBytes: number;
  readonly maxPathBytes: number;
  readonly maxCompressionRatio: number;
}

export interface OpenedDocxPackage {
  readonly document: Document;
  readonly files: Readonly<Record<string, PackageFileData>>;
}

const DEFAULT_LIMITS: OpenXmlPackageLimits = Object.freeze({
  maxEntries: 10_000,
  maxPackageBytes: 256 * 1024 * 1024,
  maxPartBytes: 64 * 1024 * 1024,
  maxPathBytes: 1_024,
  maxCompressionRatio: 1_200,
});

const textEncoder = new TextEncoder();

export async function openDocxPackage(
  bytes: Uint8Array,
  limits?: Partial<OpenXmlPackageLimits>,
): Promise<OpenedDocxPackage> {
  const resolvedLimits = packageLimits(limits);
  validatePackageSize(bytes, resolvedLimits);
  const [document, files] = await Promise.all([
    Document.open(bytes),
    extractOpenXmlPackage(bytes, resolvedLimits),
  ]);
  return Object.freeze({ document, files });
}

export async function extractOpenXmlPackage(
  bytes: Uint8Array,
  limits?: Partial<OpenXmlPackageLimits>,
): Promise<Readonly<Record<string, PackageFileData>>> {
  const resolvedLimits = packageLimits(limits);
  validatePackageSize(bytes, resolvedLimits);
  const reader = await ZipReader.open(bytes, {
    maxCompressionRatio: resolvedLimits.maxCompressionRatio,
    maxTotalUncompressedSize: resolvedLimits.maxPackageBytes,
  });
  const packageModel = await OpcPackage.open(bytes);
  const centralEntries = reader.entries();
  if (centralEntries.length > resolvedLimits.maxEntries) {
    throw new Error(`OpenXML package exceeds ${resolvedLimits.maxEntries} ZIP entries`);
  }
  const entries = centralEntries.filter(entry => !entry.name.endsWith("/"));

  const files = Object.create(null) as Record<string, PackageFileData>;
  const equivalentPaths = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    const path = canonicalPackagePath(entry.name, resolvedLimits);
    const equivalent = asciiLower(path);
    if (equivalentPaths.has(equivalent)) {
      throw new Error(`Duplicate equivalent OpenXML package path: ${path}`);
    }
    equivalentPaths.add(equivalent);
    if (entry.uncompressedSize > resolvedLimits.maxPartBytes) {
      throw new Error(`OpenXML part ${path} exceeds ${resolvedLimits.maxPartBytes} bytes`);
    }
    totalBytes += entry.uncompressedSize;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > resolvedLimits.maxPackageBytes) {
      throw new Error(`OpenXML package exceeds ${resolvedLimits.maxPackageBytes} uncompressed bytes`);
    }

    const contentType = contentTypeForPath(packageModel, path);
    const data = await reader.read(entry.name);
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`OpenXML part ${path} length changed while reading`);
    }
    Object.defineProperty(files, path, {
      enumerable: true,
      value: Object.freeze({ data, contentType }),
    });
  }

  if (!(CONTENT_TYPES_PATH in files)) {
    throw new Error(`OpenXML package is missing ${CONTENT_TYPES_PATH}`);
  }
  return Object.freeze(files);
}

export async function buildOpenXmlPackage(
  files: Readonly<Record<string, PackageFileData>>,
  limits?: Partial<OpenXmlPackageLimits>,
): Promise<Uint8Array> {
  const resolvedLimits = packageLimits(limits);
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > resolvedLimits.maxEntries) {
    throw new Error(`OpenXML manifest must contain 1-${resolvedLimits.maxEntries} files`);
  }

  const equivalentPaths = new Set<string>();
  let totalBytes = 0;
  const normalized = entries.map(([path, file]) => {
    const canonical = canonicalPackagePath(path, resolvedLimits, true);
    const equivalent = asciiLower(canonical);
    if (equivalentPaths.has(equivalent)) {
      throw new Error(`Duplicate equivalent OpenXML package path: ${canonical}`);
    }
    equivalentPaths.add(equivalent);
    if (!file || !(file.data instanceof Uint8Array) || typeof file.contentType !== "string") {
      throw new TypeError(`OpenXML manifest entry ${canonical} is invalid`);
    }
    if (file.data.length > resolvedLimits.maxPartBytes) {
      throw new Error(`OpenXML part ${canonical} exceeds ${resolvedLimits.maxPartBytes} bytes`);
    }
    totalBytes += file.data.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > resolvedLimits.maxPackageBytes) {
      throw new Error(`OpenXML package exceeds ${resolvedLimits.maxPackageBytes} uncompressed bytes`);
    }
    return { path: canonical, data: file.data, contentType: file.contentType };
  });
  if (!equivalentPaths.has(asciiLower(CONTENT_TYPES_PATH))) {
    throw new Error(`OpenXML manifest is missing ${CONTENT_TYPES_PATH}`);
  }

  const writer = new ZipWriter();
  for (const entry of normalized.sort((left, right) => left.path.localeCompare(right.path))) {
    await writer.add(entry.path.slice(1), entry.data);
  }
  const bytes = await writer.finish();
  validatePackageSize(bytes, resolvedLimits);

  const packageModel = await OpcPackage.open(bytes);
  for (const entry of normalized) {
    const expected = contentTypeForPath(packageModel, entry.path);
    if (entry.contentType !== expected) {
      throw new Error(
        `OpenXML content type mismatch for ${entry.path}: expected ${expected}, got ${entry.contentType}`,
      );
    }
  }
  return bytes;
}

export async function materializeDocxPackage(
  files: Readonly<Record<string, PackageFileData>>,
  limits?: Partial<OpenXmlPackageLimits>,
): Promise<Document> {
  return Document.open(await buildOpenXmlPackage(files, limits));
}

function contentTypeForPath(packageModel: OpcPackage, path: string): string {
  if (asciiLower(path) === asciiLower(CONTENT_TYPES_PATH)) {
    return CONTENT_TYPES_CONTENT_TYPE;
  }
  if (asciiLower(path).endsWith(".rels")) {
    const declared = packageModel.contentTypeOf(path);
    if (declared !== undefined && declared !== RELATIONSHIPS_CONTENT_TYPE) {
      throw new Error(`Relationship part ${path} has invalid content type ${declared}`);
    }
    return RELATIONSHIPS_CONTENT_TYPE;
  }
  const contentType = packageModel.contentTypeOf(path);
  if (!contentType) throw new Error(`OpenXML part ${path} has no declared content type`);
  return contentType;
}

function canonicalPackagePath(
  path: string,
  limits: OpenXmlPackageLimits,
  allowLeadingSlash = false,
): string {
  if (path.length === 0 || path.includes("\\") || path.includes("?") || path.includes("#")) {
    throw new Error(`Invalid OpenXML package path: ${path}`);
  }
  if (!allowLeadingSlash && path.startsWith("/")) {
    throw new Error(`ZIP entry must be relative: ${path}`);
  }
  if (allowLeadingSlash && !path.startsWith("/")) {
    throw new Error(`OpenXML manifest path must be absolute: ${path}`);
  }
  const absolute = path.startsWith("/") ? path : `/${path}`;
  if (textEncoder.encode(absolute).length > limits.maxPathBytes) {
    throw new Error(`OpenXML package path exceeds ${limits.maxPathBytes} UTF-8 bytes`);
  }
  validatePartName(absolute);
  return absolute;
}

function packageLimits(overrides?: Partial<OpenXmlPackageLimits>): OpenXmlPackageLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value)) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function validatePackageSize(bytes: Uint8Array, limits: OpenXmlPackageLimits): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("DOCX bytes must be a Uint8Array");
  if (bytes.length === 0 || bytes.length > limits.maxPackageBytes) {
    throw new Error(`DOCX package must contain 1-${limits.maxPackageBytes} bytes`);
  }
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, character => character.toLowerCase());
}
