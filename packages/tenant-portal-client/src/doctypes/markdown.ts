/**
 * Markdown 文档类型的 snapshot 与 location 形状。
 *
 * 临时的家：locationType `unidocs.markdown.text-range/v1` 在设计文档里已经出现，但
 * 代码里还没有归属包。假后端（本包）与 MarkdownView（tenant-portal-webui）都要用同
 * 一份形状，client 是两者的共同下游。将来 Markdown doctype 包落地后应迁走。
 */
import type { DocumentLocation } from "@unidocs/protocol-tenant-portal";
import type { DocumentContractIdx } from "../ids.js";

export const MarkdownDocumentType = "markdown";
export const MarkdownTextRangeLocationType = "unidocs.markdown.text-range/v1";

/** 与 doctype-markdown 的 MDoc 对齐：整篇内容就是一个字符串。 */
export interface MarkdownSnapshot {
  readonly content: string;
}

export interface MarkdownTextRangePayload {
  /** snapshot.content 上的 UTF-16 code unit 偏移，左闭右开。 */
  readonly start: number;
  readonly end: number;
  /** 基版上 [start, end) 处的原文，用于在别的版本上验证这段内容是否还在。 */
  readonly quote: string;
}

export type MarkdownRangeResolution =
  | { readonly located: true; readonly start: number; readonly end: number; readonly shifted: boolean }
  | { readonly located: false; readonly reason: "unsupported_type" | "unresolvable" };

export function createMarkdownTextRange(options: {
  documentContractIdx: DocumentContractIdx;
  content: string;
  start: number;
  end: number;
}): DocumentLocation {
  const { documentContractIdx, content, start, end } = options;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > content.length || start > end) {
    throw new RangeError(`invalid range [${start}, ${end}) for content of length ${content.length}`);
  }
  return {
    documentContractIdx,
    locationType: MarkdownTextRangeLocationType,
    payload: { start, end, quote: content.slice(start, end) },
  };
}

export function readMarkdownTextRange(location: DocumentLocation): MarkdownTextRangePayload | null {
  if (location.locationType !== MarkdownTextRangeLocationType) return null;
  const payload = location.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { start, end, quote } = payload as Record<string, unknown>;
  if (!Number.isInteger(start) || !Number.isInteger(end) || typeof quote !== "string") return null;
  return { start: start as number, end: end as number, quote };
}

export function resolveMarkdownTextRange(
  location: DocumentLocation,
  content: string,
): MarkdownRangeResolution {
  const range = readMarkdownTextRange(location);
  if (range === null) return { located: false, reason: "unsupported_type" };

  // Empty quote cannot be resolved; it would match everywhere and is ambiguous.
  if (range.quote.length === 0) return { located: false, reason: "unresolvable" };

  if (content.slice(range.start, range.start + range.quote.length) === range.quote) {
    return { located: true, start: range.start, end: range.start + range.quote.length, shifted: false };
  }

  // quote 可能出现多次，取起点最接近原偏移的那一处。
  let best = -1;
  for (let at = content.indexOf(range.quote); at !== -1; at = content.indexOf(range.quote, at + 1)) {
    if (best === -1 || Math.abs(at - range.start) < Math.abs(best - range.start)) best = at;
  }
  if (best === -1) return { located: false, reason: "unresolvable" };
  return { located: true, start: best, end: best + range.quote.length, shifted: true };
}
