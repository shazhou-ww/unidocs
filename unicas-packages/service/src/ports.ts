export interface SqlResult<Row = unknown> {
  readonly results?: readonly Row[];
  readonly success: boolean;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface SqlStatement<Row = unknown> {
  bind(...values: readonly unknown[]): SqlStatement<Row>;
  first<Result = Row>(column?: string): Promise<Result | null>;
  all<Result = Row>(): Promise<SqlResult<Result>>;
  run(): Promise<SqlResult<Row>>;
  raw<Result = unknown>(options?: { readonly columnNames?: boolean }): Promise<readonly Result[]>;
}

export interface SqlDatabase {
  prepare<Row = unknown>(query: string): SqlStatement<Row>;
  batch<Row = unknown>(statements: readonly SqlStatement[]): Promise<readonly SqlResult<Row>[]>;
  exec(query: string): Promise<unknown>;
}

export interface BlobRange {
  readonly offset: number;
  readonly length?: number;
}

export interface BlobObject {
  readonly size: number;
  readonly body: ReadableStream<Uint8Array>;
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly httpMetadata?: Readonly<Record<string, unknown>>;
}

export interface BlobStore {
  get(key: string, options?: { readonly range?: BlobRange }): Promise<BlobObject | null>;
  head(key: string): Promise<Omit<BlobObject, "body"> | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string,
    options?: {
      readonly customMetadata?: Readonly<Record<string, string>>;
      readonly httpMetadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<unknown>;
  delete(keys: string | readonly string[]): Promise<void>;
}

export interface KeyedActorPort {
  fetch(key: string, request: Request): Promise<Response>;
}

export interface ServicePlatform {
  readonly controlDatabase: SqlDatabase;
  readonly tenantDatabase: SqlDatabase;
  readonly blobs: BlobStore;
  readonly tenantActors: KeyedActorPort;
  readonly refDomainActors: KeyedActorPort;
}