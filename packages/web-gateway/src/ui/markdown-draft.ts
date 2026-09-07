import type { OAuthTokenSession } from "./oauth.js";
import { creationTrackingScope } from "./creation-tracking.js";

export const MARKDOWN_DRAFT_PREFIX = "unidocs.markdown-draft.v1:";
export const MAX_MARKDOWN_DRAFT_LENGTH = 1_000_000;

export interface MarkdownDraft {
  content: string;
  baseContent: string;
  baseVersion: number;
}

export function markdownDraftKey(session: OAuthTokenSession, docType: string, docId: string): string | null {
  const scope = creationTrackingScope(session);
  if (!scope || !session.tenantId || !docType || !docId) return null;
  return MARKDOWN_DRAFT_PREFIX + JSON.stringify([scope, docType, docId]);
}

function requireKey(key: string | null): string {
  if (!key?.startsWith(MARKDOWN_DRAFT_PREFIX)) throw new Error("Draft identity unavailable");
  return key;
}

function validate(value: unknown): MarkdownDraft {
  if (!value || typeof value !== "object") throw new Error("Invalid draft record");
  const record = value as Partial<MarkdownDraft>;
  if (typeof record.content !== "string" || typeof record.baseContent !== "string"
    || !Number.isSafeInteger(record.baseVersion) || record.baseVersion! < 1) throw new Error("Invalid draft record");
  return { content: record.content, baseContent: record.baseContent, baseVersion: record.baseVersion! };
}

export function readMarkdownDraft(key: string | null, storage: Storage = sessionStorage): MarkdownDraft | null {
  const raw = storage.getItem(requireKey(key));
  if (raw === null) return null;
  if (raw.length > MAX_MARKDOWN_DRAFT_LENGTH) throw new Error("Draft exceeds storage limit");
  const record = JSON.parse(raw);
  if (record?.schema !== 1) throw new Error("Unsupported draft schema");
  return validate(record);
}

export function writeMarkdownDraft(key: string | null, draft: MarkdownDraft, storage: Storage = sessionStorage): void {
  const storageKey = requireKey(key);
  const raw = JSON.stringify({ schema: 1, ...validate(draft) });
  if (raw.length > MAX_MARKDOWN_DRAFT_LENGTH) throw new Error("Draft exceeds storage limit");
  storage.setItem(storageKey, raw);
}

export function removeMarkdownDraft(key: string | null, storage: Storage = sessionStorage): void {
  storage.removeItem(requireKey(key));
}

export function clearMarkdownDrafts(storage: Storage = sessionStorage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(MARKDOWN_DRAFT_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}