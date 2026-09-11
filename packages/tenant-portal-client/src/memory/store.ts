/**
 * 假后端的内存数据。它实现的是 contract，不是 UI 的 mock——webui 不该知道它存在。
 */
import type {
  DocumentId,
  DocumentLocation,
  DocumentRecord,
  DocumentType,
  PingRecord,
  PongRecord,
  ThreadDetail,
  ThreadId,
  VersionIdx,
  VersionRecord,
} from "@unidocs/protocol-platform";
import { MarkdownDocumentType } from "../doctypes/markdown.js";

export interface SeedPing {
  readonly baseVersionIdx: VersionIdx;
  readonly text: string;
  readonly location: DocumentLocation | null;
  readonly authorId?: string;
}

export interface SeedPong {
  readonly respondThroughPingIdx: number;
  readonly text: string;
  /** 相对于该 pong 产生的新版本。空数组表示纯 pong（只回复，不产生新版本）。 */
  readonly resultLocations?: readonly DocumentLocation[];
  /** 该 pong 产生的新版本内容；省略表示纯 pong。 */
  readonly producesContent?: string;
}

export interface SeedThread {
  readonly threadId: ThreadId;
  readonly pings: readonly SeedPing[];
  readonly pongs: readonly SeedPong[];
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
}

interface DocumentState {
  documentId: DocumentId;
  name: string;
  documentType: DocumentType;
  createdAt: string;
  currentVersionIdx: VersionIdx | null;
  versions: VersionRecord[];
  threads: Map<ThreadId, { pings: PingRecord[]; pongs: PongRecord[] }>;
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
  private tick = 0;

  constructor(seed: MemorySeed = { documents: [] }) {
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
      threads: new Map(),
    };
    this.documents.set(seed.documentId, state);

    for (const version of seed.versions) this.appendVersion(state, version.content, "agent:seed");

    for (const thread of seed.threads) {
      const record = { pings: [] as PingRecord[], pongs: [] as PongRecord[] };
      state.threads.set(thread.threadId, record);

      for (const ping of thread.pings) {
        record.pings.push({
          pingIdx: record.pings.length,
          baseVersionIdx: ping.baseVersionIdx,
          content: { text: ping.text, richContent: null, attachments: [] },
          location: ping.location,
          authorId: ping.authorId ?? "user:sample",
          createdAt: this.nextStamp(),
        });
      }

      for (const pong of thread.pongs) {
        // SeedPong.producesContent 只供运行时 Agent 生成 pong 时使用；种子加载阶段的版本
        // 序列完全来自 SeedDocument.versions，这里不据此追加版本（否则会与显式声明的
        // versions 产生重复）。
        record.pongs.push({
          pongIdx: record.pongs.length,
          respondThroughPingIdx: pong.respondThroughPingIdx,
          content: { text: pong.text, richContent: null, attachments: [] },
          resultLocations: pong.resultLocations ?? [],
          authorAgentId: "agent:sample",
          submissionId: `sub-${state.documentId}-${thread.threadId}-${record.pongs.length}`,
          createdAt: this.nextStamp(),
        });
      }
    }
  }

  appendVersion(state: DocumentState, content: string, authorAgentId: string): VersionRecord {
    const version: VersionRecord = {
      versionIdx: state.versions.length,
      parentVersionIdx: state.versions.length === 0 ? null : state.versions.length - 1,
      documentContractIdx: 0,
      snapshot: { content } as VersionRecord["snapshot"],
      authorAgentId,
      createdAt: this.nextStamp(),
    };
    state.versions.push(version);
    state.currentVersionIdx = version.versionIdx;
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

  listVersions(documentId: DocumentId): readonly VersionRecord[] {
    return this.requireDocument(documentId).versions;
  }

  getThread(documentId: DocumentId, threadId: ThreadId): ThreadDetail {
    const record = this.requireDocument(documentId).threads.get(threadId);
    if (record === undefined) throw new NotFound(`thread ${threadId}`);
    return { threadId, pings: record.pings, pongs: record.pongs };
  }

  listThreadIds(documentId: DocumentId, open?: boolean): readonly ThreadId[] {
    const state = this.requireDocument(documentId);
    return [...state.threads.entries()]
      .filter(([, record]) => open === undefined || isOpen(record) === open)
      .map(([threadId]) => threadId);
  }

  /** 同 key 同内容重放原结果；同 key 不同内容 409。 */
  withIdempotency<T>(scope: string, key: string | undefined, body: unknown, run: () => T): T {
    if (key === undefined) return run();

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

  createDocument(name: string, documentType: DocumentType): DocumentRecord {
    if (name.trim() === "") throw new InvalidRequest("name must not be empty");
    const documentId = `doc-${this.documents.size + 1}-${name.length}`;
    const state: DocumentState = {
      documentId,
      name,
      documentType,
      createdAt: this.nextStamp(),
      currentVersionIdx: null,
      versions: [],
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

  createThread(
    documentId: DocumentId,
    body: { baseVersionIdx: VersionIdx; content: PingRecord["content"]; location: DocumentLocation | null },
  ): ThreadDetail {
    const state = this.requireDocument(documentId);
    this.requireVersion(state, body.baseVersionIdx);

    const threadId = `th-${state.threads.size + 1}`;
    const ping: PingRecord = {
      pingIdx: 0,
      baseVersionIdx: body.baseVersionIdx,
      content: body.content,
      location: body.location,
      authorId: "user:sample",
      createdAt: this.nextStamp(),
    };
    state.threads.set(threadId, { pings: [ping], pongs: [] });
    return { threadId, pings: [ping], pongs: [] };
  }

  appendPing(
    documentId: DocumentId,
    threadId: ThreadId,
    body: { baseVersionIdx: VersionIdx; content: PingRecord["content"]; location: DocumentLocation | null },
  ): PingRecord {
    const state = this.requireDocument(documentId);
    this.requireVersion(state, body.baseVersionIdx);

    const record = state.threads.get(threadId);
    if (record === undefined) throw new NotFound(`thread ${threadId}`);

    const ping: PingRecord = {
      pingIdx: record.pings.length,
      baseVersionIdx: body.baseVersionIdx,
      content: body.content,
      location: body.location,
      authorId: "user:sample",
      createdAt: this.nextStamp(),
    };
    record.pings.push(ping);
    return ping;
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

export function isOpen(record: { pings: readonly PingRecord[]; pongs: readonly PongRecord[] }): boolean {
  const acknowledged = record.pongs.reduce((max, pong) => Math.max(max, pong.respondThroughPingIdx), -1);
  const latest = record.pings.reduce((max, ping) => Math.max(max, ping.pingIdx), -1);
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
