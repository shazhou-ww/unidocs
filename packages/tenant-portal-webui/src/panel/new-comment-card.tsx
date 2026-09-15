import type { DocumentLocation } from "@unidocs/protocol-tenant-portal";
import { readMarkdownTextRange } from "@unidocs/tenant-portal-client";
import { Composer } from "./composer.js";

/**
 * 选区「添加评论」在讨论面板里打开的那一张卡：还没有对应的一处，所以不挂在任何
 * ThreadCard 下面。输入框就是「回复」用的同一个 Composer（§2.6：两个入口，一种输入框）。
 */
export function NewCommentCard(props: {
  location: DocumentLocation;
  baseVersionIdx: number;
  initialText: string;
  onChange(text: string): void;
  onSend(text: string): void;
  onCancel(): void;
  /** 焦点离开整张卡时收起，但保留已写的草稿——同 ThreadCard 的回复区。 */
  onBlurAway(): void;
}) {
  const quote = readMarkdownTextRange(props.location)?.quote ?? null;

  return (
    <section
      role="group"
      aria-label="新的一处"
      className="thread-card selected new-comment-card"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onBlurAway();
      }}
    >
      <header className="new-comment-heading">
        <span className="status-open">新的一处</span>
        <span className="version-badge">基于 v{props.baseVersionIdx}</span>
      </header>
      {quote !== null && <blockquote className="new-comment-quote">{quote}</blockquote>}
      <Composer
        label="添加评论"
        initialText={props.initialText}
        onChange={props.onChange}
        onSend={props.onSend}
        onCancel={props.onCancel}
      />
    </section>
  );
}
