/**
 * DocumentType — the ten-tuple contract for defining a document type.
 *
 * Given these types and functions, the SDK generates a deployable Editor + Operator DO pair.
 */

/** Agent tool definition for Operator's tool dispatch. */
export interface AgentToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: TInput; // Zod schema or JSON Schema
  outputSchema?: TOutput; // Optional, for documentation
}

/**
 * DocumentType — the complete specification of a document type.
 *
 * @typeParam TDoc   - Document's in-memory model
 * @typeParam TQuery - Query type (discriminated union)
 * @typeParam TOp    - Operation type (discriminated union)
 */
export interface DocumentType<TDoc, TQuery, TOp> {
  // === Types ===
  /** Document in-memory model type (for documentation/type hints). */
  readonly _docType?: TDoc;
  /** Query type (for documentation/type hints). */
  readonly _queryType?: TQuery;
  /** Operation type (for documentation/type hints). */
  readonly _opType?: TOp;

  // === Functions ===
  /** Create a new empty document. */
  init: () => TDoc;

  /** Execute a read query against the document. Returns JSON-serializable result. */
  query: (q: TQuery, doc: TDoc) => unknown;

  /** Apply a mutation operation. Returns the new document state. */
  apply: (op: TOp, doc: TDoc) => TDoc;

  /** Deserialize document from binary bytes (e.g. from DO storage). */
  load: (data: Uint8Array) => TDoc;

  /** Serialize document to binary bytes for persistence. */
  save: (doc: TDoc) => Uint8Array;

  // === Prompts & Tools ===
  /** Agent tool definitions for Operator's ReAct loop. */
  tools: Record<string, AgentToolDefinition>;

  /** System instructions for Operator (document-type-specific operational knowledge). */
  instructions: string;
}
