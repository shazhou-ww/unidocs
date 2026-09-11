import type { BundleManifestInspection } from "./manifest.js";
import { BundleZipError } from "./zip.js";

export const IMMUTABLE_BUNDLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface BundleObjectWrite {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: "application/json" | "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp";
  readonly cacheControl: string;
  readonly sha256: string;
}

export interface BundleObjectStore {
  put(object: BundleObjectWrite): Promise<void>;
}

export interface StoredTypeCardBundle {
  readonly typeCardBundleId: string;
  readonly rootKey: string;
}

export async function storeTypeCardBundleObjects(
  inspection: BundleManifestInspection,
  store: BundleObjectStore,
): Promise<StoredTypeCardBundle> {
  if (inspection.kind !== "type-card" || inspection.manifest.protocol !== "unidocs-type-card/v1" || !inspection.assets) throw new BundleZipError();
  const digest = /^sha256:([0-9a-f]{64})$/.exec(inspection.contentHash)?.[1];
  if (!digest) throw new BundleZipError();
  const typeCardBundleId = `tb_${digest}`;
  const rootKey = `type-card-bundles/${typeCardBundleId}/`;
  const files = new Map(inspection.files.map(file => [file.path, file]));
  const manifestFile = files.get("unidocs-type-card.json");
  if (!manifestFile) throw new BundleZipError();
  const encoder = new TextEncoder();
  const objects: BundleObjectWrite[] = [{
    key: `${rootKey}unidocs-type-card.json`,
    bytes: encoder.encode(inspection.canonicalManifest),
    contentType: "application/json",
    cacheControl: IMMUTABLE_BUNDLE_CACHE_CONTROL,
    sha256: manifestFile.sha256,
  }];
  for (const asset of inspection.assets) {
    const file = files.get(asset.path);
    if (!file) throw new BundleZipError();
    objects.push({
      key: `${rootKey}${asset.path}`,
      bytes: asset.bytes,
      contentType: asset.contentType,
      cacheControl: IMMUTABLE_BUNDLE_CACHE_CONTROL,
      sha256: file.sha256,
    });
  }
  await Promise.all(objects.map(object => store.put(object)));
  return { typeCardBundleId, rootKey };
}