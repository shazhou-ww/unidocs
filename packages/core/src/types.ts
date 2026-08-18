/** Agent tool definition for an operator's tool dispatch. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Cloud-neutral specification of a document type. */
export interface DocumentType<TDoc, TQuery, TOp> {
  /** Create a new empty document. */
  init: () => TDoc;

  /** Execute a read query against the document. Resolves to a JSON-serializable result. */
  query: (query: TQuery, doc: TDoc) => Promise<unknown>;

  /** Apply a single atomic operation. Returns the new document state. Throws on failure. */
  apply: (operation: TOp, doc: TDoc) => TDoc;

  /** Deserialize a document from binary bytes. */
  load: (data: Uint8Array) => TDoc;

  /** Serialize a document to binary bytes. */
  save: (doc: TDoc) => Uint8Array;

  /** Optional MIME type for document export. */
  contentType?: string;

  /** Agent tool definitions for the operator loop. */
  tools: Record<string, AgentToolDefinition>;

  /** Document-type-specific operator instructions. */
  instructions: string;
}

/** Factory for a configured cloud-neutral document type. */
export type DocumentTypeFactory<TOptions, TDoc, TQuery, TOp> =
  (options: TOptions) => DocumentType<TDoc, TQuery, TOp>;