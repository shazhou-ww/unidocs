/**
 * 内存假后端：测试夹具（test fixture），不是产品功能。它实现的是 TenantApiContract
 * 的形状，供本包与 tenant-portal-webui 的测试驱动用；真正的后端实现是
 * packages/portal-service/src/tenant/。
 */
import type {
  AddressedComment,
  CommentRecord,
  DocumentLocation,
  DocumentRecord,
  MessageContent,
  PublicDocumentType,
  ReplyRecord,
  ThreadDetail,
  VersionRecord,
} from "@unidocs/protocol-tenant-portal";
import type { MarkdownSnapshot } from "../doctypes/markdown.js";
import { MarkdownDocumentType } from "../doctypes/markdown.js";
import type { CommentIdx, DocumentId, DocumentType, ThreadId, VersionIdx } from "../ids.js";

export interface SeedComment {
  readonly baseVersionIdx: VersionIdx;
  readonly text: string;
  readonly location: DocumentLocation | null;
  readonly authorId?: string;
}

export interface SeedReply {
  readonly respondThroughCommentIdx: CommentIdx;
  readonly text: string;
  /** 相对于该 reply 产生的新版本。空数组表示纯 reply（只回复，不产生新版本）。 */
  readonly resultLocations?: readonly DocumentLocation[];
  /** 该 reply 产生的新版本内容；省略表示纯 reply。 */
  readonly producesContent?: string;
}

export interface SeedThread {
  readonly threadId: ThreadId;
  readonly comments: readonly SeedComment[];
  readonly replies: readonly SeedReply[];
}

export interface SeedDocument {
  readonly documentId: DocumentId;
  readonly name: string;
  readonly documentType?: DocumentType;
  readonly versions: readonly { readonly content: string }[];
  readonly threads: readonly SeedThread[];
}

export interface MemorySeed {
  readonly documents: readonly SeedDocument[];
  /** listPublicDocumentTypes 的内容；省略时为空目录。 */
  readonly documentTypes?: readonly PublicDocumentType[];
}

interface ThreadState {
  comments: CommentRecord[];
  replies: ReplyRecord[];
}

interface DocumentState {
  documentId: DocumentId;
  name: string;
  documentType: DocumentType;
  createdAt: string;
  currentVersionIdx: VersionIdx | null;
  versions: VersionRecord[];
  /**
   * snapshot 已经从 VersionRecord 拆出去，是独立 operation
   * (GET .../versions/{versionIdx}/snapshot)。这里按 versionIdx 对齐存内容，
   * 供该 operation 单独读取。
   */
  snapshots: string[];
  threads: Map<ThreadId, ThreadState>;
}

export interface IdempotencyReceipt {
  readonly bodyFingerprint: string;
  readonly response: unknown;
}

export interface MemoryStoreState {
  readonly documents: ReadonlyMap<DocumentId, DocumentState>;
  readonly receipts: ReadonlyMap<string, IdempotencyReceipt>;
}

const EPOCH = Date.parse("2026-09-01T00:00:00.000Z");

/** 确定性时间戳：测试不依赖 wall clock。 */
function stamp(tick: number): string {
  return new Date(EPOCH + tick * 60_000).toISOString();
}

export class MemoryStore {
  readonly documents = new Map<DocumentId, DocumentState>();
  readonly receipts = new Map<string, IdempotencyReceipt>();
  readonly documentTypes: readonly PublicDocumentType[];
  private tick = 0;

  constructor(seed: MemorySeed = { documents: [] }) {
    this.documentTypes = seed.documentTypes ?? [];
    for (const doc of seed.documents) this.loadDocument(doc);
  }

  nextStamp(): string {
    return stamp(this.tick++);
  }

  get state(): MemoryStoreState {
    return { documents: this.documents, receipts: this.receipts };
  }

  private loadDocument(seed: SeedDocument): void {
    const state: DocumentState = {
      documentId: seed.documentId,
      name: seed.name,
      documentType: seed.documentType ?? MarkdownDocumentType,
      createdAt: this.nextStamp(),
      currentVersionIdx: null,
      versions: [],
      snapshots: [],
      threads: new Map(),
    };
    this.documents.set(seed.documentId, state);

    for (const version of seed.versions) this.appendVersion(state, version.content, "agent:seed");

    for (const thread of seed.threads) {
      const record: ThreadState = { comments: [], replies: [] };
      state.threads.set(thread.threadId, record);

      for (const comment of thread.comments) {
        record.comments.push({
          commentIdx: record.comments.length,
          baseVersionIdx: comment.baseVersionIdx,
          content: { text: comment.text, richContent: null, attachments: [] },
          location: comment.location,
          authorId: comment.authorId ?? "user:sample",
          createdAt: this.nextStamp(),
        });
      }

      for (const reply of thread.replies) {
        // SeedReply.producesContent 只供运行时 Agent 生成 reply 时使用；种子加载阶段的版本
        // 序列完全来自 SeedDocument.versions，这里不据此追加版本（否则会与显式声明的
        // versions 产生重复）。因此这些 reply 的 submissionId 不对应任何已创建的版本。
        record.replies.push({
          replyIdx: record.replies.length,
          respondThroughCommentIdx: reply.respondThroughCommentIdx,
          content: { text: reply.text, richContent: null, attachments: [] },
          resultLocations: reply.resultLocations ?? [],
          authorAgentId: "agent:sample",
          submissionId: `sub-${state.documentId}-${thread.threadId}-${record.replies.length}`,
          createdAt: this.nextStamp(),
        });
      }
    }
  }

  appendVersion(
    state: DocumentState,
    content: string,
    authorAgentId: string,
    options: {
      readonly submissionId?: string;
      readonly addressedComments?: readonly AddressedComment[];
    } = {},
  ): VersionRecord {
    const versionIdx = state.versions.length;
    const version: VersionRecord = {
      versionIdx,
      // "当前指针在提交时的观测值"：不一定是 versionIdx - 1。
      parentVersionIdx: state.currentVersionIdx,
      documentContractIdx: 0,
      authorAgentId,
      submissionId: options.submissionId ?? `sub-${state.documentId}-v${versionIdx}`,
      addressedComments: options.addressedComments ?? [],
      createdAt: this.nextStamp(),
    };
    state.versions.push(version);
    state.snapshots.push(content);
    state.currentVersionIdx = versionIdx;
    return version;
  }

  requireDocument(documentId: DocumentId): DocumentState {
    const state = this.documents.get(documentId);
    if (state === undefined) throw new NotFound(`document ${documentId}`);
    return state;
  }

  toRecord(state: DocumentState): DocumentRecord {
    return {
      documentId: state.documentId,
      name: state.name,
      documentType: state.documentType,
      currentVersionIdx: state.currentVersionIdx,
      createdAt: state.createdAt,
    };
  }

  listDocuments(documentType?: DocumentType): readonly DocumentRecord[] {
    return [...this.documents.values()]
      .filter((state) => documentType === undefined || state.documentType === documentType)
      .map((state) => this.toRecord(state));
  }

  getVersion(documentId: DocumentId, versionIdx: VersionIdx): VersionRecord {
    const version = this.requireDocument(documentId).versions[versionIdx];
    if (version === undefined) throw new NotFound(`version ${versionIdx}`);
    return version;
  }

  /** snapshot 是独立 operation：getVersion 只给元数据，这里单独给内容。 */
  getVersionSnapshot(documentId: DocumentId, versionIdx: VersionIdx): MarkdownSnapshot {
    this.getVersion(documentId, versionIdx); // 复用其 NotFound 语义
    const content = this.requireDocument(documentId).snapshots[versionIdx];
    return { content: content as string };
  }

  listVersions(documentId: DocumentId): readonly VersionRecord[] {
    return this.requireDocument(documentId).versions;
  }

  getThread(documentId: DocumentId, threadId: ThreadId): ThreadDetail {
    const record = this.requireDocument(documentId).threads.get(threadId);
    if (record === undefined) throw new NotFound(`thread ${threadId}`);
    return { threadId, comments: record.comments, replies: record.replies };
  }

  listThreadIds(documentId: DocumentId, open?: boolean): readonly ThreadId[] {
    const state = this.requireDocument(documentId);
    return [...state.threads.entries()]
      .filter(([, record]) => open === undefined || isOpen(record) === open)
      .map(([threadId]) => threadId);
  }

  /**
   * 同 key 同内容重放原结果；同 key 不同内容 409；没有 key 直接 400——这三个路由
   * (createDocument / createThread / appendComment) 在契约里都是 IdempotentMutationHeadersSchema,
   * 真实服务端由 oRPC 的 header 校验挡在门口;内存 transport 以前对缺 key 视而不见,
   * 掩盖了真实服务端必然拒绝的请求（终审 finding 2）。
   */
  withIdempotency<T>(scope: string, key: string | undefined, body: unknown, run: () => T): T {
    if (key === undefined) throw new InvalidRequest("idempotency-key is required");

    const receiptKey = `${scope}:${key}`;
    const fingerprint = JSON.stringify(body ?? null);
    const existing = this.receipts.get(receiptKey);
    if (existing !== undefined) {
      if (existing.bodyFingerprint !== fingerprint) {
        throw new Conflict("idempotency_conflict", `idempotency key ${key} reused with a different body`);
      }
      return existing.response as T;
    }

    const response = run();
    this.receipts.set(receiptKey, { bodyFingerprint: fingerprint, response });
    return response;
  }

  private nextDocumentId(name: string): DocumentId {
    let n = this.documents.size + 1;
    let candidate = `doc-${n}-${name.length}`;
    while (this.documents.has(candidate)) {
      n += 1;
      candidate = `doc-${n}-${name.length}`;
    }
    return candidate;
  }

  createDocument(name: string, documentType: DocumentType): DocumentRecord {
    if (name.trim() === "") throw new InvalidRequest("name must not be empty");
    const documentId = this.nextDocumentId(name);
    const state: DocumentState = {
      documentId,
      name,
      documentType,
      createdAt: this.nextStamp(),
      currentVersionIdx: null,
      versions: [],
      snapshots: [],
      threads: new Map(),
    };
    this.documents.set(documentId, state);
    return this.toRecord(state);
  }

  private requireVersion(state: DocumentState, versionIdx: VersionIdx): void {
    if (state.versions[versionIdx] === undefined) {
      throw new InvalidRequest(`baseVersionIdx ${versionIdx} does not exist`);
    }
  }

  private nextThreadId(state: DocumentState): ThreadId {
    let n = state.threads.size + 1;
    let candidate = `th-${n}`;
    while (state.threads.has(candidate)) {
      n += 1;
      candidate = `th-${n}`;
    }
    return candidate;
  }

  createThread(
    documentId: DocumentId,
    body: { baseVersionIdx: VersionIdx; content: MessageContent; location: DocumentLocation | null },
  ): ThreadDetail {
    const state = this.requireDocument(documentId);
    this.requireVersion(state, body.baseVersionIdx);

    const threadId = this.nextThreadId(state);
    const comment: CommentRecord = {
      commentIdx: 0,
      baseVersionIdx: body.baseVersionIdx,
      content: body.content,
      location: body.location,
      authorId: "user:sample",
      createdAt: this.nextStamp(),
    };
    state.threads.set(threadId, { comments: [comment], replies: [] });
    return { threadId, comments: [comment], replies: [] };
  }

  appendComment(
    documentId: DocumentId,
    threadId: ThreadId,
    body: { baseVersionIdx: VersionIdx; content: MessageContent; location: DocumentLocation | null },
  ): CommentRecord {
    const state = this.requireDocument(documentId);
    this.requireVersion(state, body.baseVersionIdx);

    const record = state.threads.get(threadId);
    if (record === undefined) throw new NotFound(`thread ${threadId}`);

    const comment: CommentRecord = {
      commentIdx: record.comments.length,
      baseVersionIdx: body.baseVersionIdx,
      content: body.content,
      location: body.location,
      authorId: "user:sample",
      createdAt: this.nextStamp(),
    };
    record.comments.push(comment);
    return comment;
  }

  moveCurrentVersion(
    documentId: DocumentId,
    body: { observedCurrentVersionIdx: VersionIdx | null; targetVersionIdx: VersionIdx },
  ): DocumentRecord {
    const state = this.requireDocument(documentId);
    if (state.currentVersionIdx !== body.observedCurrentVersionIdx) {
      throw new Conflict(
        "version_conflict",
        `current version is ${state.currentVersionIdx}, not ${body.observedCurrentVersionIdx}`,
      );
    }
    if (state.versions[body.targetVersionIdx] === undefined) {
      throw new InvalidRequest(`target version ${body.targetVersionIdx} does not exist`);
    }
    state.currentVersionIdx = body.targetVersionIdx;
    return this.toRecord(state);
  }
}

export function isOpen(record: { comments: readonly CommentRecord[]; replies: readonly ReplyRecord[] }): boolean {
  const acknowledged = record.replies.reduce((max, reply) => Math.max(max, reply.respondThroughCommentIdx), -1);
  const latest = record.comments.reduce((max, comment) => Math.max(max, comment.commentIdx), -1);
  return latest > acknowledged;
}

export class NotFound extends Error {}
export class InvalidRequest extends Error {}
export class Conflict extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function createMemoryStore(seed?: MemorySeed): MemoryStore {
  return new MemoryStore(seed);
}
