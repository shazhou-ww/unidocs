/**
 * Markdown 的 View 实现。跑在同进程，但只通过 ViewImplementation 被调用——host 拿不到
 * 它的内部 DOM，换成 iframe 时这里整体搬进 bundle。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMarkdownTextRange, readMarkdownTextRange, type MarkdownSnapshot } from "@unidocs/tenant-portal-client";
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
import type { HostImplementation, ViewImplementation } from "./channel.js";
import type { MarkerRole, RoledMarker } from "./markers.js";

export interface MarkdownViewInstance extends ViewImplementation {
  /** 当前用户选区在 source 上的偏移；无选区时 null。 */
  selectionRange(): { start: number; end: number } | null;
}

/** 源码中位于 start 之前的出现次数 —— 即锚点是第几处出现（0 起）。 */
function occurrenceOrdinal(source: string, quote: string, start: number): number {
  if (quote === "") return 0;
  let count = 0;
  for (let at = source.indexOf(quote); at !== -1 && at < start; at = source.indexOf(quote, at + 1)) {
    count += 1;
  }
  return count;
}

/**
 * 在渲染后的 DOM 里找第 ordinal 处出现（0 起）。
 * 渲染时有出现被符号吃掉的情况，序号可能超出范围，此时退到最后一处；
 * 一处都没有则返回 null（保持「找不到就跳过」的既定行为）。
 */
function findOccurrence(
  container: HTMLElement,
  quote: string,
  ordinal: number,
): { node: Text; at: number } | null {
  if (quote === "") return null;
  const hits: { node: Text; at: number }[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
      hits.push({ node: node as Text, at });
    }
  }
  if (hits.length === 0) return null;
  return hits[Math.min(ordinal, hits.length - 1)];
}

/** 在渲染后的 DOM 里按原文查找第 ordinal 处出现并包一层 <mark>。查不到返回 false。 */
function highlight(
  container: HTMLElement,
  quote: string,
  ordinal: number,
  role: MarkerRole,
  threadId: string,
): boolean {
  const hit = findOccurrence(container, quote, ordinal);
  if (hit === null) return false;

  const range = document.createRange();
  range.setStart(hit.node, hit.at);
  range.setEnd(hit.node, hit.at + quote.length);

  const mark = document.createElement("mark");
  mark.className = `marker marker-${role}`;
  mark.dataset.threadId = threadId;
  range.surroundContents(mark);
  return true;
}

function clearMarkers(container: HTMLElement): void {
  for (const mark of [...container.querySelectorAll("mark.marker")]) {
    mark.replaceWith(...mark.childNodes);
  }
  container.normalize();
}

export function createMarkdownView(
  options: { container: HTMLElement; commentable?: boolean },
): MarkdownViewInstance {
  const { container } = options;
  // 没有真实 host 的栏位（比如左栏「评论所基于的版本」那种历史版本对照）不装
  // 这个触发器——装了也必然发送失败，是一条死路，不是「支持给旧版本评论」。
  const commentable = options.commentable ?? true;
  // 浮动按钮用 absolute 定位，要相对这个容器，不是相对整个页面。
  if (container.style.position === "") container.style.position = "relative";
  let source = "";
  let host: HostImplementation | null = null;
  let documentContractIdx = 0;
  let currentVersionIdx = 0;

  // ---- 选区上方浮出的「添加评论」（§2.6、§3.1）--------------------------------
  //
  // 只有 View 能把选区读出来再编码成 DocumentLocation，所以浮动按钮活在这个模块里；
  // 点它只把位置交给 host.composeComment，输入框由 host 在讨论面板里打开——和「回复」
  // 是同一个输入框，发送、草稿、失败重试都走 host 那一条路径，View 不再自带一份。
  let floatingEl: HTMLElement | null = null;

  function removeFloating(): void {
    floatingEl?.remove();
    floatingEl = null;
  }

  function currentSelectionRange(): { start: number; end: number } | null {
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
    if (!container.contains(selection.anchorNode)) return null;

    const quote = selection.toString();
    const at = source.indexOf(quote);
    if (at === -1) return null;
    return { start: at, end: at + quote.length };
  }

  function anchorRect(): DOMRect | null {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) return null;
    try {
      // 真实浏览器里这一步不会失败；防御性地包一层是因为测试环境（jsdom）的
      // Range 实现并不完整，选区几何信息在那里可能直接抛错而不是退化返回 0。
      return selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      return null;
    }
  }

  function positionNear(element: HTMLElement, rect: DOMRect): void {
    const containerRect = container.getBoundingClientRect();
    element.style.position = "absolute";
    element.style.left = `${Math.max(0, rect.left - containerRect.left + container.scrollLeft)}px`;
    element.style.top = `${Math.max(0, rect.top - containerRect.top + container.scrollTop - 8)}px`;
  }

  function composeAt(range: { start: number; end: number }): void {
    removeFloating();
    window.getSelection()?.removeAllRanges();
    if (host === null) return;
    const location = createMarkdownTextRange({
      documentContractIdx,
      content: source,
      start: range.start,
      end: range.end,
    });
    host.composeComment({ baseVersionIdx: currentVersionIdx, location }).catch((cause: unknown) => {
      console.error("host.composeComment failed", cause);
    });
  }

  function showTrigger(range: { start: number; end: number }, rect: DOMRect): void {
    removeFloating();

    const button = document.createElement("button");
    button.type = "button";
    button.className = "add-comment-trigger";
    button.textContent = "添加评论";
    positionNear(button, rect);
    // 按下时不要抢焦点，否则选区会在 click 触发前先被清掉。
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => composeAt(range));

    container.appendChild(button);
    floatingEl = button;
  }

  if (commentable) {
    container.addEventListener("mouseup", (event) => {
      // 触发按钮挂在容器里，点它时 mouseup 也会冒泡到这里。此时绝不能重建或移除它：
      // 被按下的按钮一旦在 mouseup 里脱离文档，浏览器就不再派发 click——「添加评论」
      // 点了没反应。交给它自己的 click handler。
      if (floatingEl !== null && event.target instanceof Node && floatingEl.contains(event.target)) return;
      const range = currentSelectionRange();
      if (range === null) { removeFloating(); return; }
      const rect = anchorRect();
      if (rect === null) { removeFloating(); return; }
      showTrigger(range, rect);
    });
  }

  return {
    async initialize(_request: ViewInitializeRequest, hostImpl: HostImplementation): Promise<ViewInitializeResponse> {
      host = hostImpl;
      return { acceptedProtocol: "unidocs-view-host/v1" };
    },

    async loadSnapshot(request: ViewLoadSnapshotRequest, hostImpl: HostImplementation): Promise<ViewLoadSnapshotResponse> {
      host = hostImpl;
      documentContractIdx = request.context.viewVersion?.documentContractIdx ?? documentContractIdx;
      currentVersionIdx = request.context.viewVersion?.versionIdx ?? currentVersionIdx;

      removeFloating();
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
        const ordinal = occurrenceOrdinal(source, range.quote, range.start);
        highlight(container, range.quote, ordinal, marker.role ?? "ping", marker.threadId);
      }
    },

    async focusLocation(location: DocumentLocation): Promise<ViewFocusLocationResponse> {
      const range = readMarkdownTextRange(location);
      if (range === null) return { located: false, reason: "unsupported_type" };

      const ordinal = occurrenceOrdinal(source, range.quote, range.start);
      const hit = findOccurrence(container, range.quote, ordinal);
      if (hit === null) return { located: false, reason: "unresolvable" };

      hit.node.parentElement?.scrollIntoView?.({ block: "center" });
      return { located: true, reason: "located" };
    },

    async dispose(): Promise<void> {
      removeFloating();
      container.innerHTML = "";
      source = "";
    },

    selectionRange() {
      return currentSelectionRange();
    },
  };
}
