/** Stable wire contract for file manifests stored as CAS node own content. */
export const FileManifestContentType = "application/vnd.unicas.file-manifest+cbor;version=1";
export const FileManifestVersion = 1 as const;
export const FileManifestMaxFiles = 256;
export const FileManifestMaxEntries = 4096;
export const FileManifestMaxPathBytes = 1024;

export interface TenantDirectoryEntry {
  readonly path: string;
  readonly type: "directory";
}

export interface TenantFileEntry {
  readonly path: string;
  readonly type: "file";
  /** Ordinal in the containing CAS node's refs array. */
  readonly ref: number;
  readonly size: number;
  readonly mediaType: string;
}

export type TenantFileManifestEntry = TenantDirectoryEntry | TenantFileEntry;

export interface TenantFileManifestV1 {
  readonly version: typeof FileManifestVersion;
  readonly entries: readonly TenantFileManifestEntry[];
}