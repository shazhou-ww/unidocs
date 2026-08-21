/** Agent tool definition for an operator's tool dispatch. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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

}

/** Factory for a configured cloud-neutral document type. */
export type DocumentTypeFactory<
  TDoc,
  TQuery,
  TOp,
> = (context: DocumentTypeContext) => DocumentType<TDoc, TQuery, TOp>;