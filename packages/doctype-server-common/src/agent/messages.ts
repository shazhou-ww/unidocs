import { isSBlob } from "@unidocs/svalue-codec";
import { BlobUnavailableError } from "@unidocs/protocol";
import type {
  AgentContentPart, AgentMessage, LlmContentPart, LlmMessage, SBlob, SBlobData,
} from "@unidocs/protocol";

/**
 * 它是 AgentPlatform.readBlob 的错误分类契约，所以定义在 protocol 里挨着
 * AgentPlatform（平台实现者要 import 它才能履行契约）。这里再导出一次，
 * 让既有的 import 路径继续可用。
 */
export { BlobUnavailableError };

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
