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

  /** MIME type for document export. */
  contentType: string;
}

/** Factory for a configured cloud-neutral document type. */
export type DocumentTypeFactory<
  TDoc,
  TQuery,
  TOp,
> = (context: DocumentTypeContext) => DocumentType<TDoc, TQuery, TOp>;
/** CBOR tag for SBlob refs in encoded SValue payloads. */
export const SBlobTag = 65_536;

export interface SValueCodecLimits {
  readonly maxArrayLength: number;
  readonly maxByteStringBytes: number;
  readonly maxDepth: number;
  readonly maxEncodedBytes: number;
  readonly maxMapEntries: number;
  readonly maxRefs: number;
  readonly maxStringBytes: number;
  readonly maxValues: number;
}

export interface SValueCodecOptions {
  readonly limits?: Partial<SValueCodecLimits>;
}

export interface EncodedSValue {
  readonly data: Uint8Array;
  readonly refs: readonly string[];
}

export interface DecodedSValue {
  readonly value: SValue;
  readonly refs: readonly string[];
}

export type AgentTool<TQuery, TOp> =
  | {
    readonly kind: "query";
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    /** 纯函数：模型给的参数 → 一个 query。不得有 IO、不得读全局状态。 */
    readonly toQuery: (args: Readonly<Record<string, JsonValue>>) => SValueType<TQuery>;
    /**
     * 纯函数：query 结果 → 交给模型的东西。
     * 不给则用 defaultQueryToolResult（签名与本字段完全一致）。
     * 要返回图片/文件的工具**必须**给，且必须产出 image/file content part。
     */
    readonly toResult?: (data: SValue, version: number) => AgentToolResult;
  }
  | {
    readonly kind: "op";
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    /** 纯函数：模型给的参数 → 一批 op。 */
    readonly toOps: (args: Readonly<Record<string, JsonValue>>) => readonly SValueType<TOp>[];
  };

export interface DocumentAgent<TQuery, TOp> {
  readonly tools: readonly AgentTool<TQuery, TOp>[];
  readonly instructions: string;
}

/**
 * 平台提供的"怎么做到"。**文档类型看不到它**，只有内核调。
 * apply 的 baseVersion 由实现自己读当前 head —— agent 不管版本（spec 5.2）。
 */
export interface AgentPlatform<TQuery, TOp> {
  readonly query: (query: SValueType<TQuery>) => Promise<{
    readonly data: SValue;
    readonly version: number;
  }>;
  readonly apply: (
    operations: readonly SValueType<TOp>[],
    description: string,
  ) => Promise<{ readonly version: number }>;
  readonly readBlob: (blob: SBlob) => Promise<SBlobData>;
  readonly writeBlob: (data: SBlobData) => Promise<SBlob>;
}

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonValue;
}

/** 落盘、裁剪、算引用都用它。附件是 SBlob 引用，不是字节。 */
export type AgentMessage =
  | { readonly role: "user"; readonly content: readonly AgentContentPart[] }
  | {
    readonly role: "assistant";
    readonly content: readonly AgentContentPart[];
    readonly toolCalls?: readonly AgentToolCall[];
  }
  | {
    readonly role: "tool";
    readonly callId: string;
    readonly content: readonly AgentContentPart[];
    readonly structuredContent?: JsonValue;
  };

/** 附件已物化成字节。只在"即将发给 provider"这一刻存在，不落盘。 */
export type LlmContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: Uint8Array; readonly mediaType: string; readonly altText?: string }
  | { readonly type: "file"; readonly data: Uint8Array; readonly mediaType: string; readonly filename?: string };

export type LlmMessage =
  | { readonly role: "user"; readonly content: readonly LlmContentPart[] }
  | { readonly role: "assistant"; readonly content: readonly LlmContentPart[]; readonly toolCalls?: readonly AgentToolCall[] }
  | { readonly role: "tool"; readonly callId: string; readonly content: readonly LlmContentPart[]; readonly structuredContent?: JsonValue };

export interface AgentCompletion {
  readonly content: readonly LlmContentPart[];
  readonly toolCalls?: readonly AgentToolCall[];
}

export interface LlmProvider {
  complete(request: {
    readonly system: string;
    readonly messages: readonly LlmMessage[];
    readonly tools: readonly AgentToolDefinition[];
  }): Promise<AgentCompletion>;
}
