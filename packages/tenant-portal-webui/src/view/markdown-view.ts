/**
 * Markdown 的 View 实现。跑在同进程，但只通过 ViewImplementation 被调用——host 拿不到
 * 它的内部 DOM，换成 iframe 时这里整体搬进 bundle。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { readMarkdownTextRange, type MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import type {
  DocumentLocation,
  ViewFocusLocationResponse,
  ViewInitializeRequest,
  ViewInitializeResponse,
  ViewLoadSnapshotRequest,
  ViewLoadSnapshotResponse,
  ViewSetMarkersRequest,
  ViewSetViewportRequest,
  ViewSetViewportResponse,
} from "@unidocs/protocol-platform";
import type { ViewImplementation } from "./channel.js";
import type { MarkerRole, RoledMarker } from "./markers.js";

export interface MarkdownViewInstance extends ViewImplementation {
  /** 当前用户选区在 source 上的偏移；无选区时 null。Task 15 的「添加评论」用。 */
  selectionRange(): { start: number; end: number } | null;
}

function renderedText(container: HTMLElement): string {
  return container.textContent ?? "";
}

/** 在渲染后的 DOM 里按原文查找并包一层 <mark>。查不到返回 false。 */
function highlight(container: HTMLElement, quote: string, role: MarkerRole, threadId: string): boolean {
  if (quote === "") return false;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const at = text.indexOf(quote);
    if (at === -1) continue;

    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + quote.length);

    const mark = document.createElement("mark");
    mark.className = `marker marker-${role}`;
    mark.dataset.threadId = threadId;
    range.surroundContents(mark);
    return true;
  }
  return false;
}

function clearMarkers(container: HTMLElement): void {
  for (const mark of [...container.querySelectorAll("mark.marker")]) {
    mark.replaceWith(...mark.childNodes);
  }
  container.normalize();
}

export function createMarkdownView(options: { container: HTMLElement }): MarkdownViewInstance {
  const { container } = options;
  let source = "";

  return {
    async initialize(_request: ViewInitializeRequest): Promise<ViewInitializeResponse> {
      return { acceptedProtocol: "unidocs-view-host/v1" };
    },

    async loadSnapshot(request: ViewLoadSnapshotRequest): Promise<ViewLoadSnapshotResponse> {
      const snapshot = request.snapshot as unknown as MarkdownSnapshot | null;
      source = snapshot?.content ?? "";
      container.innerHTML = source === ""
        ? ""
        : DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
      return { renderedVersionIdx: request.context.viewVersion?.versionIdx ?? null };
    },

    async setViewport(request: ViewSetViewportRequest): Promise<ViewSetViewportResponse> {
      return { appliedRevision: request.revision };
    },

    async setMarkers(request: ViewSetMarkersRequest): Promise<void> {
      clearMarkers(container);
      for (const marker of request.markers as readonly RoledMarker[]) {
        const range = readMarkdownTextRange(marker.location);
        if (range === null) continue;
        highlight(container, range.quote, marker.role ?? "ping", marker.threadId);
      }
    },

    async focusLocation(location: DocumentLocation): Promise<ViewFocusLocationResponse> {
      const range = readMarkdownTextRange(location);
      if (range === null) return { located: false, reason: "unsupported_type" };

      const found = renderedText(container).includes(range.quote) && range.quote !== "";
      if (!found) return { located: false, reason: "unresolvable" };

      container.querySelector(`mark[data-thread-id]`)?.scrollIntoView?.({ block: "center" });
      return { located: true, reason: "located" };
    },

    async dispose(): Promise<void> {
      container.innerHTML = "";
      source = "";
    },

    selectionRange() {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
      if (!container.contains(selection.anchorNode)) return null;

      const quote = selection.toString();
      const at = source.indexOf(quote);
      if (at === -1) return null;
      return { start: at, end: at + quote.length };
    },
  };
}
