/** Agent tool definition for an operator's tool dispatch. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Scalar value returned by a document query. */
export type QueryPrimitive = string | number | boolean | null | Uint8Array;

/** Recursively structured document query result. */
export type QueryValue =
  | QueryPrimitive
  | readonly QueryValue[]
  | { readonly [key: string]: QueryValue };

/** Cloud-neutral specification of a document type. */
export interface DocumentType<TDoc, TQuery, TOp> {
  /** Create a new empty document. */
  init: () => Promise<TDoc>;

  /** Execute a read query against the document. Binary values are encoded by the runtime. */
  query: (query: TQuery, doc: TDoc) => Promise<QueryValue>;

  /** Apply an ordered operation batch atomically. Resolves to the new document state. */
  apply: (operations: readonly TOp[], doc: TDoc) => Promise<TDoc>;

  /** Deserialize a document from binary bytes. */
  load: (data: Uint8Array) => Promise<TDoc>;

  /** Serialize a document to binary bytes. */
  save: (doc: TDoc) => Promise<Uint8Array>;

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