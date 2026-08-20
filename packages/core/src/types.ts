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

/** CAS reference from document state. */
export interface CasRef {
  readonly kind: "cas";
  readonly hash: string;
}

/** Reference counts: hash → positive integer count. */
export type CasReferences = Readonly<Record<string, number>>;

/** Read-only CAS access for document types. */
export interface CasReadContext {
  read(ref: CasRef): Promise<Uint8Array>;
  metadata(ref: CasRef): Promise<{ hash: string; size: number; contentType: string; refs: readonly string[] }>;
}

/** Context passed to document type lifecycle methods. */
export interface DocumentTypeContext {
  readonly cas: CasReadContext;
  readonly signal?: AbortSignal;
}

/** Cloud-neutral specification of a document type. */
export interface DocumentType<TDoc, TQuery, TOp> {
  /** Create a new empty document. */
  init: (context?: DocumentTypeContext) => Promise<TDoc>;

  /** Execute a read query against the document. Binary values are encoded by the runtime. */
  query: (query: TQuery, doc: TDoc, context?: DocumentTypeContext) => Promise<QueryValue>;

  /** Apply an ordered operation batch atomically. Resolves to the new document state. */
  apply: (operations: readonly TOp[], doc: TDoc, context?: DocumentTypeContext) => Promise<TDoc>;

  /** Deserialize a document from binary bytes. */
  load: (data: Uint8Array, context?: DocumentTypeContext) => Promise<TDoc>;

  /** Serialize a document to binary bytes. */
  save: (doc: TDoc, context?: DocumentTypeContext) => Promise<Uint8Array>;

  /** Extract CAS references from a snapshot (synchronous pure function). */
  refsFromSnapshot: (data: Uint8Array) => CasReferences;

  /** Extract CAS references from an operation (synchronous pure function). */
  refsFromOp: (operation: TOp) => CasReferences;

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