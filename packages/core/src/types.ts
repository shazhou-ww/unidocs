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

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const sBlobSignature: unique symbol = Symbol("unidocs.sblob");
export const SValueContentType = "application/vnd.unidocs.svalue+cbor;version=1";

export interface SBlob {
  readonly [sBlobSignature]: true;
  readonly hash: string;
}

export type SBlobData = {
  readonly data: Uint8Array;
  readonly contentType: string;
};

/** Read-only CAS access for document types. */
export interface CasReadContext {
  read(ref: CasRef): Promise<Uint8Array>;
  metadata(ref: CasRef): Promise<{ hash: string; size: number; contentType: string; refs: readonly string[] }>;
  /**
   * Store content, returning its CAS hash. Present on the editor-side context
   * where writes are allowed.
   */
  store?(bytes: Uint8Array, contentType: string): Promise<string>;
}

export type SPrimitive = string | number | boolean | null | SBlob;
export type SValue =
  | SPrimitive
  | readonly SValue[]
  | { readonly [key: string]: SValue };

export type SValueShape<T> =
  T extends SPrimitive ? T
  : T extends (...args: never[]) => unknown ? never
  : T extends readonly unknown[] ? { readonly [K in keyof T]: SValueShape<T[K]> }
  : T extends object ? { readonly [K in keyof T]: SValueShape<T[K]> }
  : never;

/** Resolve to T only when every reachable field is representable as SValue. */
export type SValueType<T> = T extends SValueShape<T> ? T : never;

export interface MakeSBlob {
  (hash: string, loadData: () => Promise<SBlobData>): Promise<SBlob>;
  (data: SBlobData): Promise<SBlob>;
}

export interface DocumentTypeContext {
  readonly makeSBlob: MakeSBlob;
  readonly readSBlob: (blob: SBlob) => Promise<SBlobData>;
}

export type AgentContentPart =
  | {
    readonly type: "text";
    readonly text: string;
  }
  | {
    readonly type: "image";
    readonly blob: SBlob;
    readonly mediaType: string;
    readonly altText?: string;
  }
  | {
    readonly type: "file";
    readonly blob: SBlob;
    readonly mediaType: string;
    readonly filename?: string;
  };

export interface AgentToolResult {
  readonly structuredContent?: JsonValue;
  readonly content?: readonly AgentContentPart[];
}

export interface DocumentAgentContext<TQuery, TOp> {
  readonly query: (query: SValueType<TQuery>) => Promise<{
    readonly data: SValue;
    readonly version: number;
  }>;
  readonly apply: (
    operations: readonly SValueType<TOp>[],
    description: string,
  ) => Promise<{ readonly version: number }>;
  readonly resolveBlob: (hash: string) => Promise<SBlob>;
  readonly readBlob: (blob: SBlob) => Promise<SBlobData>;
}

export interface DocumentAgent {
  readonly tools: Readonly<Record<string, AgentToolDefinition>>;
  readonly instructions: string;
  readonly toolCall: (
    name: string,
    parameters: JsonValue,
  ) => Promise<AgentToolResult>;
}

export type DocumentAgentFactory<TQuery, TOp> = (
  context: DocumentAgentContext<TQuery, TOp>,
) => DocumentAgent;

export interface DocumentFormat<TDoc> {
  readonly mediaTypes: readonly string[];
  readonly extensions: readonly string[];
  readonly load: (data: Uint8Array) => Promise<SValueType<TDoc>>;
  readonly save: (doc: SValueType<TDoc>) => Promise<Uint8Array>;
}

/** Cloud-neutral specification of a document type. */
export interface DocumentType<TDoc, TQuery, TOp> {
  /** Create a new empty document. */
  init: () => Promise<SValueType<TDoc>>;

  /** Execute a read query against the document. Binary values are encoded by the runtime. */
  query: (query: SValueType<TQuery>, doc: SValueType<TDoc>) => Promise<SValue>;

  /** Apply an ordered operation batch atomically. Resolves to the new document state. */
  apply: (
    operations: readonly SValueType<TOp>[],
    doc: SValueType<TDoc>,
  ) => Promise<SValueType<TDoc>>;

  /** Supported external import/export formats. */
  formats: Readonly<Record<string, DocumentFormat<TDoc>>>;

  /** Format used when callers do not select one explicitly. */
  defaultFormat: string;

  /**
   * Materialize any lazy/external references into a self-contained document
   * (e.g. before export). Optional; doctypes without lazy state omit it.
   */
  resolve?: (doc: TDoc, context?: DocumentTypeContext) => Promise<TDoc>;

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
export type DocumentTypeFactory<
  TDoc,
  TQuery,
  TOp,
> = (context: DocumentTypeContext) => DocumentType<TDoc, TQuery, TOp>;