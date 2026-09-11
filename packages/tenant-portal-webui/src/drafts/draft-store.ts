/**
 * 未发送的评论是草稿：只在本地，Agent 看不到。每个位置一份、可以同时存多份，
 * 写到一半切去看别处不会丢（tenant-webui-v0.md §2.7）。
 */
import type { DocumentLocation, VersionIdx } from "@unidocs/protocol-platform";

const STORAGE_KEY = "unidocs.portal.drafts.v1";

export interface Draft {
  readonly draftId: string;
  readonly documentId: string;
  /** 同一锚点的草稿归为一组；见 anchorKeyOf。 */
  readonly anchorKey: string;
  /** 追加到已有一处时是 threadId；新评论时为 null。 */
  readonly threadId: string | null;
  readonly location: DocumentLocation | null;
  readonly baseVersionIdx: VersionIdx;
  readonly text: string;
  /** 创建时生成并持久化；发送失败重试时复用，真后端接上时幂等天然成立。 */
  readonly idempotencyKey: string;
  /** 「改自评论 N」：这份草稿改自哪一条已发送的评论。 */
  readonly editedFromPingIdx: number | null;
  readonly updatedAt: string;
}

export interface DraftStore {
  list(): readonly Draft[];
  listForDocument(documentId: string): readonly Draft[];
  countForDocument(documentId: string): number;
  save(draft: Draft): void;
  remove(draftId: string): void;
}

export function anchorKeyOf(input: { threadId: string | null; location: DocumentLocation | null }): string {
  if (input.threadId !== null) return `thread:${input.threadId}`;
  if (input.location === null) return "document";
  return `location:${input.location.locationType}:${JSON.stringify(input.location.payload)}`;
}

export function createDraftStore(storage: Storage): DraftStore {
  // storage 可能抛异常（无痕模式、站点存储被禁用）。草稿是用户写的字，
  // 存不进去也不能丢——退化为内存副本，本次会话内仍然可用。
  let cache: Draft[] = read();

  function read(): Draft[] {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Draft[]) : [];
    } catch {
      return [];
    }
  }

  function write(drafts: Draft[]): void {
    cache = drafts;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    } catch {
      // 只保留内存副本。
    }
  }

  return {
    list: () => cache,
    listForDocument: (documentId) => cache.filter((draft) => draft.documentId === documentId),
    countForDocument: (documentId) => cache.filter((draft) => draft.documentId === documentId).length,

    save(draft) {
      const existing = cache.find((candidate) => candidate.draftId === draft.draftId);
      const merged: Draft = existing === undefined
        ? draft
        : { ...draft, idempotencyKey: existing.idempotencyKey };
      write([...cache.filter((candidate) => candidate.draftId !== draft.draftId), merged]);
    },

    remove(draftId) {
      write(cache.filter((candidate) => candidate.draftId !== draftId));
    },
  };
}
