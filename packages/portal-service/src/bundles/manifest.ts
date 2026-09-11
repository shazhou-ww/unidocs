import { TypeCardBundleManifestV1Schema, ViewBundleManifestV1Schema, type TypeCardBundleManifestV1, type ViewBundleManifestV1 } from "@unidocs/protocol-admin-portal";
import { parseStrictJson } from "../strict-json.js";
import { canonicalJson, schemaHash } from "../identity.js";
import { validateBundlePath } from "./ingress.js";
import { inspectTypeCardAsset, type TypeCardAssetInfo } from "./type-card-assets.js";
import { BundleZipError, scanBundleZip, type BundleZipFile } from "./zip.js";

export type BundleKind = "type-card" | "view";

export interface TypeCardBundleAsset extends TypeCardAssetInfo {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type ViewBundleContentType = "text/html" | "text/css" | "text/javascript" | "application/json" | "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp" | "font/woff" | "font/woff2";

export interface ViewBundleAsset {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentType: ViewBundleContentType;
  readonly width: number | null;
  readonly height: number | null;
}

export interface BundleManifestInspection {
  readonly kind: BundleKind;
  readonly manifest: TypeCardBundleManifestV1 | ViewBundleManifestV1;
  readonly canonicalManifest: string;
  readonly contentHash: string;
  readonly archiveBytes: number;
  readonly files: readonly BundleZipFile[];
  readonly assets?: readonly (TypeCardBundleAsset | ViewBundleAsset)[];
}

function inspectViewAsset(path: string, bytes: Uint8Array): ViewBundleAsset {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const textTypes = new Map([
    [".html", "text/html"],
    [".css", "text/css"],
    [".js", "text/javascript"],
    [".mjs", "text/javascript"],
  ] as const);
  const textType = textTypes.get(extension as ".html" | ".css" | ".js" | ".mjs");
  if (textType) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || text.startsWith("\ufeff")) throw new BundleZipError();
    return { path, bytes, contentType: textType, width: null, height: null };
  }
  if (extension === ".json") {
    parseStrictJson(bytes);
    return { path, bytes, contentType: "application/json", width: null, height: null };
  }
  if ([".svg", ".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    return { path, bytes, ...inspectTypeCardAsset(path, bytes) };
  }
  if (extension === ".woff" && bytes.length >= 4 && new TextDecoder().decode(bytes.subarray(0, 4)) === "wOFF") {
    return { path, bytes, contentType: "font/woff", width: null, height: null };
  }
  if (extension === ".woff2" && bytes.length >= 4 && new TextDecoder().decode(bytes.subarray(0, 4)) === "wOF2") {
    return { path, bytes, contentType: "font/woff2", width: null, height: null };
  }
  throw new BundleZipError();
}

export async function inspectBundleManifest(
  source: ReadableStream<Uint8Array>,
  expected: {
    readonly kind: BundleKind;
    readonly documentType?: string;
    readonly documentContractIdxs: readonly number[] | ((documentType: string) => Promise<readonly number[]>);
  },
): Promise<BundleManifestInspection> {
  let revisionLookupError: unknown;
  try {
    const manifestPath = expected.kind === "type-card" ? "unidocs-type-card.json" : "unidocs-view.json";
    const otherManifestPath = expected.kind === "type-card" ? "unidocs-view.json" : "unidocs-type-card.json";
    let rawManifest: unknown;
    let archiveBytes = 0;
    const contents = new Map<string, Uint8Array>();
    const files = await scanBundleZip(source, {}, (file, content) => {
      if (file.path === otherManifestPath) throw new BundleZipError();
      contents.set(file.path, content);
      if (file.path !== manifestPath) return;
      if (file.size > 65_536) throw new BundleZipError();
      rawManifest = parseStrictJson(content);
    }, size => { archiveBytes = size; });
    const manifest = expected.kind === "type-card"
      ? TypeCardBundleManifestV1Schema.parse(rawManifest)
      : ViewBundleManifestV1Schema.parse(rawManifest);
    const canonicalManifest = canonicalJson(manifest);
    if ((expected.documentType !== undefined && manifest.documentType !== expected.documentType) || canonicalManifest !== canonicalJson(rawManifest)) throw new BundleZipError();
    const fileIndex = new Map(files.map(file => [file.path, file]));
    function requireFile(path: string, extensions: readonly string[]) {
      validateBundlePath(path);
      const file = fileIndex.get(path);
      if (!file || file.size === 0 || !extensions.some(extension => path.endsWith(extension))) throw new BundleZipError();
    }
    let assets: readonly (TypeCardBundleAsset | ViewBundleAsset)[] | undefined;
    if (manifest.protocol === "unidocs-view-bundle/v1") {
      requireFile(manifest.entrypoints.interactive, [".html"]);
      requireFile(manifest.entrypoints.thumbnail, [".html"]);
      const revisions = new Set(manifest.supportedDocumentContractIdxs);
      let documentContractIdxs: readonly number[];
      try {
        documentContractIdxs = typeof expected.documentContractIdxs === "function"
          ? await expected.documentContractIdxs(manifest.documentType)
          : expected.documentContractIdxs;
      } catch (error) {
        revisionLookupError = error;
        throw error;
      }
      const available = new Set(documentContractIdxs);
      if (revisions.size !== manifest.supportedDocumentContractIdxs.length || [...revisions].some(revision => !available.has(revision))) throw new BundleZipError();
      assets = files.filter(file => file.path !== manifestPath).map(file => {
        const bytes = contents.get(file.path);
        if (!bytes) throw new BundleZipError();
        return inspectViewAsset(file.path, bytes);
      });
    } else {
      for (const locale of Object.keys(manifest.locales)) {
        if (Intl.getCanonicalLocales(locale)[0] !== locale) throw new BundleZipError();
      }
      const referencedPaths: string[] = [];
      if (manifest.icon.kind === "svg") referencedPaths.push(manifest.icon.path);
      else referencedPaths.push(...Object.values(manifest.icon.images));
      referencedPaths.push(manifest.sampleThumbnail);
      const referenced = new Set(referencedPaths);
      if (referenced.size !== referencedPaths.length || files.some(file => file.path !== manifestPath && !referenced.has(file.path))
        || files.length !== referenced.size + 1) throw new BundleZipError();
      const inspected = new Map<string, TypeCardBundleAsset>();
      const inspectAsset = (path: string, extensions: readonly string[]) => {
        requireFile(path, extensions);
        const bytes = contents.get(path);
        if (!bytes) throw new BundleZipError();
        const asset = { path, bytes, ...inspectTypeCardAsset(path, bytes) };
        inspected.set(path, asset);
        return asset;
      };
      if (manifest.icon.kind === "svg") inspectAsset(manifest.icon.path, [".svg"]);
      else for (const [sizeText, path] of Object.entries(manifest.icon.images)) {
        const asset = inspectAsset(path, [".png"]);
        const size = Number(sizeText);
        if (asset.width !== size || asset.height !== size) throw new BundleZipError();
      }
      inspectAsset(manifest.sampleThumbnail, [".png", ".jpg", ".jpeg", ".webp"]);
      assets = [...inspected.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }
    const resources = files.filter(file => file.path !== manifestPath);
    const contentHash = await schemaHash({ kind: expected.kind, manifest, files: resources });
    const manifestFile = { path: manifestPath, size: new TextEncoder().encode(canonicalManifest).byteLength, sha256: (await schemaHash(manifest)).slice("sha256:".length) };
    return { kind: expected.kind, manifest, canonicalManifest, contentHash, archiveBytes, files: files.map(file => file.path === manifestPath ? manifestFile : file), ...(assets ? { assets } : {}) };
  } catch {
    if (revisionLookupError !== undefined) throw revisionLookupError;
    throw new BundleZipError();
  }
}