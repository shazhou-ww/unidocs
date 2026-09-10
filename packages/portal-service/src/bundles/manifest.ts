import { TypeCardBundleManifestV1Schema, ViewBundleManifestV1Schema, type TypeCardBundleManifestV1, type ViewBundleManifestV1 } from "@unidocs/protocol-admin-portal";
import { parseStrictJson } from "../strict-json.js";
import { canonicalJson, schemaHash } from "../identity.js";
import { validateBundlePath } from "./ingress.js";
import { BundleZipError, scanBundleZip, type BundleZipFile } from "./zip.js";

export type BundleKind = "type-card" | "view";

export interface BundleManifestInspection {
  readonly kind: BundleKind;
  readonly manifest: TypeCardBundleManifestV1 | ViewBundleManifestV1;
  readonly canonicalManifest: string;
  readonly contentHash: string;
  readonly files: readonly BundleZipFile[];
}

export async function inspectBundleManifest(
  source: ReadableStream<Uint8Array>,
  expected: { readonly kind: BundleKind; readonly documentType: string; readonly documentContractIdxs: readonly number[] },
): Promise<BundleManifestInspection> {
  try {
    const manifestPath = expected.kind === "type-card" ? "unidocs-type-card.json" : "unidocs-view.json";
    const otherManifestPath = expected.kind === "type-card" ? "unidocs-view.json" : "unidocs-type-card.json";
    let rawManifest: unknown;
    const files = await scanBundleZip(source, {}, (file, content) => {
      if (file.path === otherManifestPath) throw new BundleZipError();
      if (file.path !== manifestPath) return;
      if (file.size > 65_536) throw new BundleZipError();
      rawManifest = parseStrictJson(content);
    });
    const manifest = expected.kind === "type-card"
      ? TypeCardBundleManifestV1Schema.parse(rawManifest)
      : ViewBundleManifestV1Schema.parse(rawManifest);
    const canonicalManifest = canonicalJson(manifest);
    if (manifest.documentType !== expected.documentType || canonicalManifest !== canonicalJson(rawManifest)) throw new BundleZipError();
    const fileIndex = new Map(files.map(file => [file.path, file]));
    function requireFile(path: string, extensions: readonly string[]) {
      validateBundlePath(path);
      const file = fileIndex.get(path);
      if (!file || file.size === 0 || !extensions.some(extension => path.endsWith(extension))) throw new BundleZipError();
    }
    if (manifest.protocol === "unidocs-view-bundle/v1") {
      requireFile(manifest.entrypoints.interactive, [".html"]);
      requireFile(manifest.entrypoints.thumbnail, [".html"]);
      const revisions = new Set(manifest.supportedDocumentContractIdxs);
      const available = new Set(expected.documentContractIdxs);
      if (revisions.size !== manifest.supportedDocumentContractIdxs.length || [...revisions].some(revision => !available.has(revision))) throw new BundleZipError();
    } else {
      for (const locale of Object.keys(manifest.locales)) {
        if (Intl.getCanonicalLocales(locale)[0] !== locale) throw new BundleZipError();
      }
      if (manifest.icon.kind === "svg") requireFile(manifest.icon.path, [".svg"]);
      else for (const path of Object.values(manifest.icon.images)) requireFile(path, [".png"]);
      requireFile(manifest.sampleThumbnail, [".png", ".jpg", ".jpeg", ".webp"]);
    }
    const resources = files.filter(file => file.path !== manifestPath);
    const contentHash = await schemaHash({ kind: expected.kind, manifest, files: resources });
    const manifestFile = { path: manifestPath, size: new TextEncoder().encode(canonicalManifest).byteLength, sha256: (await schemaHash(manifest)).slice("sha256:".length) };
    return { kind: expected.kind, manifest, canonicalManifest, contentHash, files: files.map(file => file.path === manifestPath ? manifestFile : file) };
  } catch {
    throw new BundleZipError();
  }
}