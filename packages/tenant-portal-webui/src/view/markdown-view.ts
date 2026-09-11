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
import { errorText } from "../error-text.js";
import type { HostImplementation, ViewImplementation } from "./channel.js";
import type { MarkerRole, RoledMarker } from "./markers.js";

export interface MarkdownViewInstance extends ViewImplementation {
  /** 当前用户选区在 source 上的偏移；无选区时 null。Task 15 的「添加评论」用。 */
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
  // 浮动按钮/输入框用 absolute 定位，要相对这个容器，不是相对整个页面。
  if (container.style.position === "") container.style.position = "relative";
  let source = "";
  let host: HostImplementation | null = null;
  let documentContractIdx = 0;
  let currentVersionIdx = 0;

  // ---- 选区上方浮出的「添加评论」（§2.6、§3.1）--------------------------------
  //
  // 只有 View 能把选区读出来再编码成 DocumentLocation，所以这一整段——浮动按钮、
  // 内联输入框、失败后的重试——都活在这个模块里，不在 React 那一侧。jsdom 的
  // Selection 支持有限，这条路径没有自动化测试覆盖（Task 15 brief 明确说明）；
  // 手工验证记在提交信息和任务报告里。
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

  function openComposer(range: { start: number; end: number }, rect: DOMRect): void {
    removeFloating();

    const wrapper = document.createElement("div");
    wrapper.className = "selection-composer";
    positionNear(wrapper, rect);

    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "添加评论");
    wrapper.appendChild(textarea);

    const errorEl = document.createElement("p");
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;
    wrapper.appendChild(errorEl);

    const actions = document.createElement("div");
    actions.className = "selection-composer-actions";
    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.textContent = "发送";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "取消";
    actions.append(sendButton, cancelButton);
    wrapper.appendChild(actions);

    cancelButton.addEventListener("click", () => removeFloating());

    sendButton.addEventListener("click", () => {
      void (async () => {
        const text = textarea.value.trim();
        if (text === "" || host === null) return;

        const location = createMarkdownTextRange({
          documentContractIdx,
          content: source,
          start: range.start,
          end: range.end,
        });

        errorEl.hidden = true;
        sendButton.disabled = true;
        try {
          // 每次点「发送」都用同一个 host.createThread 调用；失败时文本原样留在
          // 输入框里，用户可以直接改「发送」为「重试」——见下面 catch 分支里
          // 文案没有清空 textarea。
          await host?.createThread({
            baseVersionIdx: currentVersionIdx,
            content: { text, richContent: null, attachments: [] },
            location,
          });
          removeFloating();
          window.getSelection()?.removeAllRanges();
        } catch (cause) {
          errorEl.hidden = false;
          errorEl.textContent = errorText(cause);
          sendButton.disabled = false;
          sendButton.textContent = "重试";
        }
      })();
    });

    container.appendChild(wrapper);
    floatingEl = wrapper;
    textarea.focus();
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
    button.addEventListener("click", () => openComposer(range, rect));

    container.appendChild(button);
    floatingEl = button;
  }

  if (commentable) {
    container.addEventListener("mouseup", () => {
      // 浮层自己被点击时也会经过这里；此时选区多半已经空了，交给上面各自的
      // click handler 处理，这里只负责「有新选区才出触发按钮」。
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
