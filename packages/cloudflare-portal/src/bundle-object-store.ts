import type { BundleObjectStore, BundleObjectWrite } from "@unidocs/portal-service";

export class R2BundleObjectStore implements BundleObjectStore {
  constructor(private readonly bucket: R2Bucket) { }

  async put(object: BundleObjectWrite): Promise<void> {
    await this.bucket.put(object.key, object.bytes, {
      httpMetadata: { contentType: object.contentType, cacheControl: object.cacheControl },
      customMetadata: { sha256: object.sha256 },
    });
  }
}