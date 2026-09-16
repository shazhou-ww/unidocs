import type { CommentRecord, ReplyRecord } from "@unidocs/protocol-tenant-portal";
import type { VersionIdx } from "@unidocs/tenant-portal-client";
import type { Draft } from "../drafts/draft-store.js";
import type { ThreadState } from "../model/thread-state.js";
import { Composer } from "./composer.js";
import { DraftBlock } from "./draft-block.js";

export function CommentCard(props: {
  comment: CommentRecord;
  currentVersionIdx: VersionIdx | null;
  acknowledged: boolean;
  selected?: boolean;
  onSelect?(): void;
  onEdit?(): void;
}) {
  const behind = props.currentVersionIdx === null ? 0 : props.currentVersionIdx - props.comment.baseVersionIdx;

  return (
    <li className={`ping-card${props.selected === true ? " selected" : ""}`}>
      <button type="button" onClick={props.onSelect}>
        <p>{props.comment.content.text}</p>
        <footer>
          <span className="version-badge">v{props.comment.baseVersionIdx}</span>
          {behind > 0 && <span className="behind">基于 v{props.comment.baseVersionIdx} · 已过 {behind} 版</span>}
          {/* 徽标只从水位派生，从不落库；见 model/thread-state.ts 的 acknowledgedCommentIdx。 */}
          <span className="ping-status">{props.acknowledged ? "已处理" : "正在执行"}</span>
        </footer>
      </button>
      {/* 已发送的评论不可编辑也不可删除：只提供「修改」，它会压回一份新草稿（§2.7）。 */}
      <button type="button" className="ping-edit" onClick={props.onEdit}>修改</button>
    </li>
  );
}

export function ReplyCard(props: { reply: ReplyRecord }) {
  const plain = props.reply.resultLocations.length === 0;

  return (
    <li className={`pong-card ${plain ? "pong-plain" : "pong-versioned"}`}>
      <p>{props.reply.content.text}</p>
      <footer>{plain ? "Agent 已回复，未改动内容" : "Agent 已处理并提交了新版本"}</footer>
    </li>
  );
}

export function ThreadCard(props: {
  threadId: string;
  comments: readonly CommentRecord[];
  replies: readonly ReplyRecord[];
  state: ThreadState;
  currentVersionIdx: VersionIdx | null;
  selected: boolean;
  selectedCommentIdx?: number;
  onSelect(): void;
  onSelectComment?(commentIdx: number): void;
  /** 该处的草稿——回复中的那一份已经在别处（Composer）显示，这里已被上游排除。 */
  drafts: readonly Draft[];
  draftFailures: Readonly<Record<string, string>>;
  onSendDraft(draft: Draft): void;
  onDiscardDraft(draftId: string): void;
  onEditComment(comment: CommentRecord): void;
  composing: boolean;
  composingInitialText: string;
  onComposeOpen(): void;
  onComposeChange(text: string): void;
  onComposeSend(text: string): void;
  onComposeCancel(): void;
  /** 焦点离开整个回复区（而不是点了区内的按钮）时关闭输入框，但保留草稿——写到一半
      切去看别处不会丢（§2.7）。 */
  onComposeBlurAway(): void;
}) {
  const first = props.comments[0];

  return (
    <article className={`thread-card${props.selected ? " selected" : ""}`}>
      <button
        type="button"
        onClick={props.onSelect}
        aria-expanded={props.selected}
        aria-label={`${props.state.open ? "待回复" : "已回复"}的讨论 · ${props.selected ? "折叠" : "展开"}`}
      >
        <span className={props.state.open ? "status-open" : "status-answered"}>
          {props.state.open ? "待回复" : "已回复"}
        </span>
        {!props.selected && <span className="thread-excerpt">{first?.content.text}</span>}
      </button>

      {props.selected && (
        <ul className="thread-messages">
          {props.comments.map((comment) => (
            <CommentCard
              key={comment.commentIdx}
              comment={comment}
              currentVersionIdx={props.currentVersionIdx}
              acknowledged={props.state.acknowledgedCommentIdx >= comment.commentIdx}
              selected={(props.selectedCommentIdx ?? props.comments[props.comments.length - 1]?.commentIdx) === comment.commentIdx}
              onSelect={() => props.onSelectComment?.(comment.commentIdx)}
              onEdit={() => props.onEditComment(comment)}
            />
          ))}
          {props.replies.map((reply) => <ReplyCard key={reply.replyIdx} reply={reply} />)}
          {props.drafts.map((draft) => (
            <li key={draft.draftId}>
              <DraftBlock
                draft={draft}
                failure={props.draftFailures[draft.draftId] ?? null}
                onRetry={() => props.onSendDraft(draft)}
                onDiscard={() => props.onDiscardDraft(draft.draftId)}
              />
            </li>
          ))}
          <li
            className="thread-compose"
            onBlur={(event) => {
              // relatedTarget 仍在这个区域内（比如从输入框点到「发送」）不算离开；
              // 真正离开——点了区域外的任何东西——才收起输入框。
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                props.onComposeBlurAway();
              }
            }}
          >
            {props.composing
              ? (
                <Composer
                  label="回复这一处"
                  initialText={props.composingInitialText}
                  onChange={props.onComposeChange}
                  onSend={props.onComposeSend}
                  onCancel={props.onComposeCancel}
                />
              )
              : <button type="button" onClick={props.onComposeOpen}>回复</button>}
          </li>
        </ul>
      )}
      {!props.selected && props.drafts.length > 0 && <div className="collapsed-drafts">
        {props.drafts.map((draft) => <DraftBlock key={draft.draftId} draft={draft} failure={props.draftFailures[draft.draftId] ?? null} onRetry={() => props.onSendDraft(draft)} onDiscard={() => props.onDiscardDraft(draft.draftId)} />)}
      </div>}
    </article>
  );
}
