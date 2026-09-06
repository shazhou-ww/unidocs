import type { CasBlobSource, CasBlobWriteOptions } from "@unicas/tenant-blob-client";
import type { TenantCasClient } from "@unicas/tenant-client";

export interface TenantFileRootInfo {
  readonly rootId: string;
  readonly name: string;
  readonly manifestHash: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Business-database port. Implementations persist root identity, not file data. */
export interface TenantFileRootCatalog {
  list(): Promise<readonly TenantFileRootInfo[]>;
  create(input: { readonly rootId: string; readonly name: string; readonly manifestHash: string }): Promise<TenantFileRootInfo>;
  update(input: { readonly rootId: string; readonly revision: number; readonly name: string; readonly manifestHash: string }): Promise<TenantFileRootInfo>;
  delete(input: { readonly rootId: string; readonly revision: number }): Promise<void>;
}

export interface TenantFileStat {
  readonly path: string;
  readonly name: string;
  readonly type: "file" | "directory";
  readonly size?: number;
  readonly mediaType?: string;
}

export interface TenantFileWriteOptions extends CasBlobWriteOptions {}

/** Mutable in-memory view of one immutable manifest snapshot. */
export interface TenantFileRoot {
  readonly info: TenantFileRootInfo;
  readonly dirty: boolean;
  stat(path: string): Promise<TenantFileStat>;
  readdir(path: string): Promise<readonly TenantFileStat[]>;
  read(path: string, range?: { readonly offset: number; readonly length?: number }, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  write(path: string, source: CasBlobSource, options: TenantFileWriteOptions): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(name: string): Promise<void>;
  commit(): Promise<TenantFileRootInfo>;
  discard(): void;
}

export interface TenantFileSystem {
  listRoots(): Promise<readonly TenantFileRootInfo[]>;
  createRoot(name: string): Promise<TenantFileRoot>;
  openRoot(rootId: string): Promise<TenantFileRoot>;
  deleteRoot(rootId: string): Promise<void>;
}

export interface TenantFileSystemOptions {
  readonly cas: TenantCasClient;
  readonly catalog: TenantFileRootCatalog;
  readonly createId?: () => string;
  readonly createRequestId?: () => string;
}