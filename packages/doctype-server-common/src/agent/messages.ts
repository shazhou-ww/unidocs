import { isSBlob } from "@unidocs/svalue-codec";
import type {
  AgentContentPart, AgentMessage, LlmContentPart, LlmMessage, SBlob, SBlobData,
} from "@unidocs/protocol";

/**
 * 平台用它表示"这个 blob 确实不存在"——CAS 404，或者引用已被回收。
 *
 * 只有这一种失败会被降级成文字。授权失败（401/403）和传输失败一律往上抛，
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

/** 按总字节数封顶的 hash → 字节缓存，淘汰最久未用的。 */
export class ByteLru {
  readonly #maxBytes: number;
  readonly #entries = new Map<string, Uint8Array>();
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get(hash: string): Uint8Array | undefined {
    const hit = this.#entries.get(hash);
    if (hit === undefined) return undefined;
    // Map 保持插入序，删了再插就是"移到最近使用"。
    this.#entries.delete(hash);
    this.#entries.set(hash, hit);
    return hit;
  }

  set(hash: string, bytes: Uint8Array): void {
    const existing = this.#entries.get(hash);
    if (existing !== undefined) {
      this.#entries.delete(hash);
      this.#bytes -= existing.byteLength;
    }
    this.#entries.set(hash, bytes);
    this.#bytes += bytes.byteLength;
    for (const [k, v] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) break;
      if (k === hash) continue;          // 刚放进来的不淘汰
      this.#entries.delete(k);
      this.#bytes -= v.byteLength;
    }
  }
}

function degrade(part: Extract<AgentContentPart, { type: "image" | "file" }>): LlmContentPart {
  // 内核只知道"这里原来有个附件，文档类型说它是这样"。那句话里写什么是
  // 文档类型的事（spec 6.2.3）。
  const label = part.type === "image"
    ? part.altText ?? part.mediaType
    : part.filename ?? part.mediaType;
  return { type: "text", text: `[${part.type}: ${label}]` };
}

async function materializePart(
  part: AgentContentPart,
  readBlob: (blob: SBlob) => Promise<SBlobData>,
  cache: ByteLru,
): Promise<LlmContentPart> {
  if (part.type === "text") return part;
  const hash = blobHash(part.blob);
  const cached = cache.get(hash);
  if (cached !== undefined) return withData(part, cached);
  let bytes: Uint8Array;
  try {
    bytes = (await readBlob(part.blob)).data;
  } catch (err) {
    // 只有"确实没了"才降级；其余（授权、传输）原样抛给上面结束这次 run。
    if (err instanceof BlobUnavailableError) return degrade(part);
    throw err;
  }
  cache.set(hash, bytes);
  return withData(part, bytes);
}

function withData(
  part: Extract<AgentContentPart, { type: "image" | "file" }>,
  data: Uint8Array,
): LlmContentPart {
  return part.type === "image"
    ? { type: "image", data, mediaType: part.mediaType, ...(part.altText === undefined ? {} : { altText: part.altText }) }
    : { type: "file", data, mediaType: part.mediaType, ...(part.filename === undefined ? {} : { filename: part.filename }) };
}

function blobHash(blob: SBlob): string {
  if (!isSBlob(blob)) throw new TypeError("content part blob is not an SBlob");
  return blob.hash;
}

/**
 * 把持久态历史变成模型输入。三个 role 一视同仁地扫 content —— 内核不区分
 * 图片来自 user、assistant 还是 tool（spec 5.4.2）。
 */
export async function materializeMessages(
  messages: readonly AgentMessage[],
  readBlob: (blob: SBlob) => Promise<SBlobData>,
  cache: ByteLru,
): Promise<readonly LlmMessage[]> {
  const out: LlmMessage[] = [];
  for (const m of messages) {
    const content = await Promise.all(m.content.map(p => materializePart(p, readBlob, cache)));
    if (m.role === "tool") {
      out.push({
        role: "tool",
        callId: m.callId,
        content,
        ...(m.structuredContent === undefined ? {} : { structuredContent: m.structuredContent }),
      });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content, ...(m.toolCalls === undefined ? {} : { toolCalls: m.toolCalls }) });
    } else {
      out.push({ role: "user", content });
    }
  }
  return out;
}
