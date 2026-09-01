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

export interface ByteStream extends AsyncIterable<Uint8Array> { }

export interface SBlobReadRange {
  readonly offset: number;
  readonly length?: number;
}

export interface SBlobHandler {
  readonly size: number;
  readonly contentType: string;

  /** Open a new sequential read for the whole blob or a logical byte range. */
  read(range?: SBlobReadRange): ByteStream;

  /** Materialize one explicitly bounded logical byte range. */
  readBytes(range: { readonly offset: number; readonly length: number }): Promise<Uint8Array>;
}

export type SBlobBytes = {
  readonly data: Uint8Array;
  readonly contentType: string;
};

/** @deprecated Use SBlobHandler for reads or SBlobBytes for bounded materialization. */
export type SBlobData = SBlobBytes;

export type SBlobSource =
  | SBlobBytes
  | {
    readonly body: ByteStream;
    readonly size?: number;
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
  (hash: string, loadData: () => Promise<SBlobSource>): Promise<SBlob>;
  (data: SBlobSource): Promise<SBlob>;
}

export interface DocumentTypeContext {
  readonly makeSBlob: MakeSBlob;
  /** Open a reusable, range-capable file handle. */
  readonly openSBlob: (blob: SBlob) => Promise<SBlobHandler>;
  /** @deprecated Migrate to openSBlob().read() or bounded readBytes(). */
  readonly readSBlob?: (blob: SBlob) => Promise<SBlobBytes>;
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

/**
 * effect 能碰到的全部外部世界。就是 AgentPlatform 去掉 apply ——
 * effect 跑在 Operator 里，它手上只有 AgentPlatform，没有
 * DocumentTypeContext（那是 Editor 的东西）。
 *
 * 没有 apply：落库是内核的事，effect 只负责把 ops 交出来。
 */
export interface EffectContext<TQuery> {
  readonly query: (query: SValueType<TQuery>) => Promise<{
    readonly data: SValue;
    readonly version: number;
  }>;
  readonly readBlob: (blob: SBlob) => Promise<SBlobBytes>;
  readonly writeBlob: (data: SBlobBytes) => Promise<SBlob>;
  readonly signal: AbortSignal;
}

export interface EffectOutcome<TOp> {
  /** 空数组 = 什么都不改。此时内核不调 apply，不产生 delta、不 bump 版本。 */
  readonly ops: readonly SValueType<TOp>[];
  /** 交给模型的东西。失败也走这里，不要抛 —— 失败是一次普通的工具返回。 */
  readonly result: AgentToolResult;
  /** 落进 delta 的说明。不给则用 `Agent: <工具名>`。 */
  readonly description?: string;
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
  }
  | {
    /**
     * 第三种工具形态，也是**唯一**被允许做 IO 的那一种。
     *
     * 存在的理由：query/op 都是同步纯函数，于是没有任何一条路径能产出
     * 模型自己造不出来的字节（像素）。effect 填的就是这个洞：它在 op 被
     * 创建**之前**完成 IO，把结果落进 CAS，再产出携带引用的普通 op ——
     * 所以 `apply` 仍然是纯函数，确定性重放不受影响（design.md:184）。
     */
    readonly kind: "effect";
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly run: (
      args: Readonly<Record<string, JsonValue>>,
      ctx: EffectContext<TQuery>,
    ) => Promise<EffectOutcome<TOp>>;
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

/**
 * `AgentPlatform.readBlob` 的错误分类契约，所以它和 AgentPlatform 放一起 ——
 * 平台实现者只看这一个文件就够了。平台用它表示"这个 blob 确实不存在"：
 * CAS 404，或者引用已被回收。
 *
 * 只有这一种失败会被内核降级成文字。授权失败（401/403）和传输失败一律往上抛，
 * 因为把它们伪装成"图没了"正是提交 63f997b 修掉的坑：一次跑长了的 run 会
 * 从某一刻起每张图静默变成一行文字，模型基于看不见的画面瞎猜，日志里一个
 * 错误都没有（spec 6.6.0）。
 */
export class BlobUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobUnavailableError";
  }
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
  /**
   * 模型为什么停下。Anthropic 的取值是 end_turn / max_tokens /
   * stop_sequence / tool_use / pause_turn / refusal，这里不收窄成联合类型：
   * 它只用于诊断（"既没 text 也没 tool_use"时告诉用户是哪种情况），服务端
   * 将来多一个取值不该让翻译层把它吞成 undefined。provider 没报就是 undefined。
   */
  readonly stopReason?: string;
}

export interface LlmProvider {
  complete(request: {
    readonly system: string;
    readonly messages: readonly LlmMessage[];
    readonly tools: readonly AgentToolDefinition[];
  }): Promise<AgentCompletion>;
}
