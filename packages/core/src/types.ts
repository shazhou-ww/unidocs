/** Agent tool definition for an operator's tool dispatch. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * How the operator routes this tool. `mode` selects the Editor endpoint
   * (query = read, apply = write); `kind` is the query kind or op kind sent
   * to it. When omitted, the operator falls back to the legacy `query_`/
   * `apply_` name-prefix convention.
   */
  op?: { mode: "query" | "apply"; kind: string };
}

/** Scalar value returned by a document query. */
export type QueryPrimitive = string | number | boolean | null | Uint8Array;

/** Recursively structured document query result. */
export type QueryValue =
  | QueryPrimitive
  | readonly QueryValue[]
  | { readonly [key: string]: QueryValue };

/** Content-addressed byte storage (CAS) for doctype-managed blobs (e.g. pixel data). */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | null>;
}

/** Context passed to a query for resolving lazy (PixelRef-backed) documents.
 *  Core carries ONLY the store — decoded-pixel caching is a doctype/render
 *  concern and must not leak its types back into core. */
export interface QueryCtx {
  store: BlobStore;
}

/** Cloud-neutral specification of a document type. */
export interface DocumentType<TDoc, TQuery, TOp> {
  /** Create a new empty document. */
  init: () => Promise<TDoc>;

  /** Execute a read query against the document. Binary values are encoded by
   *  the runtime. `ctx` is optional: resident documents (or existing 2-arg
   *  callers) render with no store; lazy documents need `ctx.store` to fault
   *  in PixelRef layers. */
  query: (query: TQuery, doc: TDoc, ctx?: QueryCtx) => Promise<QueryValue>;

  /** Apply an ordered operation batch atomically. Resolves to the new document state. */
  apply: (operations: readonly TOp[], doc: TDoc) => Promise<TDoc>;

  /** Deserialize a document from binary bytes. */
  load: (data: Uint8Array) => Promise<TDoc>;

  /** Serialize a document to binary bytes. */
  save: (doc: TDoc) => Promise<Uint8Array>;

  /** Serialize a document to a CAS-aware byte-free representation, offloading
   *  large binary payloads (e.g. pixel buffers) to `store`. */
  serialize?: (doc: TDoc, store: BlobStore) => Promise<Uint8Array>;

  /** Deserialize a document produced by `serialize`, resolving blobs via `store`. */
  deserialize?: (bytes: Uint8Array, store: BlobStore) => Promise<TDoc>;

  /** MIME type for document export. */
  contentType: string;

  /** Agent tool definitions for the operator loop. */
  tools: Record<string, AgentToolDefinition>;

  /** Document-type-specific operator instructions. */
  instructions: string;
}

/** Factory for a configured cloud-neutral document type. */
export type DocumentTypeFactory<TOptions, TDoc, TQuery, TOp> =
  (options: TOptions) => DocumentType<TDoc, TQuery, TOp>;