import type { BundleManifestInspection, ViewBundleAsset } from "./manifest.js";
import { IMMUTABLE_BUNDLE_CACHE_CONTROL, type BundleObjectStore, type BundleObjectWrite } from "./type-card-store.js";
import { BundleZipError } from "./zip.js";

export interface StoredViewBundle {
  readonly viewBundleId: string;
  readonly rootKey: string;
}

export async function storeViewBundleObjects(inspection: BundleManifestInspection, store: BundleObjectStore): Promise<StoredViewBundle> {
  if (inspection.kind !== "view" || inspection.manifest.protocol !== "unidocs-view-bundle/v1" || !inspection.assets) throw new BundleZipError();
  const digest = /^sha256:([0-9a-f]{64})$/.exec(inspection.contentHash)?.[1];
  if (!digest) throw new BundleZipError();
  const viewBundleId = `vb_${digest}`;
  const rootKey = `view-bundles/${viewBundleId}/`;
  const files = new Map(inspection.files.map(file => [file.path, file]));
  const manifestFile = files.get("unidocs-view.json");
  if (!manifestFile) throw new BundleZipError();
  const objects: BundleObjectWrite[] = [{
    key: `${rootKey}unidocs-view.json`,
    bytes: new TextEncoder().encode(inspection.canonicalManifest),
    contentType: "application/json",
    cacheControl: IMMUTABLE_BUNDLE_CACHE_CONTROL,
    sha256: manifestFile.sha256,
  }];
  for (const asset of inspection.assets as readonly ViewBundleAsset[]) {
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
  return { viewBundleId, rootKey };
}