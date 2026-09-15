import { useState } from "react";
import type { CommentRecord } from "@unidocs/protocol-tenant-portal";
import type { VersionIdx } from "@unidocs/tenant-portal-client";
import { anchorKeyOf, type Draft } from "../drafts/draft-store.js";
import type { SummarizedThread } from "../model/discussion-summary.js";
import { DraftBlock } from "./draft-block.js";
import { ThreadCard } from "./thread-card.js";

export type ThreadFilter = "all" | "open" | "answered" | "unsent";

const FILTERS: readonly { value: ThreadFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "open", label: "待回复" },
  { value: "answered", label: "已回复" },
  { value: "unsent", label: "未发送" },
];

export function ThreadPanel(props: {
  threads: readonly SummarizedThread[];
  currentVersionIdx: VersionIdx | null;
  selectedThreadId?: string;
  selectedCommentIdx?: number;
  onSelect(threadId: string): void;
  onSelectComment?(commentIdx: number): void;
  /** 未发送的草稿：按锚点取——thread 内的草稿和回复中的那一份共用同一个来源（§2.7）。 */
  draftsForAnchor(anchorKey: string): readonly Draft[];
  draftCount: number;
  /**
   * threadId 为 null 的草稿——选区来的「添加评论」发送失败后留下的那种（问题 2）。
   * 它们没有对应的 thread 卡片可以挂靠，draftCount 仍然把它们计进去，所以必须单独
   * 渲染成卡片，不然用户点不到、也丢弃不了自己写的字。
   */
  orphanedDrafts: readonly Draft[];
  composingThreadId: string | null;
  composeDraftId: string | null;
  composingInitialText: string;
  draftFailures: Readonly<Record<string, string>>;
  onComposeOpen(threadId: string): void;
  onComposeChange(threadId: string, text: string): void;
  onComposeSend(threadId: string, text: string): void;
  onComposeCancel(): void;
  onComposeBlurAway(): void;
  onSendDraft(draft: Draft): void;
  onDiscardDraft(draftId: string): void;
  onEditFromComment(threadId: string, comment: CommentRecord): void;
}) {
  const [filter, setFilter] = useState<ThreadFilter>("all");

  const visible = props.threads.filter(({ detail, state }) => {
    if (filter === "unsent") {
      return props.draftsForAnchor(anchorKeyOf({ threadId: detail.threadId, location: null })).length > 0;
    }
    return filter === "all" || (filter === "open" ? state.open : !state.open);
  });
  const visibleOrphans = filter === "all" || filter === "unsent" ? props.orphanedDrafts : [];

  return (
    <aside className="review-panel open thread-panel" role="complementary" aria-label="讨论">
      <div className="review-heading">
        <div className="row spread"><h2>讨论与批注</h2></div>
        <nav className="thread-filter">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
        </nav>
      </div>

      <div className="review-body">

      {props.draftCount > 0 && <p className="draft-count">{props.draftCount} 条未发送</p>}

      {visibleOrphans.length > 0 && (
        <ul className="orphaned-drafts">
          {visibleOrphans.map((draft) => (
            <li key={draft.draftId}>
              <DraftBlock
                draft={draft}
                failure={props.draftFailures[draft.draftId] ?? null}
                onRetry={() => props.onSendDraft(draft)}
                onDiscard={() => props.onDiscardDraft(draft.draftId)}
              />
            </li>
          ))}
        </ul>
      )}

      {visible.length === 0 && visibleOrphans.length === 0 && (
        <p className="muted">
          {props.currentVersionIdx === null
            // 首版本产生前不能评论（§5.4）——不邀请一个注定失败的操作。
            ? "这件作品还没有版本，暂时不能评论。"
            : filter === "unsent" ? "没有未发送的评论。"
              : filter === "open" ? "没有待回复的讨论。"
                : filter === "answered" ? "还没有已回复的讨论。"
                  : "暂无讨论。"}
        </p>
      )}

      {visible.map(({ detail, state }) => {
        const anchorKey = anchorKeyOf({ threadId: detail.threadId, location: null });
        const composing = props.composingThreadId === detail.threadId;
        // 正在这份 Composer 里编辑的那份草稿已经在输入框里显示了，
        // 这里的草稿块不重复渲染它，否则「发送」按钮会出现两次。
        const cardDrafts = props.draftsForAnchor(anchorKey)
          .filter((draft) => !(composing && draft.draftId === props.composeDraftId));

        return (
          <ThreadCard
            key={detail.threadId}
            threadId={detail.threadId}
            comments={detail.comments}
            replies={detail.replies}
            state={state}
            currentVersionIdx={props.currentVersionIdx}
            selected={props.selectedThreadId === detail.threadId}
            selectedCommentIdx={props.selectedCommentIdx}
            onSelect={() => props.onSelect(detail.threadId)}
            onSelectComment={props.onSelectComment}
            drafts={cardDrafts}
            draftFailures={props.draftFailures}
            onSendDraft={props.onSendDraft}
            onDiscardDraft={props.onDiscardDraft}
            onEditComment={(comment) => props.onEditFromComment(detail.threadId, comment)}
            composing={composing}
            composingInitialText={composing ? props.composingInitialText : ""}
            onComposeOpen={() => props.onComposeOpen(detail.threadId)}
            onComposeChange={(text) => props.onComposeChange(detail.threadId, text)}
            onComposeSend={(text) => props.onComposeSend(detail.threadId, text)}
            onComposeCancel={props.onComposeCancel}
            onComposeBlurAway={props.onComposeBlurAway}
          />
        );
      })}
      </div>
    </aside>
  );
}
